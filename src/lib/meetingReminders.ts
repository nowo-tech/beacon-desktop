import type { Me, Scope } from '../api/types';
import { MEETINGS_SCOPE } from '../api/types';
import type { MessageLocale } from './friendly';
import { type JoinProvider, meetingJoinUrl } from './links';
import { MEETING_REMINDERS } from './messages/meetingReminders';
import type { PoseId } from './messages/types';

/**
 * Meeting reminders (contract §23, spec 210 FR-008 / FR-009 / FR-011). Beacon keeps the person's meetings (TimeTrack
 * 1.14 `GET me/meetings`); this app fetches today's and tomorrow's, keeps them for at most 48 h and reminds before each
 * one, on this computer only. Pure functions: the app (`src/ui/app.ts`) keeps the state, `MeetingStore` below the
 * local storage.
 *
 * Privacy: nothing about meetings is logged or sent back (only the timer action the person picks). The dedupe store
 * holds hashes and times, never a title, a link or an id; the cached list is wiped on sign-out, on an account switch
 * and when the reminders are turned off.
 */

/** Lead-time presets of Settings (minutes); 0 = no reminder before the meeting. Any whole 1–120 is accepted too. */
export const LEAD_PRESETS: readonly number[] = [0, 1, 2, 5, 10, 15, 30];
export const DEFAULT_LEAD_MINUTES = 5;
export const MIN_CUSTOM_LEAD = 1;
export const MAX_CUSTOM_LEAD = 120;
/** The start prompt may fire this long after the start (rule 5), and microphone detection stays quiet this long around it (Q-O20). */
export const START_WINDOW_MINUTES = 10;
/** Polling: never more often than the server's hint or 300 s, never twice within 60 s, ±10 % jitter. */
export const MIN_POLL_SECONDS = 300;
export const MIN_GAP_SECONDS = 60;
export const JITTER = 0.1;
/** Repeated 429 / 503: the wait doubles, up to 30 minutes. */
export const MAX_BACKOFF_SECONDS = 1800;
/** First wait after a failure without `Retry-After`. */
export const FIRST_BACKOFF_SECONDS = 60;
/** Outside working hours one fetch this long before the next working slot covers the first meeting of the day. */
export const PRE_SLOT_MINUTES = 120;
/** A list older than this is "(may be outdated)". */
export const STALE_MINUTES = 60;
/** The cached list never outlives this. */
export const MAX_CACHE_HOURS = 48;
/** Dedupe entries go 24 h after their meeting's start; at most 500 are kept. */
export const PRUNE_HOURS = 24;
export const MAX_MARKS = 500;
/** More reminders than this in the same minute become one grouped notification. */
export const GROUP_OVER = 3;
/** `GET me` is checked again this often while the feature is off or no calendar is connected. */
export const RECHECK_ME_MINUTES = 30;
/** At most this many meetings in the tray submenu. */
export const MAX_TRAY_MEETINGS = 7;

const MINUTE = 60_000;
const ID = /^mtg_[A-Za-z0-9_-]{16,64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z$/;
const TASK_ID = /^[\w.:-]{1,200}$/;

export type SyncStatus = 'connected' | 'not_connected' | 'needs_reconnect' | 'syncing';
const SYNC_STATUSES: readonly string[] = ['connected', 'not_connected', 'needs_reconnect', 'syncing'];

export interface MeetingAttendee {
  id: string;
  name: string;
}

export interface MeetingTaskLink {
  taskId: string;
  key: string;
}

/** One meeting as this app keeps it (times in Unix ms). Private meetings have no title ("Busy"). */
export interface Meeting {
  id: string;
  start: number;
  end: number;
  allDay: boolean;
  busy: boolean;
  private: boolean;
  title: string | null;
  joinUrl: string | null;
  joinProvider: JoinProvider | null;
  attendees: MeetingAttendee[];
  externalCount: number | null;
  taskLinks: MeetingTaskLink[];
}

/** A meeting with its dedupe key (`sha256(id + "|" + start)`, hex). */
export interface KeyedMeeting extends Meeting {
  key: string;
}

export interface MeetingsPage {
  status: SyncStatus;
  refreshAfterSeconds: number;
  truncated: boolean;
  meetings: Meeting[];
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  // Control, bidi (overrides, isolates and the LRM / RLM / ALM marks) and zero-width characters out (the server strips
  // most of them too); they could reorder or hide text in notifications and the tray (audit GO-I5).
  const clean = value.replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF]/gu, '').trim();
  return clean === '' ? null : clean.slice(0, max);
};
const instant = (value: unknown): number | null => (typeof value === 'string' && UTC.test(value) ? Date.parse(value) : null);

