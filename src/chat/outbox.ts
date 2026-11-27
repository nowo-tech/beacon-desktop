/**
 * Chat writes (BD-3b, ChatKit 2.5): sending a message, replying in a thread and reacting, **in memory only** (no text
 * on disk, Q-BD-15; everything goes on a context switch, "Disconnect chat" and sign-out).
 *
 * - **One `Idempotency-Key` per write.** A message keeps its key until it is sent or discarded: every retry (automatic
 *   after a `429` / `409`, or the person's *Retry* after a network error or a `5xx`) sends the same key, so the server
 *   writes it once (`200 replayed`). A refusal that wrote nothing for a reason of the request (`403 read_only`,
 *   `422 text_too_long` …) is never retried: the text goes back to the composer, and a new attempt is a new write with
 *   a new key (ChatKit `docs/API.md` → Idempotency-Key).
 * - **No offline queue** (design §3.3): a message that could not be sent shows *Not sent* with *Retry* and *Discard*.
 * - **The timeline stays the server's.** A sent message is shown from the write's answer until the catch-up
 *   (`messages?after=`) brings it with whatever others wrote in between; it is never merged into the loaded window
 *   directly, so the catch-up cursor never skips a message.
 * - **Reactions** change at once and are put back if the server refuses; the server's answer is the final state.
 * - Writes spend the same client budget as reads ({@link ChatSync.write}): a running `Retry-After` pause waits.
 */
import { ApiError } from '../api/client';
import { newIdempotencyKey, retryable } from './api';
import { markdownBlocks } from './markdown';
import { RateLimited, type ChatSync, type SyncClock } from './sync';
import type { Message, Person, Reaction } from './types';

/** Automatic retries of one write after a `429` / `409` (then the person decides). */
export const AUTO_RETRIES = 3;

export type PendingState = 'sending' | 'waiting' | 'failed' | 'sent';

export interface Pending {
  /** The write's `Idempotency-Key` (a UUID), also its id in the view. */
  key: string;
  conversation: string;
  /** The thread root it replies to, `null` for the main timeline. */
  root: string | null;
  text: string;
  createdAt: string;
  state: PendingState;
  /** Why it failed: the server's code (`read_only`, `text_too_long` …), `network_error`, or `null`. */
  error: string | null;
  /** A failed write may be sent again with the same key (network, `5xx`; never a refusal of the request). */
  canRetry: boolean;
  /** Automatic retries used. */
  attempts: number;
  /** The server's message, once sent (shown until the catch-up brings it). */
  sent: Message | null;
}

export interface OutboxEvents {
  /** The pending messages of the timeline (`root` null) or of a thread changed. */
  changed(conversation: string, root: string | null): void;
  /** A message was sent / could not be sent / a reaction was refused (polite announcements, banners). */
  sent(pending: Pending): void;
  failed(pending: Pending): void;
  reactionFailed(error: unknown): void;
}

/** Errors a write never repeats with the same key: the server refused the request itself and wrote nothing. */
export function refusalOf(error: unknown): string | null {
  if (error instanceof RateLimited) return null;
  if (error instanceof ApiError && !retryable(error) && error.status !== 401) return error.code;
  return null;
}

export class ChatOutbox {
  private items: Pending[] = [];
  private readonly timers = new Map<string, unknown>();
  /** Reaction writes in flight, per `message|emoji` (a second click waits for the first). */
  private readonly reacting = new Set<string>();

  constructor(
    private readonly sync: ChatSync,
    private readonly events: OutboxEvents,
    private readonly clock: SyncClock,
  ) {}

  /** Pending messages of a conversation's timeline (`root` null) or of one thread, oldest first. */
  pending(conversation: string, root: string | null): Pending[] {
    return this.items.filter((item) => item.conversation === conversation && item.root === root);
  }

  /** Everything is forgotten (context switch, disconnect, sign-out): memory only. */
  clear(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.items = [];
    this.reacting.clear();
  }

