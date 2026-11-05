import { zonedParts } from './friendly';

/**
 * Working-hours reminders (0.5.0): "Shall we start?" at the start time, "Lunch time, stop the timer?" and "Back to X?"
 * around the lunch break, "Call it a day?" at the end time, and no schedule reminders on holidays / vacations.
 *
 * The week comes from Beacon (`GET me.workingHours`; the gap between two slots of one day is the lunch break) and can be
 * adjusted on this computer only (Settings → My schedule): each local value overrides Beacon's for that day and field,
 * "Reset to Beacon's schedule" drops them. Days off are Beacon's (`GET me.daysOff`, forward compatible: TimeTrackBundle
 * does not publish them yet) plus the ones marked here. Pure functions; the app keeps the state in local storage.
 *
 * Timing: every instant is read in the schedule's time zone (DST aware). A reminder fires once per day and kind, only
 * within `REMINDER_GRACE_MINUTES` of its time (a computer that slept through it gets it on waking, never hours later);
 * when its condition does not hold when it comes due (a timer already runs at the start time …) it is skipped for the day.
 */

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = (typeof WEEKDAYS)[number];

/** One day of the schedule: `HH:MM` local times, `null` = none. */
export interface DayPlan {
  off: boolean;
  start: string | null;
  end: string | null;
  lunchStart: string | null;
  lunchEnd: string | null;
}

export const DAY_FIELDS = ['off', 'start', 'end', 'lunchStart', 'lunchEnd'] as const;
export type DayField = (typeof DAY_FIELDS)[number];

export type Week = Record<Weekday, DayPlan>;
/** Local values per day and field (a present key is local, even `null`: "no lunch here"). */
export type Overrides = Partial<Record<Weekday, Partial<DayPlan>>>;
/** Where a value of the effective week comes from: Beacon, this computer, or nowhere (Beacon publishes no hours). */
export type Source = 'beacon' | 'local' | 'none';

export type DayOffKind = 'holiday' | 'vacation';

export interface DayOff {
  /** Local date `YYYY-MM-DD` in the schedule's time zone. */
  date: string;
  kind: DayOffKind;
  label: string | null;
  source: 'beacon' | 'local';
}

/** A day off marked on this computer. */
export interface LocalDayOff {
  date: string;
  label?: string | null;
}

export type ReminderKind = 'start' | 'lunchStart' | 'lunchEnd' | 'end';
export const REMINDER_KINDS: readonly ReminderKind[] = ['start', 'lunchStart', 'lunchEnd', 'end'];
/** Line pools of the reminders, plus the one friendly line when a timer runs on a day off. */
export type ReminderLineKind = ReminderKind | 'dayOff';
export const REMINDER_LINE_KINDS: readonly ReminderLineKind[] = [...REMINDER_KINDS, 'dayOff'];

/** What the button of a reminder does: resume the last task, or stop the running timer. */
export type ReminderAction = 'start' | 'stop' | 'resume';
export const REMINDER_ACTION: Record<ReminderLineKind, ReminderAction | null> = { start: 'start', lunchStart: 'stop', lunchEnd: 'resume', end: 'stop', dayOff: null };

/** A reminder fires at most this long after its time (sleep, a closed lid); after that it is dropped for the day. */
export const REMINDER_GRACE_MINUTES = 15;
/** "Shall we start?" this many minutes before the start time (Settings). */
export const LEAD_CHOICES: readonly number[] = [0, 5, 10, 15];
export const DEFAULT_LEAD_MINUTES = 0;
/** Remembered reminder slots (`start:2026-11-05` …). */
const SEEN_LIMIT = 60;
/** Local days off kept (past ones are dropped). */
export const MAX_LOCAL_DAYS_OFF = 60;

/** Local state of the schedule: overrides, local days off and what was already shown. */
export interface ScheduleState {
  overrides: Overrides;
  daysOff: LocalDayOff[];
  /** Reminder slots already used or skipped, newest last. */
  seen: string[];
  /** Recently shown line indices per pool, newest last. */
  recent: Partial<Record<ReminderLineKind, number[]>>;
  /** Beacon's part of `GET me` as last seen (offline start), re-validated on use. */
  beacon: BeaconSchedule | null;
}

/** The fields of `GET me` the schedule reads. */
export interface BeaconSchedule {
  workingHours: unknown;
  daysOff: unknown;
  timezone: unknown;
}

export const EMPTY_SCHEDULE: ScheduleState = { overrides: {}, daysOff: [], seen: [], recent: {}, beacon: null };

/** What to remember of `GET me` for the schedule. */
export function beaconPart(me: unknown): BeaconSchedule {
  return { workingHours: field(me, 'workingHours') ?? null, daysOff: field(me, 'daysOff') ?? null, timezone: field(me, 'timezone') ?? null };
}