/** `refreshAfterSeconds` bounded as the server does (60–3600), 300 when absent. */
export function refreshHint(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(3600, Math.max(60, Math.round(value))) : MIN_POLL_SECONDS;
}

/** One meeting of the response checked field by field; `null` drops it (unknown id, bad times, longer than 24 h). */
export function parseMeeting(raw: unknown): Meeting | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const start = instant(value.start);
  const end = instant(value.end);
  if (typeof value.id !== 'string' || !ID.test(value.id) || start === null || end === null || end <= start || end - start > 24 * 60 * MINUTE) return null;
  const isPrivate = value.private === true;
  const join = meetingJoinUrl(value.joinUrl);
  const attendees = !isPrivate && Array.isArray(value.attendees)
    ? value.attendees
        .map((item) => {
          const person = item as Record<string, unknown> | null;
          const id = typeof person?.id === 'string' ? person.id.slice(0, 64) : null;
          const name = text(person?.name, 120);
          return id !== null && name !== null ? { id, name } : null;
        })
        .filter((item): item is MeetingAttendee => item !== null)
        .slice(0, 50)
    : [];
  const taskLinks = !isPrivate && Array.isArray(value.taskLinks)
    ? value.taskLinks
        .map((item) => {
          const link = item as Record<string, unknown> | null;
          return typeof link?.taskId === 'string' && TASK_ID.test(link.taskId) ? { taskId: link.taskId, key: text(link.key, 40) ?? link.taskId } : null;
        })
        .filter((item): item is MeetingTaskLink => item !== null)
    : [];
  const external = value.externalCount;
  return {
    id: value.id,
    start,
    end,
    allDay: value.allDay === true,
    // Only `busy: false` (free / transparent) is free; a missing flag counts as busy.
    busy: value.busy !== false,
    private: isPrivate,
    title: isPrivate ? null : text(value.title, 200),
    joinUrl: join?.url ?? null,
    joinProvider: join?.provider ?? null,
    attendees,
    externalCount: !isPrivate && typeof external === 'number' && Number.isInteger(external) && external >= 0 ? external : null,
    taskLinks,
  };
}

/** A `GET me/meetings` answer, or `null` when it is not one. */
export function parseMeetingsPage(raw: unknown): MeetingsPage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.meetings)) return null;
  const sync = (typeof value.sync === 'object' && value.sync !== null ? value.sync : {}) as Record<string, unknown>;
  const status = SYNC_STATUSES.includes(sync.status as string) ? (sync.status as SyncStatus) : 'connected';
  const seen = new Set<string>();
  const meetings = value.meetings
    .map(parseMeeting)
    .filter((item): item is Meeting => item !== null && !seen.has(`${item.id}|${item.start}`) && seen.add(`${item.id}|${item.start}`) !== undefined)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return { status, refreshAfterSeconds: refreshHint(sync.refreshAfterSeconds), truncated: value.truncated === true, meetings };
}

