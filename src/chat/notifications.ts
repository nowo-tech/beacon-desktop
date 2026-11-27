/**
 * Chat notifications (BD-3b, design §3.4; owner decision 2026-11-27: opt-in at level **None** first).
 *
 * - **Opt-in**: off until the person turns them on (a calm card on the first Chat visit, or Settings). Device setting.
 * - **Level None only**: "New message in Beacon" — no sender, no conversation, no text. Sender and Text come once the
 *   server can say what a reader may see (ChatKit `notifications/preview`, the organization's maximum, Q-BD-9).
 * - **Pause** for 1 hour or until tomorrow (08:00), from Settings or the tray; OS Do Not Disturb applies anyway.
 * - **What notifies**: a conversation of the current context whose newest message id grew since the last list, with
 *   unread messages, not muted, not the reader's own message, and not the conversation being read in a focused window.
 *   The first list after a start or a context switch only primes (nothing older than what was seen notifies), and a
 *   message id notifies once (no duplicates after a reconnect). Several at once are one notification; at most one per
 *   {@link MIN_GAP_MS}.
 * - A click opens the app on that conversation (`chat-open:<uuid>`, an id, never content).
 *
 * Only the setting is stored (on / off, asked, paused until); never message data.
 */
import type { Conversation } from './types';

export const NOTIFY_KEY = 'beacon-desktop-chat-notify';
export const MIN_GAP_MS = 10_000;
export const PAUSE_HOUR_MS = 3_600_000;

export interface NotifyPrefs {
  enabled: boolean;
  /** The opt-in card was answered (or the setting changed): it is not shown again. */
  asked: boolean;
  /** Unix ms; `null`: not paused. */
  pausedUntil: number | null;
}

export function loadNotifyPrefs(storage: Storage | undefined): NotifyPrefs {
  const fallback: NotifyPrefs = { enabled: false, asked: false, pausedUntil: null };
  try {
    const raw = JSON.parse(storage?.getItem(NOTIFY_KEY) ?? 'null') as Partial<NotifyPrefs> | null;
    if (raw === null || typeof raw !== 'object') return fallback;
    const until = typeof raw.pausedUntil === 'number' && Number.isFinite(raw.pausedUntil) ? raw.pausedUntil : null;
    return { enabled: raw.enabled === true, asked: raw.asked === true, pausedUntil: until };
  } catch {
    return fallback;
  }
}

/** Tomorrow at 08:00 local time. */
export function tomorrowMorning(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date.getTime();
}

export interface ObserveState {
  /** The conversation being read now. */
  open: string | null;
  /** The chat is shown in a focused, visible window. */
  reading: boolean;
}

export class ChatNotifier {
  prefs: NotifyPrefs;
  /** Newest message id seen per conversation (memory only). */
  private readonly seen = new Map<string, number>();
  private primed = false;
  private lastAt = -Infinity;

  constructor(
    private readonly storage: Storage | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.prefs = loadNotifyPrefs(storage);
  }

  private save(): void {
    try {
      this.storage?.setItem(NOTIFY_KEY, JSON.stringify(this.prefs));
    } catch {
      // Storage unavailable: the setting lasts for this run.
    }
  }

  setEnabled(enabled: boolean): void {
    this.prefs = { ...this.prefs, enabled, asked: true, pausedUntil: enabled ? this.prefs.pausedUntil : null };
    this.save();
  }

  /** "Not now" on the opt-in card. */
  dismiss(): void {
    this.prefs = { ...this.prefs, asked: true };
    this.save();
  }

  pause(until: number): void {
    this.prefs = { ...this.prefs, pausedUntil: until };
    this.save();
  }

  resume(): void {
    this.prefs = { ...this.prefs, pausedUntil: null };
    this.save();
  }

  paused(): boolean {
    return this.prefs.pausedUntil !== null && this.prefs.pausedUntil > this.now();
  }

  /** Forgets what was seen (start, context switch, disconnect): the next list only primes. */
  reset(): void {
    this.seen.clear();
    this.primed = false;
  }

  /**
   * A new conversation list: the conversation to notify about (the newest of those that qualify), or `null`.
   * Every row's newest id is remembered either way, so nothing notifies twice.
   */
  observe(rows: Conversation[], state: ObserveState): string | null {
    const now = this.now();
    let target: Conversation | null = null;
    for (const row of rows) {
      const id = row.lastMessageId;
      if (id === null) continue;
      const before = this.seen.get(row.uuid);
      this.seen.set(row.uuid, Math.max(before ?? 0, id));
      if (!this.primed) continue;
      const fresh = before === undefined ? true : id > before;
      if (!fresh || row.unread === 0 || row.lastMine || muted(row, now)) continue;
      if (state.reading && state.open === row.uuid) continue;
      if (target === null || row.lastMessageAt > target.lastMessageAt) target = row;
    }
    this.primed = true;
    if (target === null || !this.prefs.enabled || this.paused() || now - this.lastAt < MIN_GAP_MS) return null;
    this.lastAt = now;
    return target.uuid;
  }
}

function muted(row: Conversation, now: number): boolean {
  if (row.mutedUntil === null) return false;
  const until = Date.parse(row.mutedUntil);
  return Number.isNaN(until) || until > now;
}
