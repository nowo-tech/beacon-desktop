import type { Task } from '../api/types';
import type { MessageLocale } from './friendly';
import * as de from './messages/de';
import * as en from './messages/en';
import * as es from './messages/es';
import * as fr from './messages/fr';
import * as it from './messages/it';
import * as nl from './messages/nl';
import * as pt from './messages/pt';
import type { MeetingAction, MeetingCatalog, PoseId } from './messages/types';
import { type DayPlan, minutesOf } from './schedule';

/**
 * Meeting detection (opt-in, local only). The host says every `MIC_POLL_SECONDS` whether the microphone is in use and
 * which known meeting apps hold it (src-tauri/src/meeting: app ids only, never window titles, URLs, chats or audio).
 * When a call has lasted `minMinutes`, the app asks once what to record it as; when the microphone is released for
 * `END_GRACE_MS`, it offers to go back to the previous task. Pure functions; the app keeps the state in local storage
 * (`LocalState.meeting`) and nothing about it is sent (only the timer actions the person chooses).
 */

export const MEETING_APPS = ['teams', 'zoom', 'webex', 'slack', 'discord', 'skype', 'goto', 'jitsi', 'browser'] as const;
export type MeetingApp = (typeof MEETING_APPS)[number];

/** Display names (a browser call is named per locale, `MeetingCatalog.browser`). */
export const APP_NAMES: Record<Exclude<MeetingApp, 'browser'>, string> = {
  teams: 'Teams',
  zoom: 'Zoom',
  webex: 'Webex',
  slack: 'Slack',
  discord: 'Discord',
  skype: 'Skype',
  goto: 'GoTo',
  jitsi: 'Jitsi Meet',
};

export const MEETINGS: Record<MessageLocale, MeetingCatalog> = {
  en: en.meetings,
  es: es.meetings,
  de: de.meetings,
  fr: fr.meetings,
  it: it.meetings,
  nl: nl.meetings,
  pt: pt.meetings,
};

/** How often the host looks at the microphone while the feature is on (it clamps to 15–30 s). */
export const MIC_POLL_SECONDS = 20;
/** "Ask after a call of …" choices (minutes) and the default. */
export const MIN_CALL_CHOICES: readonly number[] = [1, 2, 5, 10];
export const DEFAULT_MIN_CALL_MINUTES = 2;
/** The microphone must stay free this long before a call counts as over (a device switch is not the end). */
export const END_GRACE_MS = 60_000;
/** At most one meeting question this often. */
export const ASK_GAP_MINUTES = 10;
/** The end-of-meeting question goes away by itself after this long. */
export const ENDED_TTL_MINUTES = 30;
/** Pose of both questions. */
export const MEETING_POSE: PoseId = 'teamwork';

/** A `mic` event of the host. */
export interface MicSignal {
  /** Unix ms of the probe. */
  at: number;
  /** Something records from the microphone (a meeting app or not). */
  inUse: boolean;
  /** Known meeting apps holding it. */
  apps: MeetingApp[];
  /** `process`: the OS named the apps; `fallback`: guessed from the running apps; `unavailable`: not readable. */
  source: 'process' | 'fallback' | 'unavailable';
}

const SOURCES: readonly string[] = ['process', 'fallback', 'unavailable'];

/** A host event checked field by field (anything unexpected is dropped). */
export function parseMicSignal(raw: unknown): MicSignal | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at) || typeof value.inUse !== 'boolean' || !Array.isArray(value.apps)) return null;
  const apps = MEETING_APPS.filter((app) => (value.apps as unknown[]).includes(app));
  const source = SOURCES.includes(value.source as string) ? (value.source as MicSignal['source']) : 'process';
  return { at: value.at, inUse: value.inUse || apps.length > 0, apps, source };
}

export interface TaskRef {
  id: string;
  title: string;
}

/**
 * - `idle`: no call.
 * - `starting`: a meeting app holds the microphone since `since`; asked once it lasted `minMinutes`.
 * - `asking`: the question is open.
 * - `ignored`: no question for this call ("Not a meeting", "Don't ask for this app", dismissed, or a meeting task
 *   was already running).
 * - `tracking`: the person picked the meeting's task (`task`); `previous` was running before.
 * - `ended`: the call is over; "Back to `previous`?" / "Stop?" is open.
 */
