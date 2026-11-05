import * as de from './messages/de';
import * as en from './messages/en';
import * as es from './messages/es';
import * as fr from './messages/fr';
import * as it from './messages/it';
import * as nl from './messages/nl';
import * as pt from './messages/pt';
import { type Line, POOL_KINDS, type PoolKind, type Pools, type Windows } from './messages/types';

/**
 * Friendly messages (0.5.0): a varied "Still there?" phrasing, cheers on long stretches and time-of-day moments
 * (early start, coffee, lunch, late work, Friday afternoon, weekend). Pure functions; the app keeps the state in local
 * storage (`LocalState.messages`) and renders one calm, dismissible card at a time.
 *
 * Rules: computed on this computer only (timer start and the clock), nothing is sent; at most one card every
 * `MIN_GAP_MINUTES` (the "Still there?" prompt is not counted); each moment at most once per window per day; no line
 * repeats within the last `NO_REPEAT` shown of its pool; "Fun messages" and "Wellbeing reminders" switch them off.
 */

export const MESSAGE_LOCALES = ['en', 'es', 'de', 'fr', 'it', 'nl', 'pt'] as const;
export type MessageLocale = (typeof MESSAGE_LOCALES)[number];

export const CATALOG: Record<MessageLocale, { pools: Pools; windows: Windows }> = { en, es, de, fr, it, nl, pt };

/** First cheer after this many hours of one running timer, then one every `CHEER_EVERY_HOURS`. */
export const CHEER_FIRST_HOURS = 2;
export const CHEER_EVERY_HOURS = 2;
/** Global rate limit between two cards. */
export const MIN_GAP_MINUTES = 50;
/** A card goes away by itself after this long (a lunch card at 4 pm would be odd). */
export const CARD_TTL_MINUTES = 30;
/** Lines of a pool not shown again until this many others were. */
export const NO_REPEAT = 6;
/** Weekend: the playful greeting within this long after the timer starts; the "enjoy your day" nudge after this long. */
export const WEEKEND_START_MINUTES = 60;
export const WEEKEND_REST_AFTER_MINUTES = 90;
/** Remembered "already shown" slots. */
const SEEN_LIMIT = 40;

/** Which switch each pool follows (`cheer` lines follow their own `wellbeing` mark). */
export const KIND_GROUP: Record<Exclude<PoolKind, 'cheer'>, 'fun' | 'wellbeing'> = {
  idle: 'fun',
  earlyBird: 'fun',
  friday: 'fun',
  weekend: 'fun',
  coffee: 'wellbeing',
  lunch: 'wellbeing',
  lateWork: 'wellbeing',
  weekendRest: 'wellbeing',
};

export type CardKind = Exclude<PoolKind, 'idle'>;

export interface Card {
  kind: CardKind;
  /** Index in the pool of `locale`. */
  line: number;
  locale: MessageLocale;
  /** Running entry it belongs to (task@start): it goes away when that timer stops. */
  entry: string;
  shownAt: string;
  dismissed: boolean;
}

export interface MessageState {
  /** Recently shown line indices per pool, newest last. */
  recent: Partial<Record<PoolKind, number[]>>;
  /** Line of the open "Still there?" prompt (index in the idle pool), if any. */
  idleLine: number | null;
  card: Card | null;
  /** Last card shown (global rate limit). */
  lastShownAt: string | null;
  /** Slots already used (`lunch:2026-11-05`, `cheer:<entry>:2` …), newest last. */
  seen: string[];
}

export const EMPTY_MESSAGES: MessageState = { recent: {}, idleLine: null, card: null, lastShownAt: null, seen: [] };

export interface Switches {
  fun: boolean;
  wellbeing: boolean;
}

// ---- Locale and time zone -----------------------------------------------------------------------------------------

/** `es_ES`, `pt-BR`, `DE` → the pool's language, or null when there is no pool for it. */
export function normalizeLocale(value: unknown): MessageLocale | null {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return (MESSAGE_LOCALES as readonly string[]).includes(base) ? (base as MessageLocale) : null;
}

/** The Beacon user's locale (`GET me.locale`, when the server sends it), else the app's UI locale, else English. */
export function messageLocale(beaconLocale: unknown, uiLocale: unknown): MessageLocale {
  return normalizeLocale(beaconLocale) ?? normalizeLocale(uiLocale) ?? 'en';
}

const field = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined);