// ---- Times and dates ----------------------------------------------------------------------------------------------

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isTime(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value);
}

/** `9:05` → `09:05`; anything else that is not a time → null. */
export function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const text = `${match[1]!.padStart(2, '0')}:${match[2]}`;
  return isTime(text) ? text : null;
}

export function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

/** Offset of `timeZone` (null = system) at instant `at`, in minutes (Madrid in summer: 120). */
function offsetAt(at: number, timeZone: string | null): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone ?? undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((wall - Math.floor(at / 60_000) * 60_000) / 60_000);
}

/**
 * The instant of wall-clock `time` on `date` in `timeZone` (null = the system's), DST aware: a time that happens twice
 * (autumn) is its first occurrence; one that does not exist (spring) moves forward by the gap (02:30 → 03:30).
 */
export function zonedInstant(date: string, time: string, timeZone: string | null): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
  const before = offsetAt(wall - 14 * 3600_000, timeZone);
  const after = offsetAt(wall + 14 * 3600_000, timeZone);
  const matches = [...new Set([before, after])]
    .map((offset) => wall - offset * 60_000)
    .filter((at) => offsetAt(at, timeZone) === Math.round((wall - at) / 60_000))
    .sort((a, b) => a - b);
  return new Date(matches[0] ?? wall - before * 60_000);
}

// ---- Beacon's week ----------------------------------------------------------------------------------------------

const DAY_NAMES: Record<string, Weekday> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

const field = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined);

/** The day's slots of either shape Beacon may send: `slots: [{day, from, to}]` or `days: {mon: [["09:00","14:00"]]}`. */
function slotsOf(hours: unknown): Map<Weekday, [number, number][]> | null {
  const result = new Map<Weekday, [number, number][]>();
  const add = (day: unknown, from: unknown, to: unknown) => {
    const weekday = typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7 ? (day as Weekday) : typeof day === 'string' ? DAY_NAMES[day.toLowerCase()] : undefined;
    const a = normalizeTime(from);
    const b = normalizeTime(to);
    if (weekday === undefined || a === null || b === null || minutesOf(a) >= minutesOf(b)) return;
    result.set(weekday, [...(result.get(weekday) ?? []), [minutesOf(a), minutesOf(b)]]);
  };
  const slots = field(hours, 'slots');
  const days = field(hours, 'days');
  if (Array.isArray(slots)) {
    for (const slot of slots) add(field(slot, 'day'), field(slot, 'from'), field(slot, 'to'));
  } else if (typeof days === 'object' && days !== null && !Array.isArray(days)) {
    for (const [day, list] of Object.entries(days as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const pair of list) {
        if (Array.isArray(pair)) add(day, pair[0], pair[1]);
        else add(day, field(pair, 'from'), field(pair, 'to'));
      }
    }
  } else {
    return null;
  }
  return result;
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const EMPTY_DAY: DayPlan = { off: false, start: null, end: null, lunchStart: null, lunchEnd: null };

/**
 * Beacon's week from `GET me.workingHours`, or null when the host publishes none (or a shape this app does not read).
 * A day without slots is a day off; start is the first slot's start, end the last slot's end, and the longest gap
 * between two slots of the day is the lunch break.
 */
export function beaconWeek(hours: unknown): Week | null {
  if (hours === null || hours === undefined) return null;
  const slots = slotsOf(hours);
  if (slots === null) return null;
  const week = {} as Week;
  for (const day of WEEKDAYS) {
    const list = [...(slots.get(day) ?? [])].sort((a, b) => a[0] - b[0]);
    if (list.length === 0) {
      week[day] = { ...EMPTY_DAY, off: true };
      continue;
    }
    let lunch: [number, number] | null = null;
    for (let i = 1; i < list.length; i++) {
      const gap: [number, number] = [list[i - 1]![1], list[i]![0]];
      if (gap[1] > gap[0] && (lunch === null || gap[1] - gap[0] > lunch[1] - lunch[0])) lunch = gap;
    }
    week[day] = {
      off: false,
      start: hhmm(list[0]![0]),
      end: hhmm(Math.max(...list.map((slot) => slot[1]))),
      lunchStart: lunch !== null ? hhmm(lunch[0]) : null,
      lunchEnd: lunch !== null ? hhmm(lunch[1]) : null,
    };
  }
  return week;
}

export interface Merged {
  week: Week;
  source: Record<Weekday, Record<DayField, Source>>;
}

/** Beacon's week with the local overrides on top, and where each value comes from. */
export function mergeWeek(beacon: Week | null, overrides: Overrides): Merged {
  const week = {} as Week;
  const source = {} as Merged['source'];
  for (const day of WEEKDAYS) {
    const base = beacon?.[day] ?? EMPTY_DAY;
    const local = overrides[day] ?? {};
    const plan = { ...base };
    const from = {} as Record<DayField, Source>;
    for (const name of DAY_FIELDS) {
      if (name in local) {
        (plan as Record<DayField, unknown>)[name] = local[name];
        from[name] = 'local';
      } else {
        from[name] = beacon === null ? 'none' : 'beacon';
      }
    }
    week[day] = plan;
    source[day] = from;
  }
  return { week, source };
}

/**
 * The overrides after the person set `name` of `day` to `value` in Settings: a value equal to Beacon's is not an
 * override (the field goes back to "from Beacon").
 */
export function setOverride(overrides: Overrides, beacon: Week | null, day: Weekday, name: DayField, value: boolean | string | null): Overrides {
  const local = { ...(overrides[day] ?? {}) };
  // Without Beacon hours, "not off" and "no time" are the defaults: not an override either.
  const base = beacon?.[day] ?? EMPTY_DAY;
  const clean = name === 'off' ? value === true : normalizeTime(value);
  if (base[name] === clean) delete local[name];
  else (local as Record<DayField, unknown>)[name] = clean;
  const next = { ...overrides };
  if (Object.keys(local).length === 0) delete next[day];
  else next[day] = local;
  return next;
}

/** Whether a day's plan can remind anything: not off, start before end, the lunch inside when both ends are set. */
export function validDay(plan: DayPlan): { start: boolean; end: boolean; lunch: boolean } {
  const start = !plan.off && plan.start !== null;
  const end = !plan.off && plan.end !== null && (plan.start === null || minutesOf(plan.end) > minutesOf(plan.start));
  const lunch = !plan.off && plan.lunchStart !== null && plan.lunchEnd !== null && minutesOf(plan.lunchEnd) > minutesOf(plan.lunchStart);
  return { start, end, lunch };
}

// ---- Days off -----------------------------------------------------------------------------------------------------

/** `GET me.daysOff` (proposed for TimeTrackBundle): `[{date, kind: 'holiday' | 'vacation', label?}]`; the rest ignored. */
export function beaconDaysOff(me: unknown): DayOff[] {
  const list = field(me, 'daysOff');
  if (!Array.isArray(list)) return [];
  const result: DayOff[] = [];
  for (const item of list) {
    const date = field(item, 'date');
    if (!isDate(date)) continue;
    const label = field(item, 'label');
    result.push({ date, kind: field(item, 'kind') === 'vacation' ? 'vacation' : 'holiday', label: typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 80) : null, source: 'beacon' });
  }
  return result;
}