export type MeetingPhase = 'idle' | 'starting' | 'asking' | 'ignored' | 'tracking' | 'ended';

export interface MeetingState {
  phase: MeetingPhase;
  app: MeetingApp | null;
  /** First probe of the call (ISO). */
  since: string | null;
  /** The microphone was released at this instant and not taken back yet (ISO). */
  releasedAt: string | null;
  /** Last meeting question (rate limit, ISO). */
  askedAt: string | null;
  /** End of the call (`ended`, ISO). */
  endedAt: string | null;
  task: TaskRef | null;
  previous: TaskRef | null;
}

export const NO_MEETING: MeetingState = { phase: 'idle', app: null, since: null, releasedAt: null, askedAt: null, endedAt: null, task: null, previous: null };

export interface MeetingContext {
  /** Ask after a call of this many minutes. */
  minMinutes: number;
  /** "Don't ask for this app". */
  muted: readonly MeetingApp[];
  /** The running timer and whether its task is meeting-like (`taskKind`). */
  running: (TaskRef & { meeting: boolean }) | null;
  /** No question now: friendly messages paused, outside working hours, another question open. */
  quiet: boolean;
}

/** `ask`: show the question; `ended`: show the end-of-meeting one; `clear`: take an open question away. */
export type MeetingEffect = 'none' | 'ask' | 'ended' | 'clear';

const iso = (ms: number) => new Date(ms).toISOString();
const since = (value: string | null, at: number) => (value === null ? 0 : at - Date.parse(value));

/** The app of a new call: a known app not muted, dedicated apps before a browser. */
export function callApp(signal: MicSignal, muted: readonly MeetingApp[]): MeetingApp | null {
  return MEETING_APPS.find((app) => signal.apps.includes(app) && !muted.includes(app)) ?? null;
}

const idle = (state: MeetingState): MeetingState => ({ ...NO_MEETING, askedAt: state.askedAt });

/** One probe of the host: the next state and what to show. */
export function observeMic(state: MeetingState, signal: MicSignal, ctx: MeetingContext): { state: MeetingState; effect: MeetingEffect } {
  const at = signal.at;
  const held = signal.apps.length > 0;
  const fresh = callApp(signal, ctx.muted);
  // A new call: no question when a meeting-like task already runs.
  const begin = (app: MeetingApp): MeetingState => ({ ...idle(state), phase: ctx.running?.meeting === true ? 'ignored' : 'starting', app, since: iso(at) });
  // The microphone went free: the call ends once it stays free for `END_GRACE_MS`.
  const release = (current: MeetingState): { state: MeetingState; over: boolean } => {
    if (held) return { state: current.releasedAt === null ? current : { ...current, releasedAt: null }, over: false };
    const releasedAt = current.releasedAt ?? iso(at);
    return { state: { ...current, releasedAt }, over: at - Date.parse(releasedAt) >= END_GRACE_MS };
  };
  switch (state.phase) {
    case 'idle':
      return { state: fresh === null ? state : begin(fresh), effect: 'none' };
    case 'starting': {
      if (state.app !== null && ctx.muted.includes(state.app)) return { state: { ...state, phase: 'ignored' }, effect: 'none' };
      const step = release(state);
      if (step.over) return { state: idle(state), effect: 'none' };
      if (ctx.running?.meeting === true) return { state: { ...step.state, phase: 'ignored' }, effect: 'none' };
      const long = since(state.since, at) >= ctx.minMinutes * 60_000;
      const rested = state.askedAt === null || since(state.askedAt, at) >= ASK_GAP_MINUTES * 60_000;
      if (long && step.state.releasedAt === null && rested && !ctx.quiet) {
        return { state: { ...step.state, phase: 'asking', askedAt: iso(at) }, effect: 'ask' };
      }
      return { state: step.state, effect: 'none' };
    }
    case 'asking': {
      const step = release(state);
      if (step.over) return { state: idle(state), effect: 'clear' };
      // A meeting task was started by hand meanwhile: that is the answer.
      if (ctx.running?.meeting === true) return { state: { ...step.state, phase: 'tracking', task: { id: ctx.running.id, title: ctx.running.title }, previous: null }, effect: 'clear' };
      return { state: step.state, effect: 'none' };
    }
    case 'ignored': {
      const step = release(state);
      return { state: step.over ? idle(state) : step.state, effect: 'none' };
    }
    case 'tracking': {
      const step = release(state);
      if (!step.over) return { state: step.state, effect: 'none' };
      // Only while the meeting's task still runs (stopped or switched by hand: nothing to ask).
      if (ctx.running?.id !== state.task?.id || ctx.quiet) return { state: idle(state), effect: 'none' };
      return { state: { ...step.state, phase: 'ended', endedAt: step.state.releasedAt, releasedAt: null }, effect: 'ended' };
    }
    case 'ended': {
      const stale = since(state.endedAt, at) >= ENDED_TTL_MINUTES * 60_000 || ctx.running?.id !== state.task?.id;
      // A new call or a stale question (expired, the timer changed by hand) takes it away.
      if (!stale && fresh === null) return { state, effect: 'none' };
      return { state: fresh === null ? idle(state) : begin(fresh), effect: 'clear' };
    }
  }
}