/** `locale` of `GET me` (passed through by the API client; absent on servers that do not send it). */
export function beaconLocale(me: unknown): unknown {
  return field(me, 'locale') ?? null;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The Beacon user's time zone: `me.workingHours.timezone`, else `me.timezone`; null = the system's. */
export function beaconTimeZone(me: unknown): string | null {
  for (const candidate of [field(field(me, 'workingHours'), 'timezone'), field(me, 'timezone')]) {
    if (isTimeZone(candidate)) return candidate;
  }
  return null;
}

/** Local date (YYYY-MM-DD), ISO weekday (1 = Monday) and minutes since midnight of `at` in `timeZone` (null = system). */
export function zonedParts(at: Date, timeZone: string | null): { date: string; day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone ?? undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** `minute` in [from, to), wrapping past midnight when `from > to`. */
export function inWindow(minute: number, [from, to]: readonly [number, number]): boolean {
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

// ---- Choosing ----------------------------------------------------------------------------------------------------

/** 0 before `CHEER_FIRST_HOURS`, then 1, 2, 3 … every `CHEER_EVERY_HOURS`. */
export function cheerStep(elapsedMinutes: number, first = CHEER_FIRST_HOURS, every = CHEER_EVERY_HOURS): number {
  if (elapsedMinutes < first * 60) return 0;
  return 1 + Math.floor((elapsedMinutes - first * 60) / (every * 60));
}

export interface PlanInput {
  now: Date;
  /** Start of the running timer (ISO). */
  startedAt: string;
  /** Running entry key (task@start). */
  entry: string;
  switches: Switches;
  windows: Windows;
  timeZone: string | null;
  state: MessageState;
}

/** Which card is due now (and the slot that marks it used), or null. */
export function planMessage(input: PlanInput): { kind: CardKind; slot: string } | null {
  const { now, switches, windows, timeZone, state } = input;
  if (!switches.fun && !switches.wellbeing) return null;
  if (state.lastShownAt !== null && now.getTime() - Date.parse(state.lastShownAt) < MIN_GAP_MINUTES * 60_000) return null;
  const start = new Date(input.startedAt);
  const elapsed = Math.max(0, (now.getTime() - start.getTime()) / 60_000);
  const today = zonedParts(now, timeZone);
  const started = zonedParts(start, timeZone);
  const weekend = today.day >= 6;
  const late = inWindow(today.minute, [windows.lateFrom, windows.lateUntil]);
  // The night after 00:00 belongs to the evening before (one late note per night).
  const evening = zonedParts(new Date(now.getTime() - windows.lateUntil * 60_000), timeZone).date;
  const step = cheerStep(elapsed);
  const candidates: [CardKind, string, boolean][] = [
    ['earlyBird', `earlyBird:${today.date}`, switches.fun && started.date === today.date && started.minute >= windows.lateUntil && started.minute < windows.earlyBefore && today.minute < windows.earlyUntil],
    ['weekend', `weekend:${today.date}`, switches.fun && weekend && elapsed < WEEKEND_START_MINUTES],
    ['lateWork', `lateWork:${evening}`, switches.wellbeing && late],
    ['weekendRest', `weekendRest:${today.date}`, switches.wellbeing && weekend && !late && elapsed >= WEEKEND_REST_AFTER_MINUTES],
    ['lunch', `lunch:${today.date}`, switches.wellbeing && inWindow(today.minute, windows.lunch)],
    ['coffee', `coffeeAm:${today.date}`, switches.wellbeing && inWindow(today.minute, windows.coffeeAm)],
    ['coffee', `coffeePm:${today.date}`, switches.wellbeing && inWindow(today.minute, windows.coffeePm)],
    ['friday', `friday:${today.date}`, switches.fun && today.day === 5 && today.minute >= windows.fridayFrom && !late],
    ['cheer', `cheer:${input.entry}:${step}`, step > 0],
  ];
  for (const [kind, slot, due] of candidates) {
    if (due && !state.seen.includes(slot)) return { kind, slot };
  }
  return null;
}

/** Whether a line may be shown with these switches. */
export function lineAllowed(kind: PoolKind, line: Line, switches: Switches): boolean {
  if (kind === 'cheer') return line.wellbeing === true ? switches.wellbeing : switches.fun;
  return KIND_GROUP[kind] === 'fun' ? switches.fun : switches.wellbeing;
}

/**
 * A random allowed line that is not among the last `NO_REPEAT` shown (`rng` is injectable for tests). When every
 * allowed line was shown recently, any allowed line but the very last one.
 */
export function pickLine(lines: readonly Line[], recent: readonly number[], rng: () => number, allowed: (line: Line) => boolean = () => true): number | null {
  const indices = lines.map((_, index) => index).filter((index) => allowed(lines[index] as Line));
  if (indices.length === 0) return null;
  const blocked = new Set(recent.slice(-NO_REPEAT));
  let choices = indices.filter((index) => !blocked.has(index));
  if (choices.length === 0) choices = indices.length > 1 ? indices.filter((index) => index !== recent[recent.length - 1]) : indices;
  const at = Math.min(choices.length - 1, Math.max(0, Math.floor(rng() * choices.length)));
  return choices[at] as number;
}

/** Recent history with `index` added (kept short). */
export function remember(recent: readonly number[] | undefined, index: number): number[] {
  return [...(recent ?? []), index].slice(-NO_REPEAT * 2);
}

export interface NextInput extends PlanInput {
  locale: MessageLocale;
  rng: () => number;
}

/** The next card and the updated state, or null when nothing is due. */
export function nextCard(input: NextInput): { state: MessageState; card: Card } | null {
  const plan = planMessage(input);
  if (plan === null) return null;
  const { state } = input;
  const lines = CATALOG[input.locale].pools[plan.kind];
  const line = pickLine(lines, state.recent[plan.kind] ?? [], input.rng, (item) => lineAllowed(plan.kind, item, input.switches));
  const seen = [...state.seen, plan.slot].slice(-SEEN_LIMIT);
  // Nothing allowed in that pool (cheer with only one switch on, every line of the other kind): mark the slot used.
  if (line === null) return nextCard({ ...input, state: { ...state, seen } });
  const card: Card = { kind: plan.kind, line, locale: input.locale, entry: input.entry, shownAt: input.now.toISOString(), dismissed: false };
  return { card, state: { ...state, card, seen, lastShownAt: card.shownAt, recent: { ...state.recent, [plan.kind]: remember(state.recent[plan.kind], line) } } };
}

/** Picks the phrasing of a new "Still there?" prompt (none with "Fun messages" off). */
export function pickIdleLine(state: MessageState, locale: MessageLocale, rng: () => number, switches: Switches): MessageState {
  if (!switches.fun) return { ...state, idleLine: null };
  const line = pickLine(CATALOG[locale].pools.idle, state.recent.idle ?? [], rng);
  return line === null ? { ...state, idleLine: null } : { ...state, idleLine: line, recent: { ...state.recent, idle: remember(state.recent.idle, line) } };
}

/** The line, with `{hours}` filled in, or null when the index no longer exists. */
export function lineText(locale: MessageLocale, kind: PoolKind, index: number, params: { hours?: number } = {}): Line | null {
  const line = CATALOG[locale].pools[kind][index];
  if (line === undefined) return null;
  return { ...line, text: line.text.replace(/\{hours\}/g, String(params.hours ?? CHEER_FIRST_HOURS)) };
}

/** The card to show for the running entry now (not dismissed, not expired, still allowed by the switches). */
export function visibleCard(state: MessageState, entry: string | null, now: Date, switches: Switches): Card | null {
  const card = state.card;
  if (card === null || card.dismissed || entry === null || card.entry !== entry) return null;
  if (now.getTime() - Date.parse(card.shownAt) >= CARD_TTL_MINUTES * 60_000) return null;
  const line = CATALOG[card.locale].pools[card.kind][card.line];
  return line !== undefined && lineAllowed(card.kind, line, switches) ? card : null;
}

/** Stored state from an older or hand-edited local storage, made safe. */
export function sanitizeMessages(raw: unknown): MessageState {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_MESSAGES };
  const value = raw as Partial<Record<keyof MessageState, unknown>>;
  const numbers = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is number => Number.isInteger(item) && item >= 0).slice(-NO_REPEAT * 2) : []);
  const recent: MessageState['recent'] = {};
  if (typeof value.recent === 'object' && value.recent !== null) {
    for (const kind of POOL_KINDS) {
      const list = numbers((value.recent as Record<string, unknown>)[kind]);
      if (list.length > 0) recent[kind] = list;
    }
  }
  const card = value.card as Partial<Card> | null | undefined;
  const validCard =
    typeof card === 'object' &&
    card !== null &&
    typeof card.kind === 'string' &&
    (card.kind as string) !== 'idle' &&
    (POOL_KINDS as readonly string[]).includes(card.kind) &&
    normalizeLocale(card.locale) === card.locale &&
    Number.isInteger(card.line) &&
    typeof card.entry === 'string' &&
    typeof card.shownAt === 'string' &&
    !Number.isNaN(Date.parse(card.shownAt));
  return {
    recent,
    idleLine: Number.isInteger(value.idleLine) && (value.idleLine as number) >= 0 ? (value.idleLine as number) : null,
    card: validCard ? ({ ...(card as Card), dismissed: card.dismissed === true } as Card) : null,
    lastShownAt: typeof value.lastShownAt === 'string' && !Number.isNaN(Date.parse(value.lastShownAt)) ? value.lastShownAt : null,
    seen: Array.isArray(value.seen) ? value.seen.filter((slot): slot is string => typeof slot === 'string').slice(-SEEN_LIMIT) : [],
  };
}
