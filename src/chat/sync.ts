/**
 * Keeps the chat store in step with the server within ChatKit's audited budget (60 requests per minute per token,
 * design §3.3 and ChatKit `docs/API.md` → Limits):
 *
 * - **Realtime hints** (ids only, from Rust) are batched: one flush per {@link HINT_DELAY} fetches the list once and the
 *   open conversation's new messages with `after=` (one call), never one call per event. Hints for conversations of
 *   another context only refetch the current context's list (the API filters them out).
 * - **Polling** while the stream is not live: the list every 30 s while the chat is visible, 120 s in the background;
 *   the open conversation with `after=` at the same time.
 * - **Errors**: `429` pauses every request until `Retry-After`; network and server errors back off exponentially with
 *   jitter up to 10 minutes; `401` disconnects chat (`onUnauthorized`), never the time session.
 * - A client-side token bucket keeps at most {@link BUDGET} requests per minute even if the person clicks fast.
 */
import { ApiError } from '../api/client';
import type { ChatApi } from './api';
import { ChatStore } from './store';
import type { ChatHint } from './types';

export const POLL_VISIBLE_MS = 30_000;
export const POLL_HIDDEN_MS = 120_000;
export const HINT_DELAY = 400;
export const BACKOFF_FIRST_MS = 5_000;
export const BACKOFF_MAX_MS = 600_000;
/** Requests per minute this client allows itself (the server's budget is 60). */
export const BUDGET = 50;
/** Pages of the conversation list followed at start (up to 300 rows). */
export const START_PAGES = 3;
export const PAGE_SIZE = 50;
export const LIST_PAGE_SIZE = 100;

export interface SyncClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
}

export const realClock: SyncClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export interface SyncEvents {
  /** The store changed (re-render). `scope` tells the view what changed. */
  changed(scope: 'list' | 'messages' | 'thread'): void;
  /** New messages arrived in the open conversation from someone else (polite announcement). */
  arrived(count: number, author: string | null): void;
  /** The chat token is no longer valid (401): disconnect chat only. */
  unauthorized(): void;
  /** Network / server state for the sidebar footer. */
  status(state: 'ok' | 'offline' | 'limited'): void;
}

export class RateLimited extends Error {
  constructor(public readonly until: number) {
    super('rate limited');
    this.name = 'RateLimited';
  }
}