/** The person picked the meeting's task (from the question, the generic meeting or "Switch to the meeting"). */
export function tracking(state: MeetingState, task: TaskRef, previous: TaskRef | null): MeetingState {
  return { ...state, phase: 'tracking', task, previous: previous !== null && previous.id !== task.id ? previous : null };
}

/** No question for the rest of this call. */
export function ignoreCall(state: MeetingState): MeetingState {
  return state.phase === 'idle' ? state : { ...state, phase: 'ignored' };
}

/** The end-of-meeting question was answered or dismissed. */
export function finishMeeting(state: MeetingState): MeetingState {
  return idle(state);
}

/** Whether a call is going on that is (or may be) a meeting: the softer "Still in the meeting?" applies. */
export function inCall(state: MeetingState): boolean {
  return (state.phase === 'starting' || state.phase === 'asking' || state.phase === 'tracking') && state.releasedAt === null;
}

/** Minutes of the call, at least 1. */
export function callMinutes(state: MeetingState): number {
  if (state.since === null || state.endedAt === null) return 1;
  return Math.max(1, Math.round((Date.parse(state.endedAt) - Date.parse(state.since)) / 60_000));
}

/** The app's name in `locale` ("Teams", "llamada en el navegador"). */
export function appName(app: MeetingApp, locale: MessageLocale): string {
  return app === 'browser' ? MEETINGS[locale].browser : APP_NAMES[app];
}

/** Notification button ids (the host only accepts these, src-tauri/src/notify.rs). */
export const MEETING_ACTION_IDS: Partial<Record<MeetingAction, string>> = { generic: 'meeting-generic', switch: 'meeting-switch', back: 'meeting-back', stop: 'meeting-stop' };

export function meetingActionOfId(id: unknown): MeetingAction | null {
  const entry = Object.entries(MEETING_ACTION_IDS).find(([, value]) => value === id);
  return entry !== undefined ? (entry[0] as MeetingAction) : null;
}

/** A meeting question ready to show: as a desktop notification (one button) or in the window (every button). */
export interface MeetingNote {
  kind: 'ask' | 'ended';
  title: string;
  text: string;
  pose: PoseId;
  locale: MessageLocale;
  /** Buttons in the window, in order. */
  actions: MeetingAction[];
  /** The one button of the desktop notification, if any (a click on the notification opens the window). */
  native: MeetingAction | null;
  labels: Record<MeetingAction, string>;
}

const fill = (text: string, params: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));

/**
 * "Looks like you're in a meeting (Teams). Which meeting is it?" With a non-meeting timer running, it offers to
 * switch ("Switch to the meeting"); the notification's button is the generic meeting (or the switch) when one is set.
 */
export function askNote(locale: MessageLocale, app: MeetingApp, running: TaskRef | null, generic: TaskRef | null): MeetingNote {
  const catalog = MEETINGS[locale];
  const name = appName(app, locale);
  const primary: MeetingAction = running !== null ? 'switch' : 'generic';
  return {
    kind: 'ask',
    title: catalog.titles.ask,
    text: running !== null ? fill(catalog.askSwitch, { app: name, task: running.title }) : fill(catalog.ask, { app: name }),
    pose: MEETING_POSE,
    locale,
    actions: running !== null ? ['switch', 'choose', 'notMeeting', 'mute'] : ['choose', 'generic', 'notMeeting', 'mute'],
    native: generic !== null ? primary : null,
    labels: catalog.actions,
  };
}

