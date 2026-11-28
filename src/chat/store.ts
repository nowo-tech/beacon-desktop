/**
 * Chat data of the current context, **in memory only** (Q-BD-15): nothing here is written to disk, and `clear()` runs
 * on a context switch, "Disconnect chat" and sign-out. Bounded so a long session stays within the memory budget:
 * at most {@link MAX_MESSAGES} messages per conversation and {@link MAX_CACHED} conversations with messages loaded.
 */
import type { Conversation, ConversationsPage, Message, MessagesPage, Reaction, ThreadPage } from './types';

export const MAX_MESSAGES = 600;
export const MAX_CACHED = 12;

export interface Timeline {
  messages: Message[];
  /** Older messages exist on the server. */
  hasMore: boolean;
  readUpTo: number | null;
}

export type SectionId = 'channels' | 'projects' | 'dms' | 'support';

export interface Section {
  id: SectionId;
  conversations: Conversation[];
}

/** Project channels have their own section (owner decision 2026-11-25, Q3); Beacon keys them `project:<uuid>`. */
export function sectionOf(conversation: Conversation): SectionId {
  if (conversation.kind === 'direct') return 'dms';
  if (conversation.kind === 'support') return 'support';
  return conversation.channelKey?.startsWith('project:') ? 'projects' : 'channels';
}

/** Muted now (a `mutedUntil` in the future, or a value that does not parse: treated as muted). */
export function isMuted(conversation: Conversation, now: number): boolean {
  if (conversation.mutedUntil === null) return false;
  const until = Date.parse(conversation.mutedUntil);
  return Number.isNaN(until) || until > now;
}

