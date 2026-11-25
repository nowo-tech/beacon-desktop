/** Pure helpers of the chat view: grouping, day labels, fuzzy matching, the unread divider. Unit-tested on their own. */
import type { ChatText } from './i18n';
import type { Conversation, Message } from './types';

/** Consecutive messages of one author within this window share the avatar and name (owner UX bar). */
export const GROUP_WINDOW_MS = 5 * 60_000;

export interface Row {
  message: Message;
  /** Continues the previous message's group (no avatar / name). */
  continued: boolean;
  /** A day divider goes before it (its label). */
  day: string | null;
  /** The "New" divider goes before it. */
  firstUnread: boolean;
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function dayLabel(iso: string, now: Date, t: ChatText, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  const full = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  if (days === 0) return `${t('today')} · ${full}`;
  if (days === 1) return `${t('yesterday')} · ${full}`;
  if (days > 1 && days < 7) return full.charAt(0).toUpperCase() + full.slice(1);
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/**
 * The rows of a timeline: groups, day dividers and the unread divider before the first message from someone else
 * after `readUpTo` (the cursor seen when the conversation was opened).
 */
export function rows(messages: Message[], readUpTo: number | null, now: Date, t: ChatText, locale: string): Row[] {
  let unreadMarked = readUpTo === null;
  return messages.map((message, i) => {
    const previous = messages[i - 1];
    const date = new Date(message.createdAt);
    const newDay = previous === undefined || dayKey(new Date(previous.createdAt)) !== dayKey(date);
    let firstUnread = false;
    if (!unreadMarked && readUpTo !== null && message.id > readUpTo && !message.mine) {
      firstUnread = true;
      unreadMarked = true;
    }
    const continued =
      previous !== undefined &&
      !newDay &&
      !firstUnread &&
      previous.author.uuid === message.author.uuid &&
      previous.author.name === message.author.name &&
      previous.kind === message.kind &&
      date.getTime() - new Date(previous.createdAt).getTime() < GROUP_WINDOW_MS;
    return { message, continued, day: newDay ? dayLabel(message.createdAt, now, t, locale) : null, firstUnread };
  });
}

/**
 * Fuzzy score of `query` in `text` (case and accents ignored): every query character in order; consecutive matches
 * and word starts score higher. `null` when it does not match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim().replace(/^[#@]/, ''));
  if (q === '') return 0;
  const target = fold(text);
  let score = 0;
  let at = 0;
  let streak = 0;
  for (const char of q) {
    if (char === ' ') continue;
    const found = target.indexOf(char, at);
    if (found < 0) return null;
    streak = found === at ? streak + 1 : 0;
    const wordStart = found === 0 || /[\s\-_#:./]/.test(target[found - 1]);
    score += 1 + streak * 2 + (wordStart ? 3 : 0) - Math.min(found - at, 5) * 0.2;
    at = found + 1;
  }
  return score + (target.startsWith(q) ? 10 : 0);
}

/** Conversations for the switcher: recent first (unread above), filtered and ranked by `query`. */
export function rankConversations(conversations: Conversation[], recent: string[], query: string): Conversation[] {
  const recency = (uuid: string) => {
    const index = recent.indexOf(uuid);
    return index < 0 ? recent.length + 1 : index;
  };
  const scored = conversations
    .map((row) => ({ row, score: fuzzyScore(query, row.title) }))
    .filter((item): item is { row: Conversation; score: number } => item.score !== null);
  if (query.trim() === '') {
    return scored
      .sort((a, b) => recency(a.row.uuid) - recency(b.row.uuid) || Number(b.row.unread > 0) - Number(a.row.unread > 0))
      .map((item) => item.row);
  }
  return scored.sort((a, b) => b.score - a.score || recency(a.row.uuid) - recency(b.row.uuid)).map((item) => item.row);
}

/** The next / previous conversation in sidebar order (wrapping), optionally unread ones only. */
export function step(order: Conversation[], current: string | null, direction: 1 | -1, unreadOnly: boolean): string | null {
  if (order.length === 0) return null;
  let index = order.findIndex((row) => row.uuid === current);
  for (let i = 0; i < order.length; i += 1) {
    index = (index + direction + order.length) % order.length;
    const row = order[index];
    if (row.uuid !== current && (!unreadOnly || row.unread > 0)) return row.uuid;
  }
  return null;
}

/** Back / forward history of opened conversations (Cmd+[ / Cmd+]). */
export class History {
  private items: string[] = [];
  private index = -1;

  push(uuid: string): void {
    if (this.items[this.index] === uuid) return;
    this.items = [...this.items.slice(0, this.index + 1), uuid].slice(-50);
    this.index = this.items.length - 1;
  }

  back(): string | null {
    if (this.index <= 0) return null;
    this.index -= 1;
    return this.items[this.index];
  }

  forward(): string | null {
    if (this.index >= this.items.length - 1) return null;
    this.index += 1;
    return this.items[this.index];
  }

  clear(): void {
    this.items = [];
    this.index = -1;
  }
}
