/**
 * Chat writes (BD-3b, ChatKit 2.5): sending a message, replying in a thread and reacting, **in memory only** (no text
 * on disk, Q-BD-15; everything goes on a context switch, "Disconnect chat" and sign-out).
 *
 * - **One `Idempotency-Key` per write.** A message keeps its key until it is sent or discarded: every attempt (automatic
 *   after a `429` / `409`, after the connection comes back, or the person's *Retry*) sends the same key, so the server
 *   writes it once (`200 replayed`). A refusal that wrote nothing for a reason of the request (`403 read_only`,
 *   `422 text_too_long` …) is never retried: the text goes back to the composer, and a new attempt is a new write with
 *   a new key (ChatKit `docs/API.md` → Idempotency-Key).
 * - **Offline send queue** (UX batch 5, owner approval 2026-11-27, UXA-6). A message that could not reach the server
 *   (no network, a `5xx`) is not a failure: it stays *queued* ("Waiting for connection") and goes out when the
 *   connection is back ({@link ChatOutbox.setOnline}) or on its own backoff probe. Messages of one conversation go out
 *   **one at a time, in the order they were written** (timeline and threads alike): a message never overtakes an older
 *   one. Only one attempt per message is ever in flight, so a reconnect never sends it twice, and the server dedupes a
 *   replay of a write whose answer was lost. Each queued message can be sent now (*Retry*) or cancelled.
 * - **Lifetime.** The queue lives in the chat module, so it survives switching to Time or Tasks and back. It does **not**
 *   survive a context switch, "Disconnect chat", sign-out or quitting the app: the text is never written to disk
 *   (Q-BD-15, PRIVACY.md).
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
/** First and longest wait between two probes of a queued message while the connection is down. */
export const QUEUE_PROBE_MIN_MS = 2000;
export const QUEUE_PROBE_MAX_MS = 30_000;

/**
 * - `queued`: waits its turn behind an older message, or for the connection (`error` `network_error` / `server_error`).
 * - `sending`: one attempt in flight. `waiting`: an automatic retry after a `429` / `409`.
 * - `failed`: the person decides (*Retry* when `canRetry`, else *Edit* / *Discard*). `sent`: shown until the catch-up.
 */
export type PendingState = 'queued' | 'sending' | 'waiting' | 'failed' | 'sent';

export interface Pending {
  /** The write's `Idempotency-Key` (a UUID), also its id in the view. */
  key: string;
  conversation: string;
  /** The thread root it replies to, `null` for the main timeline. */
  root: string | null;
  text: string;
  createdAt: string;
  state: PendingState;
  /** Why it failed or waits: the server's code (`read_only`, `text_too_long` …), `network_error`, `server_error`, or `null`. */
  error: string | null;
  /** A failed write may be sent again with the same key (never a refusal of the request). */
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
  /** A message waits for the connection (once per message). */
  queued?(pending: Pending): void;
  reactionFailed(error: unknown): void;
}

/** Errors a write never repeats with the same key: the server refused the request itself and wrote nothing. */
export function refusalOf(error: unknown): string | null {
  if (error instanceof RateLimited) return null;
  if (error instanceof ApiError && !retryable(error) && error.status !== 401) return error.code;
  return null;
}

/** The server was not reached or could not answer (no network, a `5xx`): the message waits for the connection. */
export function unreachable(error: unknown): 'network_error' | 'server_error' | null {
  if (!(error instanceof ApiError)) return null;
  if (error.isNetwork) return 'network_error';
  return error.status >= 500 ? 'server_error' : null;
}

/** States that still take a turn in the conversation's send order. */
const IN_LINE: ReadonlySet<PendingState> = new Set(['queued', 'sending', 'waiting']);

export class ChatOutbox {
  private items: Pending[] = [];
  private readonly timers = new Map<string, unknown>();
  /** Reaction writes in flight, per `message|emoji` (a second click waits for the first). */
  private readonly reacting = new Set<string>();
  /** Keys with an attempt in flight: never two attempts of one message at once. */
  private readonly inflight = new Set<string>();
  /** Keys already announced as waiting for the connection. */
  private readonly announced = new Set<string>();
  /** What the sync last said about the connection (`status` events). */
  private online = true;
  private probeTimer: unknown = null;
  private probes = 0;
  /** Bumped by {@link clear}: an *Undo* from before a context switch or a disconnect restores nothing. */
  private era = 0;
  /** Messages sent per conversation (an undone discard never overtakes one sent after it). */
  private readonly sends = new Map<string, number>();
  /**
   * Write order of every message (BDA14-L2): a monotonically increasing number set in {@link send}. `items` is kept in
   * this order, so an *Undo* puts a message back before any newer one, whatever was removed meanwhile.
   */
  private readonly sequence = new WeakMap<Pending, number>();
  private nextSequence = 0;

  constructor(
    private readonly sync: ChatSync,
    private readonly events: OutboxEvents,
    private readonly clock: SyncClock,
  ) {}