  /** Sends `text` to the conversation (or as a reply to `root`) under a fresh key. */
  send(conversation: string, root: string | null, text: string): Pending {
    const pending: Pending = {
      key: newIdempotencyKey(),
      conversation,
      root,
      text,
      createdAt: new Date(this.clock.now()).toISOString(),
      state: 'sending',
      error: null,
      canRetry: false,
      attempts: 0,
      sent: null,
    };
    this.items.push(pending);
    this.events.changed(conversation, root);
    void this.attempt(pending);
    return pending;
  }

  /** *Retry* on a failed message: the same key (the server writes it once even if the first try got through). */
  retry(key: string): void {
    const pending = this.items.find((item) => item.key === key);
    if (pending === undefined || pending.state !== 'failed' || !pending.canRetry) return;
    pending.state = 'sending';
    pending.error = null;
    pending.attempts = 0;
    this.events.changed(pending.conversation, pending.root);
    void this.attempt(pending);
  }

  /** *Discard* (or *Edit*, which puts the text back in the composer): removes a message that was not sent. */
  discard(key: string): Pending | null {
    const pending = this.items.find((item) => item.key === key);
    if (pending === undefined || pending.state === 'sent' || pending.state === 'sending') return null;
    this.drop(pending);
    return pending;
  }

  /** Drops sent messages the timeline or the thread now shows (after a catch-up). */
  settle(conversation: string): void {
    const store = this.sync.store;
    const before = this.items.length;
    const touched = new Set<string | null>();
    this.items = this.items.filter((item) => {
      const shown = item.conversation === conversation && item.sent !== null && store.has(conversation, item.sent.uuid, item.root);
      if (shown) touched.add(item.root);
      return !shown;
    });
    if (this.items.length !== before) for (const root of touched) this.events.changed(conversation, root);
  }

  private drop(pending: Pending): void {
    const timer = this.timers.get(pending.key);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(pending.key);
    this.items = this.items.filter((item) => item !== pending);
    this.events.changed(pending.conversation, pending.root);
  }

  private async attempt(pending: Pending): Promise<void> {
    const generation = this.sync.currentGeneration;
    try {
      const written = await this.sync.write((api) => (pending.root === null ? api.send(pending.conversation, pending.text, pending.key) : api.reply(pending.conversation, pending.root, pending.text, pending.key)));
      if (!this.sync.isCurrent(generation) || !this.items.includes(pending)) return;
      pending.state = 'sent';
      pending.sent = written.message;
      this.events.sent(pending);
      this.events.changed(pending.conversation, pending.root);
      if (written.root !== null) {
        // The root's reply count in the timeline.
        this.sync.store.replaceMessage(pending.conversation, written.root);
        this.events.changed(pending.conversation, null);
      }
      // The catch-up brings the message with anything written in between; then it leaves the pending list.
      const catchUp = pending.root === null ? this.sync.catchUp(pending.conversation) : this.sync.refreshThread(pending.conversation, pending.root);
      await catchUp.catch(() => undefined);
      if (this.sync.isCurrent(generation)) this.settle(pending.conversation);
    } catch (error) {
      if (!this.sync.isCurrent(generation) || !this.items.includes(pending)) return;
      this.failedAttempt(pending, error);
    }
  }