/** Beacon's days off and the local ones (a date in both is Beacon's), sorted by date. */
export function allDaysOff(beacon: readonly DayOff[], local: readonly LocalDayOff[]): DayOff[] {
  const byDate = new Map<string, DayOff>();
  for (const item of local) if (isDate(item.date)) byDate.set(item.date, { date: item.date, kind: 'vacation', label: item.label ?? null, source: 'local' });
  for (const item of beacon) byDate.set(item.date, item);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function dayOffOn(date: string, daysOff: readonly DayOff[]): DayOff | null {
  return daysOff.find((item) => item.date === date) ?? null;
}

/** Local days off with `date` added (or removed), past ones dropped. */
export function toggleLocalDayOff(list: readonly LocalDayOff[], date: string, on: boolean, today: string): LocalDayOff[] {
  if (!isDate(date)) return [...list];
  const kept = list.filter((item) => item.date !== date && item.date >= today);
  return (on ? [...kept, { date }] : kept).sort((a, b) => a.date.localeCompare(b.date)).slice(0, MAX_LOCAL_DAYS_OFF);
}

// ---- Planning -----------------------------------------------------------------------------------------------------

export interface ReminderInput {
  now: Date;
  timeZone: string | null;
  week: Week;
  daysOff: readonly DayOff[];
  leadMinutes: number;
  /** A timer is running. */
  running: boolean;
  /** There is a task to resume. */
  hasLastTask: boolean;
  /** Slots already used or skipped. */
  seen: readonly string[];
}

export interface Reminder {
  kind: ReminderKind;
  /** `start:2026-11-05`. */
  slot: string;
  /** Scheduled instant. */
  at: Date;
  /** The schedule's local date it belongs to. */
  date: string;
}

/** Each reminder of the schedule's local `date` (none on a day off), with its instant. */
export function remindersOn(date: string, input: Pick<ReminderInput, 'timeZone' | 'week' | 'daysOff' | 'leadMinutes'>): Reminder[] {
  if (dayOffOn(date, input.daysOff) !== null) return [];
  const plan = input.week[weekdayOf(date)];
  const valid = validDay(plan);
  const result: Reminder[] = [];
  const add = (kind: ReminderKind, time: string | null, ok: boolean, shift = 0) => {
    if (!ok || time === null) return;
    result.push({ kind, slot: `${kind}:${date}`, date, at: new Date(zonedInstant(date, time, input.timeZone).getTime() - shift * 60_000) });
  };
  add('start', plan.start, valid.start, Math.max(0, input.leadMinutes));
  add('lunchStart', plan.lunchStart, valid.lunch);
  add('lunchEnd', plan.lunchEnd, valid.lunch);
  add('end', plan.end, valid.end);
  return result;
}

/** Whether a reminder that came due still makes sense now. */
function holds(kind: ReminderKind, input: ReminderInput): boolean {
  if (kind === 'start') return !input.running;
  if (kind === 'lunchEnd') return !input.running && input.hasLastTask;
  return input.running;
}

/**
 * The reminder to show now (the latest that came due within the grace window), and the slots to mark as used without
 * showing anything (due, but their condition does not hold, or superseded by a later one).
 */
export function dueReminder(input: ReminderInput): { reminder: Reminder | null; skip: string[] } {
  const now = input.now.getTime();
  const today = zonedParts(input.now, input.timeZone).date;
  const due = [addDays(today, -1), today]
    .flatMap((date) => remindersOn(date, input))
    .filter((item) => !input.seen.includes(item.slot) && now >= item.at.getTime() && now - item.at.getTime() < REMINDER_GRACE_MINUTES * 60_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const fitting = due.filter((item) => holds(item.kind, input));
  const reminder = fitting[fitting.length - 1] ?? null;
  return { reminder, skip: due.filter((item) => item !== reminder).map((item) => item.slot) };
}

/** Unix ms of the next reminder after `now` (today or the next days), for the host's wake-up; null when none. */
export function nextReminderAt(input: Omit<ReminderInput, 'running' | 'hasLastTask'>): number | null {
  const now = input.now.getTime();
  const today = zonedParts(input.now, input.timeZone).date;
  for (let offset = 0; offset <= 7; offset++) {
    const next = remindersOn(addDays(today, offset), input)
      .filter((item) => !input.seen.includes(item.slot) && item.at.getTime() > now)
      .map((item) => item.at.getTime())
      .sort((a, b) => a - b)[0];
    if (next !== undefined) return next;
  }
  return null;
}

/** Slots with `slots` added (kept short). */
export function markSeen(seen: readonly string[], slots: readonly string[]): string[] {
  return [...seen, ...slots.filter((slot) => !seen.includes(slot))].slice(-SEEN_LIMIT);
}

// ---- Stored state -------------------------------------------------------------------------------------------------

function sanitizeDay(raw: unknown): Partial<DayPlan> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const day: Partial<DayPlan> = {};
  const value = raw as Record<string, unknown>;
  if (typeof value.off === 'boolean') day.off = value.off;
  for (const name of ['start', 'end', 'lunchStart', 'lunchEnd'] as const) {
    if (!(name in value)) continue;
    if (value[name] === null) day[name] = null;
    else if (isTime(value[name])) day[name] = value[name] as string;
  }
  return Object.keys(day).length > 0 ? day : null;
}

/** Stored schedule state from an older or hand-edited local storage, made safe. */
export function sanitizeSchedule(raw: unknown): ScheduleState {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_SCHEDULE };
  const value = raw as Partial<Record<keyof ScheduleState, unknown>>;
  const overrides: Overrides = {};
  if (typeof value.overrides === 'object' && value.overrides !== null) {
    for (const day of WEEKDAYS) {
      const clean = sanitizeDay((value.overrides as Record<string, unknown>)[String(day)]);
      if (clean !== null) overrides[day] = clean;
    }
  }
  const daysOff = Array.isArray(value.daysOff)
    ? value.daysOff
        .filter((item): item is LocalDayOff => isDate(field(item, 'date')))
        .map((item) => (typeof item.label === 'string' ? { date: item.date, label: item.label.slice(0, 80) } : { date: item.date }))
        .slice(0, MAX_LOCAL_DAYS_OFF)
    : [];
  const recent: ScheduleState['recent'] = {};
  if (typeof value.recent === 'object' && value.recent !== null) {
    for (const kind of REMINDER_LINE_KINDS) {
      const list = (value.recent as Record<string, unknown>)[kind];
      if (Array.isArray(list)) {
        const numbers = list.filter((item): item is number => Number.isInteger(item) && item >= 0).slice(-12);
        if (numbers.length > 0) recent[kind] = numbers;
      }
    }
  }
  return {
    overrides,
    daysOff,
    seen: Array.isArray(value.seen) ? value.seen.filter((slot): slot is string => typeof slot === 'string').slice(-SEEN_LIMIT) : [],
    recent,
    beacon: typeof value.beacon === 'object' && value.beacon !== null ? beaconPart(value.beacon) : null,
  };
}