  /** Pending messages of a conversation's timeline (`root` null) or of one thread, oldest first. */
  pending(conversation: string, root: string | null): Pending[] {
    return this.items.filter((item) => item.conversation === conversation && item.root === root);
  }

  /** Messages not sent yet (queued, sending or waiting), in every conversation. */
  queuedCount(): number {
    return this.items.filter((item) => IN_LINE.has(item.state)).length;
  }

  /** Messages waiting for the connection (queued after a network error or a `5xx`). */
  waitingCount(): number {
    return this.items.filter((item) => item.state === 'queued' && item.error !== null).length;
  }

  /** Everything is forgotten (context switch, disconnect, sign-out): memory only. */
  clear(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    if (this.probeTimer !== null) this.clock.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.probes = 0;
    this.items = [];
    this.reacting.clear();
    this.inflight.clear();
    this.announced.clear();
    this.sends.clear();
    this.era += 1;
  }

  /**
   * What an *Undo* of {@link discard} needs (UX batch 4, UXA-8): the outbox's era and how many messages of its
   * conversation had gone out. Where it goes back follows its write order (BDA14-L2), not a position.
   */
  undoPoint(pending: Pending): { era: number; sends: number } {
    return { era: this.era, sends: this.sends.get(pending.conversation) ?? 0 };
  }

  /**
   * *Undo* of a discard (UX batch 4, UXA-8): the message comes back where it stood, with its `Idempotency-Key`. A failed
   * message comes back failed (nothing is sent). A queued one takes its turn again, unless a newer message of its
   * conversation went out (or is going out) meanwhile: then it comes back as not sent, with *Retry*, so it never overtakes silently.
   * Nothing happens after a context switch, "Disconnect chat" or sign-out ({@link clear}), or when the key is back already.
   */
  restore(pending: Pending, point: { era: number; sends: number }): boolean {
    if (point.era !== this.era || this.items.some((item) => item.key === pending.key)) return false;
    if (pending.state !== 'failed') {
      // A newer message of the conversation went out, or is going out now: this one would overtake it.
      const overtaken =
        (this.sends.get(pending.conversation) ?? 0) !== point.sends ||
        this.items.some((item) => item.conversation === pending.conversation && (item.state === 'sending' || item.state === 'waiting' || this.inflight.has(item.key)));
      pending.state = overtaken ? 'failed' : 'queued';
      pending.canRetry = overtaken ? true : pending.canRetry;
      if (overtaken) pending.error ??= 'network_error';
      else if (!this.online) pending.error = 'network_error';
    }
    // Before the first newer message (BDA14-L2): never behind a message of its conversation written after it.
    const order = this.sequence.get(pending) ?? Number.MAX_SAFE_INTEGER;
    const at = this.items.findIndex((item) => (this.sequence.get(item) ?? Number.MAX_SAFE_INTEGER) > order);
    this.items.splice(at === -1 ? this.items.length : at, 0, pending);
    this.events.changed(pending.conversation, pending.root);
    if (pending.state === 'queued') {
      this.pump(pending.conversation, this.online);
      if (!this.online) this.scheduleProbe();
    }
    return true;
  }

  /**
   * The connection state from the sync. Back online, every conversation's queue goes out at once (in order); offline,
   * new messages are queued without an attempt (the probe still tries now and then).
   */
  setOnline(online: boolean): void {
    const was = this.online;
    this.online = online;
    if (online && !was) {
      this.probes = 0;
      this.flush();
    }
  }

  /** Sends `text` to the conversation (or as a reply to `root`) under a fresh key, after any older message there. */
  send(conversation: string, root: string | null, text: string): Pending {
    const pending: Pending = {
      key: newIdempotencyKey(),
      conversation,
      root,
      text,
      createdAt: new Date(this.clock.now()).toISOString(),
      state: 'queued',
      error: this.online ? null : 'network_error',
      canRetry: false,
      attempts: 0,
      sent: null,
    };
    this.sequence.set(pending, this.nextSequence++);
    this.items.push(pending);
    if (!this.online) this.noteQueued(pending);
    this.events.changed(conversation, root);
    this.pump(conversation, this.online);
    if (!this.online) this.scheduleProbe();
    return pending;
  }

  /**
   * *Retry*: a failed message gets back in line with the same key (the server writes it once even if the first try got
   * through); a queued one is tried now instead of waiting for the next probe.
   */
  retry(key: string): void {
    const pending = this.items.find((item) => item.key === key);
    if (pending === undefined) return;
    if (pending.state === 'queued') {
      this.pump(pending.conversation, true);
      return;
    }
    if (pending.state !== 'failed' || !pending.canRetry) return;
    pending.state = 'queued';
    pending.error = null;
    pending.attempts = 0;
    this.events.changed(pending.conversation, pending.root);
    this.pump(pending.conversation, true);
  }