export class ChatSync {
  readonly store = new ChatStore();
  /** Conversation shown now, and the thread open in it. */
  openUuid: string | null = null;
  threadRoot: string | null = null;
  /** The chat view is visible (focus and window): polling interval and read marks depend on it. */
  visible = false;
  live = false;
  private pausedUntil = 0;
  private failures = 0;
  private stamps: number[] = [];
  private pollTimer: unknown = null;
  private hintTimer: unknown = null;
  private hints: ChatHint[] = [];
  private generation = 0;
  private stopped = true;
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly api: ChatApi,
    private readonly events: SyncEvents,
    private readonly clock: SyncClock = realClock,
  ) {}

  /** Starts (or restarts after a context switch): clears the store and loads the list. */
  async start(): Promise<void> {
    this.stop();
    this.stopped = false;
    this.generation += 1;
    this.store.clear();
    this.openUuid = null;
    this.threadRoot = null;
    await this.loadList(true);
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    for (const timer of [this.pollTimer, this.hintTimer]) if (timer !== null) this.clock.clearTimeout(timer);
    this.pollTimer = null;
    this.hintTimer = null;
    this.hints = [];
    this.inflight.clear();
  }

  /** Forgets everything (disconnect, sign-out): memory only, nothing on disk. */
  reset(): void {
    this.stop();
    this.store.clear();
    this.openUuid = null;
    this.threadRoot = null;
  }

  setLive(live: boolean): void {
    if (this.live === live) return;
    this.live = live;
    // Back from live to polling: a catch-up now (events may have been missed), then the regular interval.
    if (!live && !this.stopped) void this.poll();
    else this.schedulePoll();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible && !this.stopped) void this.poll();
  }

  /** Waits for the budget; throws {@link RateLimited} while a `Retry-After` pause runs. */
  private async call<T>(work: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    if (now < this.pausedUntil) throw new RateLimited(this.pausedUntil);
    this.stamps = this.stamps.filter((stamp) => now - stamp < 60_000);
    if (this.stamps.length >= BUDGET) throw new RateLimited(this.stamps[0] + 60_000);
    this.stamps.push(now);
    try {
      const result = await work();
      if (this.failures > 0) this.events.status('ok');
      this.failures = 0;
      return result;
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          this.reset();
          this.events.unauthorized();
        } else if (error.status === 429) {
          this.pausedUntil = this.clock.now() + (error.retryAfter ?? 60) * 1000;
          this.events.status('limited');
        } else if (error.isNetwork || error.status >= 500) {
          this.failures += 1;
          this.events.status('offline');
        }
      }
      throw error;
    }
  }

  /** Runs one request per key at a time (a second caller waits for the first). */
  private once(key: string, work: () => Promise<void>): Promise<void> {
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const promise = work().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private current(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  async loadList(follow = false): Promise<void> {
    const generation = this.generation;
    await this.once('list', async () => {
      const page = await this.call(() => this.api.conversations(null, LIST_PAGE_SIZE));
      if (!this.current(generation)) return;
      this.store.applyPage(page, false);
      this.events.changed('list');
      let cursor = page.nextCursor;
      for (let i = 1; follow && cursor !== null && i < START_PAGES; i += 1) {
        const next = await this.call(() => this.api.conversations(cursor, LIST_PAGE_SIZE));
        if (!this.current(generation)) return;
        this.store.applyPage(next, true);
        cursor = next.nextCursor;
        this.events.changed('list');
      }
    });
  }

  async loadMoreConversations(): Promise<void> {
    const cursor = this.store.nextCursor;
    if (cursor === null) return;
    const generation = this.generation;
    await this.once('list-more', async () => {
      const page = await this.call(() => this.api.conversations(cursor, LIST_PAGE_SIZE));
      if (!this.current(generation)) return;
      this.store.applyPage(page, true);
      this.events.changed('list');
    });
  }

  /** Opens a conversation: the newest page (kept if already loaded, then caught up). */
  async open(uuid: string): Promise<void> {
    this.openUuid = uuid;
    this.threadRoot = null;
    this.store.dropThreads();
    const generation = this.generation;
    const loaded = this.store.timeline(uuid);
    if (loaded !== null && loaded.messages.length > 0) {
      this.events.changed('messages');
      await this.catchUp(uuid);
      return;
    }
    await this.once(`open:${uuid}`, async () => {
      const page = await this.call(() => this.api.messages(uuid, { limit: PAGE_SIZE }));
      if (!this.current(generation)) return;
      this.store.applyMessages(uuid, page, 'newest');
      if (this.openUuid === uuid) this.events.changed('messages');
    });
  }

  /**
   * Loads the newest page of a conversation that is not open, when nothing of it is loaded yet (chat home view: the
   * mentions of unread conversations). No event: the caller redraws what it shows.
   */
  async peek(uuid: string): Promise<void> {
    if (this.store.timeline(uuid) !== null) return;
    const generation = this.generation;
    await this.once(`open:${uuid}`, async () => {
      const page = await this.call(() => this.api.messages(uuid, { limit: PAGE_SIZE }));
      if (!this.current(generation) || this.store.conversation(uuid) === null) return;
      this.store.applyMessages(uuid, page, 'newest');
    });
  }

  /** Infinite scroll up: the page before the oldest loaded message. Resolves `false` when nothing older exists. */
  async loadOlder(uuid: string): Promise<boolean> {
    const timeline = this.store.timeline(uuid);
    if (timeline === null || !timeline.hasMore || timeline.messages.length === 0) return false;
    const generation = this.generation;
    await this.once(`older:${uuid}`, async () => {
      const page = await this.call(() => this.api.messages(uuid, { before: timeline.messages[0].id, limit: PAGE_SIZE }));
      if (!this.current(generation)) return;
      this.store.applyMessages(uuid, page, 'older');
      if (this.openUuid === uuid) this.events.changed('messages');
    });
    return true;
  }

  /** New messages after the newest loaded one (`after=`), up to 3 pages. */
  async catchUp(uuid: string): Promise<void> {
    const generation = this.generation;
    await this.once(`after:${uuid}`, async () => {
      let added = 0;
      let author: string | null = null;
      for (let i = 0; i < 3; i += 1) {
        const timeline = this.store.timeline(uuid);
        const newest = timeline?.messages[timeline.messages.length - 1]?.id;
        const page = await this.call(() => (newest === undefined ? this.api.messages(uuid, { limit: PAGE_SIZE }) : this.api.messages(uuid, { after: newest, limit: PAGE_SIZE })));
        if (!this.current(generation)) return;
        this.store.applyMessages(uuid, page, newest === undefined ? 'newest' : 'newer');
        const others = page.messages.filter((message) => !message.mine);
        added += others.length;
        author = others.length > 0 ? others[others.length - 1].author.name : author;
        if (!page.hasMore || newest === undefined || page.messages.length < PAGE_SIZE) break;
      }
      if (this.openUuid === uuid) {
        this.events.changed('messages');
        if (added > 0) this.events.arrived(added, author);
      }
    });
  }

  async openThread(uuid: string, root: string): Promise<void> {
    this.threadRoot = root;
    const generation = this.generation;
    await this.once(`thread:${root}`, async () => {
      const page = await this.call(() => this.api.thread(uuid, root));
      if (!this.current(generation) || this.threadRoot !== root) return;
      if (page !== null) this.store.applyThread(root, page, 'newest');
      this.events.changed('thread');
    });
  }

  closeThread(): void {
    this.threadRoot = null;
    this.store.dropThreads();
  }

  async loadOlderReplies(uuid: string, root: string): Promise<void> {
    const thread = this.store.thread(root);
    if (thread === null || !thread.hasMore || thread.replies.length === 0) return;
    const generation = this.generation;
    await this.once(`thread-older:${root}`, async () => {
      const page = await this.call(() => this.api.thread(uuid, root, { before: thread.replies[0].id }));
      if (!this.current(generation) || page === null) return;
      this.store.applyThread(root, page, 'older');
      this.events.changed('thread');
    });
  }

  /**
   * A write through the same budget as every read (the token bucket, a running `Retry-After` pause, `401` handling).
   * Throws {@link RateLimited} without sending while paused.
   */
  write<T>(work: (api: ChatApi) => Promise<T>): Promise<T> {
    return this.call(() => work(this.api));
  }

  /** Whether `generation` (taken before a write) is still the running one: no context switch or disconnect since. */
  isCurrent(generation: number): boolean {
    return this.current(generation);
  }

  get currentGeneration(): number {
    return this.generation;
  }

  async refreshThread(uuid: string, root: string): Promise<void> {
    const thread = this.store.thread(root);
    const newest = thread?.replies[thread.replies.length - 1]?.id;
    const generation = this.generation;
    await this.once(`thread-newer:${root}`, async () => {
      const page = await this.call(() => this.api.thread(uuid, root, newest === undefined ? {} : { after: newest }));
      if (!this.current(generation) || page === null || this.threadRoot !== root) return;
      this.store.applyThread(root, page, newest === undefined ? 'newest' : 'newer');
      this.events.changed('thread');
    });
  }

  /**
   * Read mark for the open conversation, when visible: the newest loaded message, only when it is past the server's
   * cursor (never backwards, never twice for the same id).
   */
  async markRead(uuid: string): Promise<void> {
    const timeline = this.store.timeline(uuid);
    const newest = timeline?.messages[timeline.messages.length - 1];
    if (!this.visible || newest === undefined || (timeline?.readUpTo !== null && (timeline?.readUpTo ?? 0) >= newest.id)) {
      if (newest !== undefined && (timeline?.readUpTo ?? 0) >= newest.id) this.store.markRead(uuid);
      return;
    }
    const generation = this.generation;
    this.store.setReadUpTo(uuid, newest.id);
    this.store.markRead(uuid);
    this.events.changed('list');
    await this.once(`read:${uuid}`, async () => {
      const readUpTo = await this.call(() => this.api.read(uuid, newest.id));
      if (!this.current(generation)) return;
      this.store.setReadUpTo(uuid, readUpTo);
    });
  }

  /** A realtime hint: queued and flushed in one batch. */
  hint(hint: ChatHint): void {
    if (this.stopped) return;
    this.hints.push(hint);
    if (this.hintTimer === null) {
      this.hintTimer = this.clock.setTimeout(() => {
        this.hintTimer = null;
        void this.flush().catch(() => undefined);
      }, HINT_DELAY);
    }
  }

  /** Applies the queued hints: one list fetch, one catch-up of the open conversation, single messages, the thread. */
  async flush(): Promise<void> {
    const hints = this.hints;
    this.hints = [];
    if (hints.length === 0 || this.stopped) return;
    const open = this.openUuid;
    const known = (uuid: string | undefined) => uuid !== undefined && this.store.conversation(uuid) !== null;
    const listChanged = hints.some((hint) => ['message', 'read', 'unread', 'conversation'].includes(hint.kind) || !known(hint.conversationUuid));
    const work: Promise<void>[] = [];
    if (listChanged) work.push(this.loadList());
    if (open !== null) {
      const here = hints.filter((hint) => hint.conversationUuid === open);
      if (here.some((hint) => hint.kind === 'message' && hint.rootUuid === undefined)) work.push(this.catchUp(open));
      const updated = [...new Set(here.filter((hint) => hint.kind === 'message_updated' && hint.messageUuid !== undefined && hint.rootUuid === undefined).map((hint) => hint.messageUuid as string))];
      // A few single messages; many changes at once: one catch-up of the newest page instead.
      if (updated.length > 3) work.push(this.refreshNewest(open));
      else for (const messageUuid of updated) work.push(this.refreshMessage(open, messageUuid));
      const root = this.threadRoot;
      if (root !== null && here.some((hint) => hint.rootUuid === root || (hint.kind === 'thread' && hint.rootUuid === root))) work.push(this.refreshThread(open, root));
      else if (root !== null && here.some((hint) => hint.kind === 'message_updated' && hint.rootUuid !== undefined)) work.push(this.refreshThread(open, root));
      // A reply changes its root's reply count: refresh the root.
      const roots = [...new Set(here.filter((hint) => hint.kind === 'thread' && hint.rootUuid !== undefined).map((hint) => hint.rootUuid as string))];
      for (const rootUuid of roots.slice(0, 3)) if (!updated.includes(rootUuid)) work.push(this.refreshMessage(open, rootUuid));
    }
    await Promise.allSettled(work);
  }

  private async refreshMessage(uuid: string, messageUuid: string): Promise<void> {
    const generation = this.generation;
    await this.once(`message:${messageUuid}`, async () => {
      const message = await this.call(() => this.api.message(uuid, messageUuid));
      if (!this.current(generation) || message === null) return;
      this.store.applyMessage(uuid, message);
      if (this.openUuid !== uuid) return;
      this.events.changed('messages');
      if (this.threadRoot !== null) this.events.changed('thread');
    });
  }

  private async refreshNewest(uuid: string): Promise<void> {
    const generation = this.generation;
    await this.once(`newest:${uuid}`, async () => {
      const page = await this.call(() => this.api.messages(uuid, { limit: PAGE_SIZE }));
      if (!this.current(generation)) return;
      this.store.applyMessages(uuid, page, 'newest');
      if (this.openUuid === uuid) this.events.changed('messages');
    });
  }

  /** One polling round: the list, and the open conversation (and thread) caught up. */
  async poll(): Promise<void> {
    if (this.stopped) return;
    const open = this.openUuid;
    const work: Promise<void>[] = [this.loadList()];
    if (open !== null) work.push(this.catchUp(open));
    if (open !== null && this.threadRoot !== null) work.push(this.refreshThread(open, this.threadRoot));
    await Promise.allSettled(work);
    this.schedulePoll();
  }

  /** The next polling round: none while live; 30 s / 120 s; longer after errors or a `Retry-After`. */
  nextPollDelay(): number | null {
    if (this.stopped || this.live) return null;
    let delay = this.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
    if (this.failures > 0) {
      const backoff = Math.min(BACKOFF_FIRST_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
      delay = Math.max(delay, Math.round(backoff * (0.8 + 0.4 * this.clock.random())));
    }
    const pause = this.pausedUntil - this.clock.now();
    return Math.min(Math.max(delay, pause), BACKOFF_MAX_MS * 3);
  }

  private schedulePoll(): void {
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    const delay = this.nextPollDelay();
    if (delay === null) return;
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }
}
