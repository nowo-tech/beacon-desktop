import type { Task } from '../api/types';
import { type MessageLocale, pickLine, remember, zonedParts } from './friendly';
import * as de from './messages/de';
import * as en from './messages/en';
import * as es from './messages/es';
import * as fr from './messages/fr';
import * as it from './messages/it';
import * as nl from './messages/nl';
import * as pt from './messages/pt';
import type { NudgeCatalog, PoseId } from './messages/types';
import { type DayOff, dayOffOn, minutesOf, type Week, weekdayOf } from './schedule';

/**
 * "Working without a timer?": during working hours (Beacon's schedule with the local overrides, never on a day off or
 * during the lunch break), when there was keyboard / mouse input for `minutes` in a row and no timer runs, a friendly
 * notification offers "Start <last task>" and "Choose task". At most once every `NUDGE_EVERY_MINUTES`.
 *
 * Privacy: the only input is the OS "seconds since last input" counter, read on this computer at each 30 s check. It
 * is not stored (only the start of the current stretch and the time of the last nudge are kept, locally), logged or
 * sent; nothing reaches the server unless the person starts a timer.
 */

/** "Remind me after" choices in Settings (minutes of activity without a timer). */
export const NUDGE_MINUTES_CHOICES: readonly number[] = [5, 10, 15, 20, 30];
export const DEFAULT_NUDGE_MINUTES = 10;
/** At most one nudge in this many minutes. */
export const NUDGE_EVERY_MINUTES = 45;
/** No input for this long breaks the stretch (a coffee, a read, a call). */
export const BREAK_SECONDS = 180;

/** Notification buttons (the host only accepts these, src-tauri/src/notify.rs). */
export const NUDGE_IDS = { resume: 'nudge-resume', choose: 'nudge-choose' } as const;
export type NudgeAction = keyof typeof NUDGE_IDS;

export function nudgeActionOf(id: unknown): NudgeAction | null {
  return id === NUDGE_IDS.resume ? 'resume' : id === NUDGE_IDS.choose ? 'choose' : null;
}

export const NUDGES: Record<MessageLocale, NudgeCatalog> = { en: en.nudge, es: es.nudge, de: de.nudge, fr: fr.nudge, it: it.nudge, nl: nl.nudge, pt: pt.nudge };

export interface NudgeState {
  /** Start of the current stretch of input without a timer (ISO), if any. */
  activeSince: string | null;
  /**
   * The counter read more than 0 during the stretch. Some systems (a few Wayland sessions) always report 0: that is
   * "cannot tell", not "always typing", and never nudges.
   */
  measured: boolean;
  /** Last nudge (ISO), for the rate limit. */
  lastAt: string | null;
  /** Recently used lines (no repeats). */
  recent: number[];
}

export const EMPTY_NUDGE: NudgeState = { activeSince: null, measured: false, lastAt: null, recent: [] };

export function sanitizeNudge(value: unknown): NudgeState {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof NudgeState, unknown>>;
  const time = (item: unknown) => (typeof item === 'string' && !Number.isNaN(Date.parse(item)) ? item : null);
  return {
    activeSince: time(raw.activeSince),
    measured: raw.measured === true,
    lastAt: time(raw.lastAt),
    recent: Array.isArray(raw.recent) ? raw.recent.filter((item): item is number => Number.isInteger(item)).slice(-12) : [],
  };
}

export interface ActivityInput {
  now: Date;
  /** OS seconds since the last input; `null` when it was not read (the conditions below do not hold). */
  idleSeconds: number | null;
  /** The setting is on, the person is signed in and the friendly messages are not paused. */
  enabled: boolean;
  running: boolean;
  /** Inside working hours now (`workingNow`). */
  working: boolean;
  /** The "Still there?" prompt or its follow-up is open. */
  prompting: boolean;
  minutes: number;
}

/** Whether the counter is worth reading at this check (otherwise the stretch just ends). */
export function watchingActivity(input: Omit<ActivityInput, 'idleSeconds' | 'now'>): boolean {
  return input.enabled && !input.running && input.working && !input.prompting;
}

/** One check: the updated state and whether to nudge now. */
export function observeActivity(state: NudgeState, input: ActivityInput): { state: NudgeState; fire: boolean } {
  if (!watchingActivity(input) || input.idleSeconds === null || input.idleSeconds >= BREAK_SECONDS) {
    return { state: state.activeSince === null && !state.measured ? state : { ...state, activeSince: null, measured: false }, fire: false };
  }
  const now = input.now.getTime();
  const since = state.activeSince !== null ? Date.parse(state.activeSince) : now;
  const next = { ...state, activeSince: new Date(Math.min(since, now)).toISOString(), measured: state.measured || input.idleSeconds > 0 };
  const long = next.measured && now - since >= input.minutes * 60_000;
  const rested = state.lastAt === null || now - Date.parse(state.lastAt) >= NUDGE_EVERY_MINUTES * 60_000 || Date.parse(state.lastAt) > now;
  if (!long || !rested) return { state: next, fire: false };
  return { state: { ...next, activeSince: null, measured: false, lastAt: input.now.toISOString() }, fire: true };
}

/** Inside the working hours of `week` at `now`: a working day, not a day off, between start and end, not at lunch. */
export function workingNow(input: { now: Date; timeZone: string | null; week: Week; daysOff: readonly DayOff[] }): boolean {
  const { date, minute } = zonedParts(input.now, input.timeZone);
  if (dayOffOn(date, input.daysOff) !== null) return false;
  const plan = input.week[weekdayOf(date)];
  if (plan.off || plan.start === null || plan.end === null) return false;
  if (minute < minutesOf(plan.start) || minute >= minutesOf(plan.end)) return false;
  const lunch = plan.lunchStart !== null && plan.lunchEnd !== null ? [minutesOf(plan.lunchStart), minutesOf(plan.lunchEnd)] : null;
  return lunch === null || minute < lunch[0]! || minute >= lunch[1]!;
}

export interface NudgeNote {
  title: string;
  text: string;
  pose: PoseId;
  locale: MessageLocale;
  /** "Start <task>" (none without a last task, or when it was a meeting: a meeting rarely goes on). */
  resume: { id: string; label: string; task: Task } | null;
  choose: { id: string; label: string };
  shownAt: string;
}

const fill = (text: string, task: string) => text.replace(/\{task\}/g, task);

/** The note and the updated line history. `lastIsMeeting`: the last task is meeting-like (no "Start" button then). */
export function composeNudge(input: { locale: MessageLocale; rng: () => number; now: Date; last: Task | null; lastIsMeeting: boolean; state: NudgeState }): { note: NudgeNote; state: NudgeState } {
  const catalog = NUDGES[input.locale];
  const index = pickLine(catalog.lines, input.state.recent, input.rng) as number;
  const line = catalog.lines[index]!;
  const last = input.last;
  const resume = last !== null && !input.lastIsMeeting ? { id: NUDGE_IDS.resume, label: fill(catalog.actions.resume, last.title), task: last } : null;
  return {
    note: {
      title: catalog.title,
      text: last !== null ? `${line.text} ${fill(catalog.lastTask, last.title)}` : line.text,
      pose: line.pose,
      locale: input.locale,
      resume,
      choose: { id: NUDGE_IDS.choose, label: catalog.actions.choose },
      shownAt: input.now.toISOString(),
    },
    state: { ...input.state, recent: remember(input.state.recent, index) },
  };
}