  private failedAttempt(pending: Pending, error: unknown): void {
    const wait = waitFor(error, this.clock.now());
    if (wait !== null && pending.attempts < AUTO_RETRIES) {
      pending.attempts += 1;
      pending.state = 'waiting';
      pending.error = error instanceof ApiError ? error.code : 'rate_limited';
      this.events.changed(pending.conversation, pending.root);
      this.timers.set(
        pending.key,
        this.clock.setTimeout(() => {
          this.timers.delete(pending.key);
          if (!this.items.includes(pending)) return;
          pending.state = 'sending';
          this.events.changed(pending.conversation, pending.root);
          void this.attempt(pending);
        }, wait),
      );
      return;
    }
    const refusal = refusalOf(error);
    pending.state = 'failed';
    pending.error = refusal ?? (error instanceof ApiError ? error.code : error instanceof RateLimited ? 'rate_limited' : 'network_error');
    // Same key again only when the server may not have seen it, or wrote nothing for a passing reason.
    pending.canRetry = refusal === null && !(error instanceof ApiError && error.status === 401);
    this.events.failed(pending);
    this.events.changed(pending.conversation, pending.root);
  }

  /**
   * Adds or removes the reader's `emoji` on a message: shown at once, the server's answer replaces it, a refusal puts
   * the previous reactions back. A second click on the same emoji while the first is in flight is ignored.
   */
  async react(conversation: string, messageUuid: string, emoji: string): Promise<void> {
    const store = this.sync.store;
    const message = store.findMessage(conversation, messageUuid);
    const id = `${messageUuid}|${emoji}`;
    if (message === null || this.reacting.has(id)) return;
    const before = message.reactions;
    const on = !before.some((reaction) => reaction.emoji === emoji && reaction.mine);
    this.reacting.add(id);
    store.setReactions(conversation, messageUuid, toggled(before, emoji, on));
    this.events.changed(conversation, null);
    const generation = this.sync.currentGeneration;
    try {
      const reactions = await this.sync.write((api) => api.react(conversation, messageUuid, emoji, on, newIdempotencyKey()));
      if (!this.sync.isCurrent(generation)) return;
      store.setReactions(conversation, messageUuid, reactions);
    } catch (error) {
      if (!this.sync.isCurrent(generation)) return;
      store.setReactions(conversation, messageUuid, before);
      this.events.reactionFailed(error);
    } finally {
      this.reacting.delete(id);
    }
    this.events.changed(conversation, null);
  }

  /** The message shown for a pending write: the server's once sent, else the text rendered as the server will. */
  static view(pending: Pending, author: Person): Message {
    if (pending.sent !== null) return pending.sent;
    return {
      id: Number.MAX_SAFE_INTEGER,
      uuid: pending.key,
      kind: 'user',
      author,
      mine: true,
      createdAt: pending.createdAt,
      edited: false,
      deleted: false,
      mentionsMe: false,
      threadRootUuid: pending.root,
      thread: null,
      reactions: [],
      // The same subset the server renders (bold, italic, code, lists, links): no raw `**` while it is on its way.
      blocks: markdownBlocks(pending.text),
    };
  }
}

/** How long to wait before an automatic retry: a `429` (its `Retry-After`) or a lock conflict `409`; else `null`. */
export function waitFor(error: unknown, now: number): number | null {
  if (error instanceof RateLimited) return Math.max(error.until - now, 1000);
  if (error instanceof ApiError && error.status === 429) return Math.max((error.retryAfter ?? 5) * 1000, 1000);
  if (error instanceof ApiError && error.status === 409) return Math.max((error.retryAfter ?? 1) * 1000, 1000);
  return null;
}

/** The reactions after adding (`on`) or removing the reader's `emoji` (optimistic; the server's answer wins). */
export function toggled(reactions: Reaction[], emoji: string, on: boolean): Reaction[] {
  const current = reactions.find((reaction) => reaction.emoji === emoji);
  if (on) {
    if (current?.mine === true) return reactions;
    return current === undefined ? [...reactions, { emoji, count: 1, mine: true }] : reactions.map((reaction) => (reaction === current ? { ...reaction, count: reaction.count + 1, mine: true } : reaction));
  }
  if (current === undefined || !current.mine) return reactions;
  return current.count <= 1 ? reactions.filter((reaction) => reaction !== current) : reactions.map((reaction) => (reaction === current ? { ...reaction, count: reaction.count - 1, mine: false } : reaction));
}