/** "Meeting over (32 min). Back to <previous>?" with Back and Stop, or "Stop the timer?" with nothing to go back to. */
export function endedNote(locale: MessageLocale, minutes: number, previous: TaskRef | null): MeetingNote {
  const catalog = MEETINGS[locale];
  return {
    kind: 'ended',
    title: catalog.titles.ended,
    text: previous !== null ? fill(catalog.ended, { minutes, task: previous.title }) : fill(catalog.endedStop, { minutes }),
    pose: MEETING_POSE,
    locale,
    actions: previous !== null ? ['back', 'stop'] : ['stop'],
    native: previous !== null ? 'back' : 'stop',
    labels: catalog.actions,
  };
}

/** Candidate tasks for "Choose task": meeting-like ones first, then pinned, then recent; each once, at most `limit`. */
export function meetingCandidates(groups: readonly (readonly Task[])[], isMeeting: (task: Task) => boolean, exclude: string | null, limit = 9): Task[] {
  const seen = new Set<string>(exclude !== null ? [exclude] : []);
  const all: Task[] = [];
  for (const group of groups) {
    for (const task of group) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      all.push(task);
    }
  }
  return [...all.filter(isMeeting), ...all.filter((task) => !isMeeting(task))].slice(0, limit);
}

/** Tasks whose title contains `query` (case and accents ignored). */
export function searchTasks(tasks: readonly Task[], query: string, limit = 9): Task[] {
  const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const wanted = fold(query.trim());
  if (wanted === '') return [];
  return tasks.filter((task) => fold(task.title).includes(wanted)).slice(0, limit);
}

/**
 * Within the person's working day (no question outside it): not a day off, and inside start–end when the day has
 * them. A day without hours (no schedule known) counts as working time.
 */
export function withinWorkingDay(day: DayPlan | undefined, minute: number, dayOff: boolean): boolean {
  if (dayOff || day?.off === true) return false;
  if (day === undefined || day.start === null || day.end === null) return true;
  return minute >= minutesOf(day.start) && minute < minutesOf(day.end);
}

/** Stored state from an older or hand-edited local storage, made safe. */
export function sanitizeMeeting(raw: unknown): MeetingState {
  if (typeof raw !== 'object' || raw === null) return { ...NO_MEETING };
  const value = raw as Record<string, unknown>;
  const phases: readonly string[] = ['idle', 'starting', 'asking', 'ignored', 'tracking', 'ended'];
  const date = (field: unknown) => (typeof field === 'string' && !Number.isNaN(Date.parse(field)) ? field : null);
  const phase = phases.includes(value.phase as string) ? (value.phase as MeetingPhase) : 'idle';
  const app = (MEETING_APPS as readonly string[]).includes(value.app as string) ? (value.app as MeetingApp) : null;
  const state: MeetingState = {
    phase,
    app,
    since: date(value.since),
    releasedAt: date(value.releasedAt),
    askedAt: date(value.askedAt),
    endedAt: date(value.endedAt),
    task: sanitizeTaskRef(value.task),
    previous: sanitizeTaskRef(value.previous),
  };
  const complete = phase === 'idle' || (app !== null && state.since !== null && (phase !== 'tracking' || state.task !== null) && (phase !== 'ended' || (state.task !== null && state.endedAt !== null)));
  return complete ? state : { ...NO_MEETING, askedAt: state.askedAt };
}

/** A stored "Don't ask for this app" list, made safe. */
export function sanitizeMuted(raw: unknown): MeetingApp[] {
  return Array.isArray(raw) ? MEETING_APPS.filter((app) => raw.includes(app)) : [];
}

/** A stored generic meeting task, made safe. */
export function sanitizeTaskRef(raw: unknown): TaskRef | null {
  const item = raw as Partial<TaskRef> | null;
  return typeof item === 'object' && item !== null && typeof item.id === 'string' && typeof item.title === 'string' ? { id: item.id, title: item.title } : null;
}