/** Merges two id-ordered lists (newer copies win), oldest first. */
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map<number, Message>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export class ChatStore {
  /** Server order (newest activity first). */
  private order: string[] = [];
  /** Rows of the last first page (the head of `order`). */
  private headSize = 0;
  private readonly rows = new Map<string, Conversation>();
  private readonly timelines = new Map<string, Timeline>();
  private readonly threads = new Map<string, ThreadPage>();
  nextCursor: string | null = null;
  unreadTotal: number | null = null;
  unreadTotalCapped = false;
  /** The first page arrived. */
  loaded = false;

  clear(): void {
    this.order = [];
    this.headSize = 0;
    this.rows.clear();
    this.timelines.clear();
    this.threads.clear();
    this.nextCursor = null;
    this.unreadTotal = null;
    this.unreadTotalCapped = false;
    this.loaded = false;
  }

  /**
   * A first page replaces the head of the list (rows that left it are gone: archived, moved out of the context);
   * rows of later pages that are not in it stay. Later pages (`append`) extend the list.
   */
  applyPage(page: ConversationsPage, append: boolean): void {
    const incoming = page.conversations.map((row) => row.uuid);
    if (!append) {
      const head = new Set(this.order.slice(0, this.headSize));
      const seen = new Set(incoming);
      const tail = this.order.filter((uuid) => !head.has(uuid) && !seen.has(uuid));
      this.order = [...incoming, ...tail];
      this.headSize = incoming.length;
      this.unreadTotal = page.unreadTotal;
      this.unreadTotalCapped = page.unreadTotalCapped;
      if (!this.loaded || tail.length === 0) this.nextCursor = page.nextCursor;
      this.loaded = true;
    } else {
      for (const uuid of incoming) if (!this.order.includes(uuid)) this.order.push(uuid);
      this.nextCursor = page.nextCursor;
    }
    for (const row of page.conversations) this.rows.set(row.uuid, { ...this.rows.get(row.uuid), ...row });
    const listed = new Set(this.order);
    for (const uuid of [...this.rows.keys()]) if (!listed.has(uuid)) this.rows.delete(uuid);
  }

  upsert(row: Conversation): void {
    if (!this.order.includes(row.uuid)) this.order.unshift(row.uuid);
    this.rows.set(row.uuid, { ...this.rows.get(row.uuid), ...row });
  }

  conversation(uuid: string | null): Conversation | null {
    return uuid === null ? null : (this.rows.get(uuid) ?? null);
  }

  conversations(): Conversation[] {
    return this.order.map((uuid) => this.rows.get(uuid)).filter((row): row is Conversation => row !== undefined && !row.archived);
  }

  sections(): Section[] {
    const ids: SectionId[] = ['channels', 'projects', 'dms', 'support'];
    const rows = this.conversations();
    return ids.map((id) => ({ id, conversations: rows.filter((row) => sectionOf(row) === id) })).filter((section) => section.conversations.length > 0);
  }

  /** Unread count for the badge: the server's `unreadTotal` (muted excluded), else the sum of unmuted rows. */
  badgeCount(now: number): number {
    if (this.unreadTotal !== null) return this.unreadTotal;
    return this.conversations()
      .filter((row) => !isMuted(row, now))
      .reduce((sum, row) => sum + row.unread, 0);
  }

  /** Clears a row's unread count locally after a read mark (the next list fetch confirms it). */
  markRead(uuid: string): void {
    const row = this.rows.get(uuid);
    if (row === undefined || row.unread === 0) return;
    if (this.unreadTotal !== null && !isMuted(row, Date.now())) this.unreadTotal = Math.max(0, this.unreadTotal - row.unread);
    this.rows.set(uuid, { ...row, unread: 0 });
  }

  timeline(uuid: string | null): Timeline | null {
    return uuid === null ? null : (this.timelines.get(uuid) ?? null);
  }

  /**
   * A messages page: `newest` (no cursor) replaces the window when it does not overlap what is loaded; `older` adds
   * at the top (and its `hasMore`); `newer` (catch-up) adds at the bottom.
   */
  applyMessages(uuid: string, page: MessagesPage, kind: 'newest' | 'older' | 'newer'): void {
    const current = this.timelines.get(uuid);
    let messages: Message[];
    let hasMore: boolean;
    if (current === undefined || (kind === 'newest' && !overlaps(current.messages, page.messages))) {
      messages = page.messages;
      hasMore = page.hasMore;
    } else {
      messages = mergeMessages(current.messages, page.messages);
      hasMore = kind === 'older' ? page.hasMore : current.hasMore;
    }
    // Bounded: drop the oldest beyond the cap (they can be loaded again by scrolling up).
    if (messages.length > MAX_MESSAGES) {
      messages = messages.slice(messages.length - MAX_MESSAGES);
      hasMore = true;
    }
    this.timelines.delete(uuid);
    this.timelines.set(uuid, { messages, hasMore, readUpTo: page.readUpTo ?? current?.readUpTo ?? null });
    while (this.timelines.size > MAX_CACHED) {
      const oldest = this.timelines.keys().next().value as string;
      this.timelines.delete(oldest);
    }
  }

  /** One message refreshed after a hint (edited, reacted, deleted); ignored when its conversation is not loaded. */
  applyMessage(uuid: string, message: Message): void {
    const current = this.timelines.get(uuid);
    if (current === undefined) return;
    this.timelines.set(uuid, { ...current, messages: mergeMessages(current.messages, [message]) });
    for (const [root, thread] of this.threads) {
      if (thread.root.uuid === message.uuid) this.threads.set(root, { ...thread, root: message });
      else if (thread.replies.some((reply) => reply.uuid === message.uuid)) this.threads.set(root, { ...thread, replies: mergeMessages(thread.replies, [message]) });
    }
  }

  /** A message of `uuid` as loaded (timeline, thread root or reply), or `null`. */
  findMessage(uuid: string, messageUuid: string): Message | null {
    const inTimeline = this.timelines.get(uuid)?.messages.find((message) => message.uuid === messageUuid);
    if (inTimeline !== undefined) return inTimeline;
    for (const thread of this.threads.values()) {
      if (thread.root.uuid === messageUuid) return thread.root;
      const reply = thread.replies.find((message) => message.uuid === messageUuid);
      if (reply !== undefined) return reply;
    }
    return null;
  }

  /**
   * Replaces a loaded message's reactions (a reaction write's answer, or its optimistic change) wherever it is shown:
   * the timeline, a thread root or a thread reply. Never adds a message (a reply never lands in the timeline).
   */
  setReactions(uuid: string, messageUuid: string, reactions: Reaction[]): void {
    const change = (message: Message): Message => (message.uuid === messageUuid ? { ...message, reactions } : message);
    const timeline = this.timelines.get(uuid);
    if (timeline?.messages.some((message) => message.uuid === messageUuid) === true) this.timelines.set(uuid, { ...timeline, messages: timeline.messages.map(change) });
    for (const [root, thread] of this.threads) {
      if (thread.root.uuid === messageUuid || thread.replies.some((reply) => reply.uuid === messageUuid)) this.threads.set(root, { ...thread, root: change(thread.root), replies: thread.replies.map(change) });
    }
  }

  /** A message is in the loaded timeline (`root` null) or in the open thread of `root`. */
  has(uuid: string, messageUuid: string, root: string | null): boolean {
    if (root === null) return this.timelines.get(uuid)?.messages.some((message) => message.uuid === messageUuid) === true;
    return this.threads.get(root)?.replies.some((message) => message.uuid === messageUuid) === true;
  }

  /** The updated root of a thread reply: replaces it where it is loaded (its reply count), never adds it. */
  replaceMessage(uuid: string, message: Message): void {
    const timeline = this.timelines.get(uuid);
    if (timeline?.messages.some((item) => item.uuid === message.uuid) === true) this.timelines.set(uuid, { ...timeline, messages: timeline.messages.map((item) => (item.uuid === message.uuid ? message : item)) });
    const thread = this.threads.get(message.uuid);
    if (thread !== undefined) this.threads.set(message.uuid, { ...thread, root: message, replyCount: Math.max(thread.replyCount, message.thread?.count ?? 0) });
  }

  setReadUpTo(uuid: string, readUpTo: number | null): void {
    const current = this.timelines.get(uuid);
    if (current !== undefined && readUpTo !== null && (current.readUpTo === null || readUpTo > current.readUpTo)) this.timelines.set(uuid, { ...current, readUpTo });
  }

  thread(root: string | null): ThreadPage | null {
    return root === null ? null : (this.threads.get(root) ?? null);
  }

  applyThread(root: string, page: ThreadPage, kind: 'newest' | 'older' | 'newer'): void {
    const current = this.threads.get(root);
    if (current === undefined || kind === 'newest') {
      this.threads.set(root, page);
    } else {
      this.threads.set(root, {
        root: page.root,
        replies: mergeMessages(current.replies, page.replies),
        hasMore: kind === 'older' ? page.hasMore : current.hasMore,
        replyCount: page.replyCount,
      });
    }
    // Only the open thread is worth keeping.
    for (const key of [...this.threads.keys()]) if (key !== root) this.threads.delete(key);
  }

  /**
   * Recent messages that mention the reader (chat home view, UX batch 5), newest first: from the timelines loaded in
   * this session only (memory, at most {@link MAX_CACHED} conversations); never the reader's own or deleted ones.
   * `unread`: after the conversation's read cursor.
   */
  mentions(limit = 5): { conversation: Conversation; message: Message; unread: boolean }[] {
    const found: { conversation: Conversation; message: Message; unread: boolean }[] = [];
    for (const [uuid, timeline] of this.timelines) {
      const conversation = this.rows.get(uuid);
      if (conversation === undefined) continue;
      for (const message of timeline.messages) {
        if (!message.mentionsMe || message.mine || message.deleted || message.blocks === null) continue;
        found.push({ conversation, message, unread: timeline.readUpTo !== null ? message.id > timeline.readUpTo : conversation.unread > 0 });
      }
    }
    return found.sort((a, b) => (a.message.createdAt < b.message.createdAt ? 1 : a.message.createdAt > b.message.createdAt ? -1 : b.message.id - a.message.id)).slice(0, limit);
  }

  dropThreads(): void {
    this.threads.clear();
  }
}

/** The newest page joins what is loaded (no gap between the loaded window and it). */
function overlaps(current: Message[], incoming: Message[]): boolean {
  if (current.length === 0 || incoming.length === 0) return true;
  return incoming[0].id <= current[current.length - 1].id;
}