/** Lowercase hex SHA-256 of `value` (Web Crypto, in the webview and in Node). */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Dedupe key of a meeting occurrence (FR-011): a moved meeting (new start) gets a new key, a new title does not. */
export function dedupeSource(meeting: Pick<Meeting, 'id' | 'start'>): string {
  return `${meeting.id}|${new Date(meeting.start).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

export async function withKeys(meetings: readonly Meeting[]): Promise<KeyedMeeting[]> {
  return Promise.all(meetings.map(async (meeting) => ({ ...meeting, key: await sha256Hex(dedupeSource(meeting)) })));
}

/** The short form of a key used in notification button ids (`meeting-join:<16 hex>`). */
export const shortKey = (key: string): string => key.slice(0, 16);

// ---- Server support ------------------------------------------------------------------------------------------------

/**
 * What the server offers this person (contract §23.1):
 * - `unsupported`: no `features.meetings` (TimeTrack < 1.14, or the feature off on the server);
 * - `consent`: offered, but this sign-in lacks `meetings:read` (one re-consent, §23.7);
 * - `on`: offered and allowed, with Beacon's sync state and the *Calendars* page.
 */
export type MeetingSupport =
  | { kind: 'unsupported' }
  | { kind: 'consent'; calendarsUrl: string | null }
  | { kind: 'on'; status: SyncStatus; refreshAfterSeconds: number; calendarsUrl: string | null };

export function meetingSupport(me: Pick<Me, 'features' | 'meetings' | 'links' | 'scopes'> | null, sessionScopes: readonly Scope[] = []): MeetingSupport {
  if (me === null || me.features?.meetings !== true) return { kind: 'unsupported' };
  const raw = me.links?.calendars;
  let calendarsUrl: string | null;
  try {
    // Opened only through the Beacon link rule (same origin as the server, https; loopback http in development).
    calendarsUrl = typeof raw === 'string' && /^https?:$/.test(new URL(raw).protocol) ? new URL(raw).href : null;
  } catch {
    calendarsUrl = null;
  }
  const scopes = me.scopes.length > 0 ? me.scopes : sessionScopes;
  if (!scopes.includes(MEETINGS_SCOPE)) return { kind: 'consent', calendarsUrl };
  const status = SYNC_STATUSES.includes(me.meetings?.status as string) ? (me.meetings?.status as SyncStatus) : 'connected';
  return { kind: 'on', status, refreshAfterSeconds: refreshHint(me.meetings?.refreshAfterSeconds), calendarsUrl };
}

/** A calendar is connected in Beacon (the reminders' default, Q-O18). */
export const calendarConnected = (status: SyncStatus): boolean => status !== 'not_connected';

// ---- Settings ------------------------------------------------------------------------------------------------------

export interface ReminderSettings {
  /** `null`: the default, on when a calendar is connected in Beacon (Q-O18). */
  meetingReminders: boolean | null;
  /** Minutes before the start; 0 = no reminder before (the start prompt still applies). */
  meetingLeadMinutes: number;
  meetingOutsideHours: boolean;
  meetingDaysOff: boolean;
  meetingAskOnStart: boolean;
  meetingAutoPause: boolean;
  /** The main window's "Allow TimeTrack to read your upcoming meetings" card was answered (shown once, §23.7). */
  meetingConsentSeen: boolean;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  meetingReminders: null,
  meetingLeadMinutes: DEFAULT_LEAD_MINUTES,
  meetingOutsideHours: false,
  meetingDaysOff: false,
  meetingAskOnStart: true,
  meetingAutoPause: false,
  meetingConsentSeen: false,
};

/** A lead time from Settings or storage: 0 or a whole 1–120, else the default. */
export function sanitizeLead(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && (value === 0 || (value >= MIN_CUSTOM_LEAD && value <= MAX_CUSTOM_LEAD)) ? value : DEFAULT_LEAD_MINUTES;
}

export function sanitizeReminderSettings(raw: Partial<Record<keyof ReminderSettings, unknown>> | undefined): ReminderSettings {
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  return {
    meetingReminders: typeof raw?.meetingReminders === 'boolean' ? raw.meetingReminders : null,
    meetingLeadMinutes: sanitizeLead(raw?.meetingLeadMinutes),
    meetingOutsideHours: flag(raw?.meetingOutsideHours, false),
    meetingDaysOff: flag(raw?.meetingDaysOff, false),
    meetingAskOnStart: flag(raw?.meetingAskOnStart, true),
    meetingAutoPause: flag(raw?.meetingAutoPause, false),
    meetingConsentSeen: raw?.meetingConsentSeen === true,
  };
}

/** Whether the reminders are on: the person's choice, else on when a calendar is connected. */
export function remindersEnabled(setting: boolean | null, support: MeetingSupport): boolean {
  if (support.kind !== 'on') return false;
  return setting ?? calendarConnected(support.status);
}

// ---- Dedupe store --------------------------------------------------------------------------------------------------

/** One reminded occurrence (contract §23.6): hashed key, times only. */
export interface ReminderMark {
  key: string;
  /** Start of the meeting (ISO), for pruning. */
  start: string;
  firedAt: string | null;
  snoozedUntil?: string | null;
  /** The start prompt (or the automatic pause) was shown for it. */
  prompted?: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;
const iso = (value: unknown): string | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);

export function sanitizeMarks(raw: unknown): ReminderMark[] {
  if (!Array.isArray(raw)) return [];
  const marks: ReminderMark[] = [];
  for (const item of raw) {
    const value = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const start = iso(value.start);
    if (typeof value.key !== 'string' || !HEX64.test(value.key) || start === null) continue;
    marks.push({ key: value.key, start, firedAt: iso(value.firedAt), snoozedUntil: iso(value.snoozedUntil), prompted: value.prompted === true });
  }
  return marks.slice(-MAX_MARKS);
}

/** Marks without the ones 24 h past their start, newest 500. */
export function pruneMarks(marks: readonly ReminderMark[], now: number): ReminderMark[] {
  return marks.filter((mark) => now - Date.parse(mark.start) < PRUNE_HOURS * 60 * MINUTE).slice(-MAX_MARKS);
}

/** `marks` with `mark` replacing the one of its key. */
export function putMark(marks: readonly ReminderMark[], mark: ReminderMark): ReminderMark[] {
  return [...marks.filter((item) => item.key !== mark.key), mark].slice(-MAX_MARKS);
}

const markOf = (marks: readonly ReminderMark[], key: string) => marks.find((mark) => mark.key === key);

// ---- Scheduling ----------------------------------------------------------------------------------------------------

/** Working hours and days off of the person (Settings → My schedule), read at an instant. */
export interface ScheduleGate {
  /** Inside the working day (start–end) at `at`. */
  working(at: number): boolean;
  /** `at` falls on a day off. */
  dayOff(at: number): boolean;
}

export interface PlanInput {
  now: number;
  meetings: readonly KeyedMeeting[];
  marks: readonly ReminderMark[];
  settings: ReminderSettings;
  gate: ScheduleGate;
  /** The running timer's task, if any. */
  runningTaskId: string | null;
}

/** Busy, timed meetings only: free, all-day and past meetings never remind (rule 1). */
export const remindable = (meeting: Meeting): boolean => meeting.busy && !meeting.allDay;

/**
 * Rule 3, read at the meeting's start: inside working hours unless *outside working hours* is on, never on a day off
 * unless *on days off* is on. (A 09:00 meeting at the start of the day is reminded at 08:55.)
 */
export function allowedAt(at: number, settings: ReminderSettings, gate: ScheduleGate): boolean {
  if (!settings.meetingDaysOff && gate.dayOff(at)) return false;
  return settings.meetingOutsideHours || gate.working(at);
}

const allowed = (meeting: Meeting, input: PlanInput) => remindable(meeting) && allowedAt(meeting.start, input.settings, input.gate);

/** When the reminder of `meeting` is due, or `null` (already reminded, no lead time, past start). */
export function reminderAt(meeting: KeyedMeeting, input: Pick<PlanInput, 'marks' | 'settings'>): number | null {
  const mark = markOf(input.marks, meeting.key);
  if (mark?.snoozedUntil != null) return Math.min(Date.parse(mark.snoozedUntil), meeting.start);
  if (mark !== undefined || input.settings.meetingLeadMinutes <= 0) return null;
  return meeting.start - input.settings.meetingLeadMinutes * MINUTE;
}

/** Whether a timer runs on a task linked to the meeting (no start prompt then). */
const tracksMeeting = (meeting: Meeting, taskId: string | null) => taskId !== null && meeting.taskLinks.some((link) => link.taskId === taskId);

/**
 * What is due now: the reminders (rule 2: at `start − lead`, at once when the app wakes later but before the start; a
 * snooze fires again once) and the meetings whose start prompt is due (rule 5: a timer runs, within 10 minutes of the
 * start, not on the meeting's own task).
 */
export function dueNow(input: PlanInput): { reminders: KeyedMeeting[]; starts: KeyedMeeting[] } {
  const reminders: KeyedMeeting[] = [];
  const starts: KeyedMeeting[] = [];
  const ask = input.settings.meetingAskOnStart || input.settings.meetingAutoPause;
  for (const meeting of input.meetings) {
    if (!allowed(meeting, input)) continue;
    const at = reminderAt(meeting, input);
    if (at !== null && input.now >= at && input.now < meeting.start) reminders.push(meeting);
    const mark = markOf(input.marks, meeting.key);
    if (ask && input.runningTaskId !== null && mark?.prompted !== true && input.now >= meeting.start && input.now < meeting.start + START_WINDOW_MINUTES * MINUTE && !tracksMeeting(meeting, input.runningTaskId)) {
      starts.push(meeting);
    }
  }
  return { reminders, starts };
}

/** The next instant something may become due (a reminder, a snooze, a start), for the host's wake-up. */
export function nextDueAt(input: PlanInput): number | null {
  let next: number | null = null;
  const consider = (at: number | null) => {
    if (at !== null && at > input.now && (next === null || at < next)) next = at;
  };
  for (const meeting of input.meetings) {
    if (!allowed(meeting, input)) continue;
    const at = reminderAt(meeting, input);
    if (at !== null && meeting.start > input.now) consider(Math.max(at, input.now + 1));
    if (markOf(input.marks, meeting.key)?.prompted !== true) consider(meeting.start);
  }
  return next;
}

/** Every meeting of `meetings` keyed with the mark it gets once reminded / prompted at `now`. */
export function fired(marks: readonly ReminderMark[], meetings: readonly KeyedMeeting[], now: number, patch: Partial<ReminderMark>): ReminderMark[] {
  let result = [...marks];
  for (const meeting of meetings) {
    const current = markOf(result, meeting.key);
    result = putMark(result, { key: meeting.key, start: new Date(meeting.start).toISOString(), firedAt: current?.firedAt ?? null, snoozedUntil: current?.snoozedUntil ?? null, prompted: current?.prompted ?? false, ...patch });
  }
  return result;
}

/** Snooze choices: `default` = until 1 minute before the start; or 1 / 5 minutes. Never past the start. */
export type SnoozeChoice = 'default' | 1 | 5;

/** When a snoozed reminder comes back, or `null` when that would not be before the start (never past it). */
export function snoozeUntil(meeting: Pick<Meeting, 'start'>, now: number, choice: SnoozeChoice = 'default'): number | null {
  const at = choice === 'default' ? meeting.start - MINUTE : now + choice * MINUTE;
  return at > now && at < meeting.start ? at : null;
}

/** Snooze options that still make sense now (the default one always while time is left). */
export function snoozeChoices(meeting: Pick<Meeting, 'start'>, now: number): SnoozeChoice[] {
  return (['default', 1, 5] as SnoozeChoice[]).filter((choice) => snoozeUntil(meeting, now, choice) !== null);
}

/** Today's remaining meetings (busy or free, not all-day, ending after `now`, starting before `dayEnd`), for *Today*. */
export function todayMeetings<T extends Meeting>(meetings: readonly T[], now: number, dayEnd: number): T[] {
  return meetings.filter((meeting) => !meeting.allDay && meeting.end > now && meeting.start < dayEnd);
}

/** Whether microphone detection should stay quiet now: a reminded meeting starts within ±10 min (Q-O20, one prompt). */
export function coveredByReminder(meetings: readonly KeyedMeeting[], marks: readonly ReminderMark[], now: number): boolean {
  return meetings.some((meeting) => {
    const mark = markOf(marks, meeting.key);
    return mark !== undefined && (mark.firedAt !== null || mark.prompted === true) && Math.abs(now - meeting.start) <= START_WINDOW_MINUTES * MINUTE;
  });
}

// ---- Polling -------------------------------------------------------------------------------------------------------

export interface PollState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  /** No request before this (Retry-After, backoff). */
  notBefore: number | null;
  /** Last wait after a 429 / 503 / network failure (seconds), for the doubling. */
  backoffSeconds: number;
  /** Jitter factor of the next regular poll (−0.1 … 0.1). */
  jitter: number;
  /** Stopped until `GET me` says otherwise: `scope` (403, re-consent) or `off` (404). */
  stopped: 'scope' | 'off' | null;
}

export const FRESH_POLL: PollState = { lastAttemptAt: null, lastSuccessAt: null, notBefore: null, backoffSeconds: 0, jitter: 0, stopped: null };

export interface PollInput {
  now: number;
  state: PollState;
  refreshAfterSeconds: number;
  /** Start, resume, network back, settings changed: fetch now if the rate rules allow it. */
  force: boolean;
  outsideHours: boolean;
  /** Inside the working day now. */
  working: boolean;
  /** Start of the next working slot (Unix ms), if known. */
  nextSlotStart: number | null;
}

/** Whether to fetch now (contract §23.5). */
export function pollDue(input: PollInput): boolean {
  const { now, state } = input;
  if (state.stopped !== null) return false;
  if (state.notBefore !== null && now < state.notBefore) return false;
  if (state.lastAttemptAt !== null && now - state.lastAttemptAt < MIN_GAP_SECONDS * 1000) return false;
  // First fetch, an event (start, resume, network back, settings), or the retry after a failure's wait.
  if (input.force || state.lastSuccessAt === null || state.backoffSeconds > 0) return true;
  const hoursOk = input.outsideHours || input.working || (input.nextSlotStart !== null && now >= input.nextSlotStart - PRE_SLOT_MINUTES * MINUTE && (state.lastAttemptAt ?? 0) < input.nextSlotStart - PRE_SLOT_MINUTES * MINUTE);
  if (!hoursOk) return false;
  const gap = Math.max(input.refreshAfterSeconds, MIN_POLL_SECONDS) * 1000 * (1 + state.jitter);
  return now - (state.lastAttemptAt ?? 0) >= gap;
}

/** A fetch is going out. */
export const pollStarted = (state: PollState, now: number): PollState => ({ ...state, lastAttemptAt: now });

/** A 200: back to the regular cadence, with a new jitter in ±10 %. */
export function pollSucceeded(state: PollState, now: number, random: () => number): PollState {
  return { ...state, lastSuccessAt: now, notBefore: null, backoffSeconds: 0, stopped: null, jitter: (random() * 2 - 1) * JITTER };
}

/** What a failed fetch means for the app. */
export type PollOutcome = 'retry' | 'unauthorized' | 'scope' | 'off';

/**
 * A failure: 401 → the app's sign-in again; 403 `insufficient_scope` → re-consent, stop; 404 → feature off, stop;
 * anything else (429, 503, offline, 4xx) → no request before `Retry-After`, and a doubling wait (max 30 min) when it
 * repeats.
 */
export function pollFailed(state: PollState, now: number, error: { status: number; code: string; retryAfter: number | null }): { state: PollState; outcome: PollOutcome } {
  if (error.status === 401 && error.code !== 'invalid_credentials') return { state, outcome: 'unauthorized' };
  if (error.status === 403) return { state: { ...state, stopped: 'scope' }, outcome: 'scope' };
  if (error.status === 404) return { state: { ...state, stopped: 'off' }, outcome: 'off' };
  const doubled = state.backoffSeconds > 0 ? Math.min(state.backoffSeconds * 2, MAX_BACKOFF_SECONDS) : FIRST_BACKOFF_SECONDS;
  // A server's `Retry-After` is honoured up to the longest backoff, never beyond (audit GO-I1).
  const wait = Math.min(Math.max(error.retryAfter ?? 0, doubled), MAX_BACKOFF_SECONDS);
  return { state: { ...state, backoffSeconds: Math.min(wait, MAX_BACKOFF_SECONDS), notBefore: now + wait * 1000 }, outcome: 'retry' };
}

// ---- Cache ---------------------------------------------------------------------------------------------------------

/** The last list, kept for offline use (contract §23.5): until the end of tomorrow, never past 48 h. */
export interface MeetingCache {
  account: string;
  fetchedAt: string;
  expiresAt: string;
  status: SyncStatus;
  refreshAfterSeconds: number;
  meetings: KeyedMeeting[];
}

/** Expiry of a list fetched at `fetchedAt` whose window ends at `windowEnd`. */
export function cacheExpiry(fetchedAt: number, windowEnd: number): number {
  return Math.min(windowEnd, fetchedAt + MAX_CACHE_HOURS * 3600_000);
}

export const isStale = (cache: Pick<MeetingCache, 'fetchedAt'>, now: number): boolean => now - Date.parse(cache.fetchedAt) > STALE_MINUTES * MINUTE;

function sanitizeCache(raw: unknown, account: string, now: number): MeetingCache | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const fetchedAt = iso(value.fetchedAt);
  const expiresAt = iso(value.expiresAt);
  if (value.account !== account || fetchedAt === null || expiresAt === null || !Array.isArray(value.meetings)) return null;
  if (now >= Date.parse(expiresAt) || Date.parse(expiresAt) - Date.parse(fetchedAt) > MAX_CACHE_HOURS * 3600_000) return null;
  const meetings = value.meetings
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const value = item as Record<string, unknown>;
      const meeting = parseMeeting({ ...value, start: toIso(value.start), end: toIso(value.end) });
      return meeting !== null && typeof value.key === 'string' && HEX64.test(value.key) ? { ...meeting, key: value.key } : null;
    })
    .filter((item): item is KeyedMeeting => item !== null);
  return {
    account,
    fetchedAt,
    expiresAt,
    status: SYNC_STATUSES.includes(value.status as string) ? (value.status as SyncStatus) : 'connected',
    refreshAfterSeconds: refreshHint(value.refreshAfterSeconds),
    meetings,
  };
}

const toIso = (value: unknown): unknown => (typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : value);

/**
 * Local storage of the reminders: the cached list of the signed-in account and the dedupe marks of each account
 * (switching account switches store; at most 4 accounts). One key, listed in `LOCAL_KEYS` for "Clear local data".
 */
export const MEETINGS_KEY = 'time-track-desktop.meetings';
const MAX_ACCOUNTS = 4;

interface Stored {
  cache: MeetingCache | null;
  marks: Record<string, ReminderMark[]>;
}

export class MeetingStore {
  constructor(private readonly storage: Storage) {}

  private read(): Stored {
    try {
      const raw = JSON.parse(this.storage.getItem(MEETINGS_KEY) ?? '{}') as Partial<Record<keyof Stored, unknown>>;
      const marks: Record<string, ReminderMark[]> = {};
      if (typeof raw.marks === 'object' && raw.marks !== null) {
        // Accounts are hashed (contract §23.6); a plain `server|e-mail` key from an earlier build is dropped (GO-I6).
        for (const [account, list] of Object.entries(raw.marks).filter(([account]) => !account.includes('|')).slice(-MAX_ACCOUNTS)) marks[account] = sanitizeMarks(list);
      }
      return { cache: (raw.cache as MeetingCache | null | undefined) ?? null, marks };
    } catch {
      return { cache: null, marks: {} };
    }
  }

  private write(stored: Stored): void {
    try {
      this.storage.setItem(MEETINGS_KEY, JSON.stringify(stored));
    } catch {
      // Full or unavailable storage: the reminders keep working from memory.
    }
  }

  /** The cached list of `account`, if it is still valid. */
  cache(account: string, now: number): MeetingCache | null {
    return sanitizeCache(this.read().cache, account, now);
  }

  saveCache(cache: MeetingCache | null): void {
    this.write({ ...this.read(), cache });
  }

  marks(account: string, now: number): ReminderMark[] {
    return pruneMarks(this.read().marks[account] ?? [], now);
  }

  /** Forgets `account`'s marks (sign-out, audit GO-I6). */
  dropMarks(account: string): void {
    const stored = this.read();
    this.write({ ...stored, marks: Object.fromEntries(Object.entries(stored.marks).filter(([key]) => key !== account)) });
  }

  saveMarks(account: string, marks: readonly ReminderMark[]): void {
    const stored = this.read();
    const others = Object.entries(stored.marks).filter(([key]) => key !== account).slice(-(MAX_ACCOUNTS - 1));
    this.write({ ...stored, marks: { ...Object.fromEntries(others), [account]: [...marks] } });
  }
}

// ---- Notes ---------------------------------------------------------------------------------------------------------

/** Buttons of the reminders and the start prompt (contract §23.4). */
export type ReminderActionKind = 'join' | 'snooze' | 'keep' | 'pause' | 'track' | 'undo';
const ACTION_KINDS: readonly string[] = ['join', 'snooze', 'keep', 'pause', 'track', 'undo'];
const ACTION_ID = /^meeting-(join|snooze|keep|pause|track|undo):([0-9a-f]{16})$/;

/**
 * Notification button id: `meeting-<kind>:<first 16 hex of the dedupe key>` (the host accepts only this shape,
 * src-tauri/src/notify.rs). The key names the meeting without its id or title.
 */
export const reminderActionId = (kind: ReminderActionKind, key: string): string => `meeting-${kind}:${shortKey(key)}`;

export function parseReminderActionId(id: unknown): { kind: ReminderActionKind; short: string } | null {
  const match = typeof id === 'string' ? ACTION_ID.exec(id) : null;
  return match !== null && ACTION_KINDS.includes(match[1] as string) ? { kind: match[1] as ReminderActionKind, short: match[2] as string } : null;
}

export interface NoteContext {
  now: number;
  locale: MessageLocale;
  /** Local time of an instant (`10:00`). */
  time(at: number): string;
  /** The list is older than an hour. */
  stale: boolean;
}

/** A reminder, the grouped one, the start prompt or the automatic pause, ready for a notification or the window. */
export interface MeetingNote {
  kind: 'reminder' | 'group' | 'start' | 'paused';
  /** Dedupe key of the meeting (`null` for the grouped notification). */
  key: string | null;
  title: string;
  body: string;
  pose: PoseId;
  locale: MessageLocale;
  /** Buttons of the desktop notification (at most two; the window shows every choice). */
  native: { id: string; label: string }[];
}

const fill = (template: string, params: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));

/** The meeting's title, or *Busy* for a private one (or one without a title). */
export const meetingTitle = (meeting: Pick<Meeting, 'title'>, locale: MessageLocale): string => meeting.title ?? MEETING_REMINDERS[locale].busy;

/** "10:00–10:45 · in 5 min · Ana, Luis, Marta +2 · +3 external". */
export function meetingLine(meeting: Meeting, ctx: NoteContext): string {
  const catalog = MEETING_REMINDERS[ctx.locale];
  const minutes = Math.ceil((meeting.start - ctx.now) / MINUTE);
  const parts = [`${ctx.time(meeting.start)}–${ctx.time(meeting.end)}`, minutes > 0 ? fill(catalog.inMinutes, { minutes }) : catalog.startingNow];
  if (meeting.attendees.length > 0) {
    const names = meeting.attendees.slice(0, 3).map((person) => person.name.split(/\s+/)[0] as string);
    parts.push(meeting.attendees.length > 3 ? `${names.join(', ')} ${fill(catalog.more, { count: meeting.attendees.length - 3 })}` : names.join(', '));
  }
  if (meeting.externalCount !== null && meeting.externalCount > 0) parts.push(fill(catalog.externals, { count: meeting.externalCount }));
  const line = parts.join(' · ');
  return ctx.stale ? `${line} ${catalog.outdated}` : line;
}

export const REMINDER_POSE: PoseId = 'teamwork';
export const START_POSE: PoseId = 'presentation';

export function reminderNote(meeting: KeyedMeeting, ctx: NoteContext): MeetingNote {
  const catalog = MEETING_REMINDERS[ctx.locale];
  const native: MeetingNote['native'] = [];
  if (meeting.joinUrl !== null) native.push({ id: reminderActionId('join', meeting.key), label: catalog.actions.join });
  if (snoozeUntil(meeting, ctx.now) !== null) native.push({ id: reminderActionId('snooze', meeting.key), label: catalog.actions.snooze });
  return { kind: 'reminder', key: meeting.key, title: meetingTitle(meeting, ctx.locale), body: meetingLine(meeting, ctx), pose: REMINDER_POSE, locale: ctx.locale, native };
}

/** More than three at once: "4 meetings at 10:00", no button (a click opens *Today*). */
export function groupNote(meetings: readonly KeyedMeeting[], ctx: NoteContext): MeetingNote {
  const catalog = MEETING_REMINDERS[ctx.locale];
  const first = Math.min(...meetings.map((meeting) => meeting.start));
  const body = ctx.stale ? `${catalog.groupBody} ${catalog.outdated}` : catalog.groupBody;
  return { kind: 'group', key: null, title: fill(catalog.groupTitle, { count: meetings.length, time: ctx.time(first) }), body, pose: REMINDER_POSE, locale: ctx.locale, native: [] };
}

/** Rule 5: "Sprint review has started. Keep timing "Docs", pause, or track the meeting?" (Pause, Track as buttons). */
export function startNote(meeting: KeyedMeeting, task: string, ctx: NoteContext): MeetingNote {
  const catalog = MEETING_REMINDERS[ctx.locale];
  return {
    kind: 'start',
    key: meeting.key,
    title: catalog.startTitle,
    body: fill(catalog.startAsk, { meeting: meetingTitle(meeting, ctx.locale), task }),
    pose: START_POSE,
    locale: ctx.locale,
    native: [
      { id: reminderActionId('pause', meeting.key), label: catalog.actions.pause },
      { id: reminderActionId('track', meeting.key), label: catalog.actions.track },
    ],
  };
}

/** Automatic pause (FR-009 opt-in): an info notification with *Undo*. */
export function pausedNote(meeting: KeyedMeeting, task: string, ctx: NoteContext): MeetingNote {
  const catalog = MEETING_REMINDERS[ctx.locale];
  return {
    kind: 'paused',
    key: meeting.key,
    title: catalog.pausedTitle,
    body: fill(catalog.paused, { meeting: meetingTitle(meeting, ctx.locale), task }),
    pose: START_POSE,
    locale: ctx.locale,
    native: [{ id: reminderActionId('undo', meeting.key), label: catalog.actions.undo }],
  };
}