  /** *Cancel* / *Discard* (or *Edit*, which puts the text back in the composer): removes a message that was not sent. */
  discard(key: string): Pending | null {
    const pending = this.items.find((item) => item.key === key);
    // Never while an attempt is in flight (it may be written): the message then settles as sent or comes back.
    if (pending === undefined || pending.state === 'sent' || pending.state === 'sending' || this.inflight.has(key)) return null;
    this.drop(pending);
    // The next message of the conversation may go now.
    this.pump(pending.conversation, this.online);
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
    this.announced.delete(pending.key);
    this.items = this.items.filter((item) => item !== pending);
    this.events.changed(pending.conversation, pending.root);
  }

  /** Every conversation's queue, oldest message first. */
  private flush(): void {
    for (const conversation of new Set(this.items.map((item) => item.conversation))) this.pump(conversation, true);
  }

  /**
   * Starts the oldest message of `conversation` that is still in line, unless one is already sending or waiting (the
   * order is kept: nothing overtakes it). `attempt` false only marks the turn (offline: the probe or the reconnect
   * sends it).
   */
  private pump(conversation: string, attempt: boolean): void {
    const head = this.items.find((item) => item.conversation === conversation && IN_LINE.has(item.state));
    if (head === undefined || head.state !== 'queued' || this.inflight.has(head.key) || !attempt) return;
    void this.attempt(head);
  }

  private scheduleProbe(): void {
    if (this.probeTimer !== null || !this.items.some((item) => item.state === 'queued')) return;
    const wait = Math.min(QUEUE_PROBE_MIN_MS * 2 ** this.probes, QUEUE_PROBE_MAX_MS);
    this.probes += 1;
    this.probeTimer = this.clock.setTimeout(() => {
      this.probeTimer = null;
      this.flush();
    }, wait);
  }

  private noteQueued(pending: Pending): void {
    if (this.announced.has(pending.key)) return;
    this.announced.add(pending.key);
    this.events.queued?.(pending);
  }

  private async attempt(pending: Pending): Promise<void> {
    if (this.inflight.has(pending.key)) return;
    this.inflight.add(pending.key);
    // A probe of a message waiting for the connection stays "Waiting for connection" (no flicker to "Sending…").
    if (!(pending.state === 'queued' && pending.error !== null)) {
      pending.state = 'sending';
      this.events.changed(pending.conversation, pending.root);
    }
    const generation = this.sync.currentGeneration;
    try {
      const written = await this.sync.write((api) => (pending.root === null ? api.send(pending.conversation, pending.text, pending.key) : api.reply(pending.conversation, pending.root, pending.text, pending.key)));
      this.inflight.delete(pending.key);
      if (!this.sync.isCurrent(generation) || !this.items.includes(pending)) return;
      pending.state = 'sent';
      this.sends.set(pending.conversation, (this.sends.get(pending.conversation) ?? 0) + 1);
      pending.error = null;
      pending.sent = written.message;
      this.announced.delete(pending.key);
      // A write got through: the connection works, whatever the last poll said.
      this.online = true;
      this.probes = 0;
      this.events.sent(pending);
      this.events.changed(pending.conversation, pending.root);
      if (written.root !== null) {
        // The root's reply count in the timeline.
        this.sync.store.replaceMessage(pending.conversation, written.root);
        this.events.changed(pending.conversation, null);
      }
      // The next message of the conversation goes now (the connection works), then the others that were waiting.
      this.pump(pending.conversation, true);
      this.flush();
      // The catch-up brings the message with anything written in between; then it leaves the pending list.
      const catchUp = pending.root === null ? this.sync.catchUp(pending.conversation) : this.sync.refreshThread(pending.conversation, pending.root);
      await catchUp.catch(() => undefined);
      if (this.sync.isCurrent(generation)) this.settle(pending.conversation);
    } catch (error) {
      this.inflight.delete(pending.key);
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
          void this.attempt(pending);
        }, wait),
      );
      return;
    }
    const lost = unreachable(error);
    if (lost !== null) {
      // Not a failure: it waits for the connection, keeps its key and its place in line.
      pending.state = 'queued';
      pending.error = lost;
      this.noteQueued(pending);
      this.events.changed(pending.conversation, pending.root);
      this.scheduleProbe();
      return;
    }
    const refusal = refusalOf(error);
    pending.state = 'failed';
    pending.error = refusal ?? (error instanceof ApiError ? error.code : error instanceof RateLimited ? 'rate_limited' : 'network_error');
    // Same key again only when the server wrote nothing for a passing reason (rate limited for good).
    pending.canRetry = refusal === null && !(error instanceof ApiError && error.status === 401);
    this.events.failed(pending);
    this.events.changed(pending.conversation, pending.root);
    // A message that will not go out does not hold the others back.
    if (!(error instanceof ApiError && error.status === 401)) this.pump(pending.conversation, this.online);
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
  // Without `Retry-After` the sync pauses 60 s (sync.ts): wait as long, so no automatic attempt is spent (ZDG-I3).
  if (error instanceof ApiError && error.status === 429) return Math.max((error.retryAfter ?? 60) * 1000, 1000);
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
