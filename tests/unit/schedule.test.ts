import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MESSAGE_LOCALES, NO_REPEAT } from '../../src/lib/friendly';
import { POSE_IDS } from '../../src/lib/messages/types';
import { ACTION_IDS, actionOfId, composeReminder, REMINDERS } from '../../src/lib/reminders';
import {
  addDays,
  allDaysOff,
  beaconDaysOff,
  beaconPart,
  beaconWeek,
  dayOffOn,
  dueReminder,
  EMPTY_SCHEDULE,
  isDate,
  isTime,
  markSeen,
  MAX_LOCAL_DAYS_OFF,
  mergeWeek,
  nextReminderAt,
  normalizeTime,
  REMINDER_GRACE_MINUTES,
  REMINDER_LINE_KINDS,
  remindersOn,
  sanitizeSchedule,
  setOverride,
  toggleLocalDayOff,
  validDay,
  weekdayOf,
  zonedInstant,
  type DayOff,
  type ReminderInput,
  type Week,
} from '../../src/lib/schedule';

const MADRID = 'Europe/Madrid';
/** Monday to Friday 09:00–14:00 and 15:00–18:00 in Madrid: lunch 14:00–15:00; weekend off. */
const HOURS = {
  timezone: MADRID,
  slots: [1, 2, 3, 4, 5].flatMap((day) => [
    { day, from: '09:00', to: '14:00' },
    { day, from: '15:00', to: '18:00' },
  ]),
};
const WEEK = beaconWeek(HOURS) as Week;

/** Reminder input at `now` (ISO with offset), with no timer and a task to resume. */
function at(now: string, patch: Partial<ReminderInput> = {}): ReminderInput {
  return { now: new Date(now), timeZone: MADRID, week: WEEK, daysOff: [], leadMinutes: 0, running: false, hasLastTask: true, seen: [], ...patch };
}
const due = (input: ReminderInput) => dueReminder(input).reminder?.kind ?? null;

describe('times and dates', () => {
  it('validates and normalizes', () => {
    expect(isTime('09:30')).toBe(true);
    expect(isTime('9:30')).toBe(false);
    expect(isTime('24:00')).toBe(false);
    expect(normalizeTime('9:05')).toBe('09:05');
    expect(normalizeTime(' 18:00 ')).toBe('18:00');
    expect(normalizeTime('25:00')).toBeNull();
    expect(normalizeTime('noon')).toBeNull();
    expect(normalizeTime(9)).toBeNull();
    expect(isDate('2026-02-29')).toBe(false);
    expect(isDate('2028-02-29')).toBe(true);
    expect(isDate('2026-1-01')).toBe(false);
    expect(isDate(null)).toBe(false);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-11-05')).toBe(4);
    expect(weekdayOf('2026-11-08')).toBe(7);
  });

  it('wall-clock times in the schedule time zone, DST aware', () => {
    expect(zonedInstant('2026-11-05', '09:00', MADRID).toISOString()).toBe('2026-11-05T08:00:00.000Z');
    expect(zonedInstant('2026-07-01', '09:00', MADRID).toISOString()).toBe('2026-07-01T07:00:00.000Z');
    // Spring forward (02:00 → 03:00): same-day 09:00 is already summer time; 02:30 does not exist and moves to 03:30.
    expect(zonedInstant('2026-03-29', '09:00', MADRID).toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(zonedInstant('2026-03-29', '02:30', MADRID).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // Fall back (03:00 → 02:00): 02:30 happens twice, the first one counts; 09:00 is winter time.
    expect(zonedInstant('2026-10-25', '02:30', MADRID).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(zonedInstant('2026-10-25', '09:00', MADRID).toISOString()).toBe('2026-10-25T08:00:00.000Z');
    // Another zone, another DST date (New York changes a week later than Madrid).
    expect(zonedInstant('2026-11-01', '09:00', 'America/New_York').toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(zonedInstant('2026-10-31', '09:00', 'America/New_York').toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(zonedInstant('2026-11-05', '09:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-05T03:30:00.000Z');
    // No zone: the system's, as the Date constructor reads it.
    expect(zonedInstant('2026-11-05', '09:00', null).getTime()).toBe(new Date(2026, 10, 5, 9, 0).getTime());
  });
});

describe("Beacon's week", () => {
  it('slots: start, end, the gap is the lunch break, a day without slots is off', () => {
    expect(WEEK[4]).toEqual({ off: false, start: '09:00', end: '18:00', lunchStart: '14:00', lunchEnd: '15:00' });
    expect(WEEK[6]).toEqual({ off: true, start: null, end: null, lunchStart: null, lunchEnd: null });
  });

  it('one slot has no lunch; with three, the longest gap is lunch; bad slots are ignored', () => {
    const week = beaconWeek({
      slots: [
        { day: 1, from: '08:00', to: '15:00' },
        { day: 2, from: '16:00', to: '19:00' },
        { day: 2, from: '08:00', to: '10:30' },
        { day: 2, from: '10:45', to: '13:30' },
        { day: 3, from: '18:00', to: '09:00' },
        { day: 3, from: 'x', to: '10:00' },
        { day: 9, from: '09:00', to: '10:00' },
        null,
      ],
    }) as Week;
    expect(week[1]).toMatchObject({ start: '08:00', end: '15:00', lunchStart: null, lunchEnd: null });
    expect(week[2]).toMatchObject({ start: '08:00', end: '19:00', lunchStart: '13:30', lunchEnd: '16:00' });
    expect(week[3].off).toBe(true);
  });

  it("also reads TimeTrackBundle's documented `days` shape", () => {
    const week = beaconWeek({ timezone: MADRID, days: { mon: [['09:00', '13:00'], ['14:00', '17:30']], Friday: [{ from: '8:00', to: '15:00' }], sun: 'nope' } }) as Week;
    expect(week[1]).toMatchObject({ start: '09:00', end: '17:30', lunchStart: '13:00', lunchEnd: '14:00' });
    expect(week[5]).toMatchObject({ start: '08:00', end: '15:00', lunchStart: null });
    expect(week[7].off).toBe(true);
  });

  it('none or not understood → null', () => {
    expect(beaconWeek(null)).toBeNull();
    expect(beaconWeek(undefined)).toBeNull();
    expect(beaconWeek({})).toBeNull();
    expect(beaconWeek({ days: [] })).toBeNull();
    expect(beaconWeek('09-18')).toBeNull();
  });
});

describe('local overrides', () => {
  it("merge: local values win field by field and say so; Beacon's stay Beacon's", () => {
    const { week, source } = mergeWeek(WEEK, { 4: { start: '08:30', lunchStart: null }, 6: { off: false, start: '10:00', end: '12:00' } });
    expect(week[4]).toEqual({ off: false, start: '08:30', end: '18:00', lunchStart: null, lunchEnd: '15:00' });
    expect(source[4]).toEqual({ off: 'beacon', start: 'local', end: 'beacon', lunchStart: 'local', lunchEnd: 'beacon' });
    expect(week[6]).toMatchObject({ off: false, start: '10:00', end: '12:00' });
    expect(source[1].start).toBe('beacon');
    expect(validDay(week[4]).lunch).toBe(false);
  });

  it('without Beacon hours every field is "none" until set here', () => {
    const { week, source } = mergeWeek(null, { 2: { start: '07:00' } });
    expect(week[2]).toEqual({ off: false, start: '07:00', end: null, lunchStart: null, lunchEnd: null });
    expect(source[2].start).toBe('local');
    expect(source[2].end).toBe('none');
    expect(source[5].off).toBe('none');
  });

  it("setOverride: a value equal to Beacon's is no override; an empty day goes away", () => {
    let overrides = setOverride({}, WEEK, 4, 'start', '8:30');
    expect(overrides).toEqual({ 4: { start: '08:30' } });
    overrides = setOverride(overrides, WEEK, 4, 'lunchStart', null);
    expect(overrides).toEqual({ 4: { start: '08:30', lunchStart: null } });
    overrides = setOverride(overrides, WEEK, 4, 'start', '09:00');
    overrides = setOverride(overrides, WEEK, 4, 'lunchStart', '14:00');
    expect(overrides).toEqual({});
    expect(setOverride({}, WEEK, 5, 'off', true)).toEqual({ 5: { off: true } });
    expect(setOverride({ 5: { off: true } }, WEEK, 5, 'off', false)).toEqual({});
    // No Beacon hours: "not off" / "no time" are the defaults.
    expect(setOverride({}, null, 1, 'off', false)).toEqual({});
    expect(setOverride({}, null, 1, 'end', '')).toEqual({});
    expect(setOverride({}, null, 1, 'end', '17:00')).toEqual({ 1: { end: '17:00' } });
  });

  it('validDay: end after start, lunch end after lunch start, nothing on a day off', () => {
    expect(validDay({ off: false, start: '09:00', end: '08:00', lunchStart: '13:00', lunchEnd: '12:00' })).toEqual({ start: true, end: false, lunch: false });
    expect(validDay({ off: false, start: null, end: '17:00', lunchStart: null, lunchEnd: null })).toEqual({ start: false, end: true, lunch: false });
    expect(validDay({ off: true, start: '09:00', end: '17:00', lunchStart: '13:00', lunchEnd: '14:00' })).toEqual({ start: false, end: false, lunch: false });
  });
});

describe('days off', () => {
  it("reads the proposed `GET me.daysOff`, ignoring what it does not understand", () => {
    expect(
      beaconDaysOff({
        daysOff: [
          { date: '2026-12-08', kind: 'holiday', label: ' Inmaculada ' },
          { date: '2026-12-24', kind: 'vacation' },
          { date: '2026-12-31', kind: 'other', label: '' },
          { date: '2026-13-01', kind: 'holiday' },
          'x',
        ],
      }),
    ).toEqual([
      { date: '2026-12-08', kind: 'holiday', label: 'Inmaculada', source: 'beacon' },
      { date: '2026-12-24', kind: 'vacation', label: null, source: 'beacon' },
      { date: '2026-12-31', kind: 'holiday', label: null, source: 'beacon' },
    ]);
    expect(beaconDaysOff({})).toEqual([]);
    expect(beaconDaysOff(null)).toEqual([]);
  });

  it("merges Beacon's and local ones (Beacon wins on the same date), sorted", () => {
    const beacon: DayOff[] = [{ date: '2026-12-25', kind: 'holiday', label: 'Navidad', source: 'beacon' }];
    const all = allDaysOff(beacon, [{ date: '2026-12-25' }, { date: '2026-11-20', label: 'Puente' }, { date: 'bad' }]);
    expect(all.map((item) => [item.date, item.source, item.label])).toEqual([
      ['2026-11-20', 'local', 'Puente'],
      ['2026-12-25', 'beacon', 'Navidad'],
    ]);
    expect(dayOffOn('2026-12-25', all)?.source).toBe('beacon');
    expect(dayOffOn('2026-12-26', all)).toBeNull();
  });

  it('local days off: added once, removed, past ones dropped, bounded', () => {
    let list = toggleLocalDayOff([{ date: '2026-11-01' }], '2026-11-20', true, '2026-11-05');
    expect(list).toEqual([{ date: '2026-11-20' }]);
    list = toggleLocalDayOff(list, '2026-11-20', true, '2026-11-05');
    expect(list).toHaveLength(1);
    expect(toggleLocalDayOff(list, '2026-11-20', false, '2026-11-05')).toEqual([]);
    expect(toggleLocalDayOff(list, 'nope', true, '2026-11-05')).toEqual(list);
    const many = Array.from({ length: MAX_LOCAL_DAYS_OFF + 5 }, (_, i) => ({ date: addDays('2027-01-01', i) }));
    expect(toggleLocalDayOff(many, '2026-12-01', true, '2026-11-05')).toHaveLength(MAX_LOCAL_DAYS_OFF);
  });

  it('no schedule reminders on a day off', () => {
    const daysOff: DayOff[] = [{ date: '2026-11-05', kind: 'vacation', label: null, source: 'local' }];
    expect(remindersOn('2026-11-05', { timeZone: MADRID, week: WEEK, daysOff, leadMinutes: 0 })).toEqual([]);
    expect(due(at('2026-11-05T09:01:00+01:00', { daysOff }))).toBeNull();
    expect(remindersOn('2026-11-07', { timeZone: MADRID, week: WEEK, daysOff, leadMinutes: 0 })).toEqual([]);
  });
});

describe('which reminder is due', () => {
  it('start: at the start time (minus the lead), without a timer; skipped for the day with one', () => {
    expect(due(at('2026-11-05T08:59:00+01:00'))).toBeNull();
    expect(dueReminder(at('2026-11-05T09:00:00+01:00')).reminder).toMatchObject({ kind: 'start', slot: 'start:2026-11-05', date: '2026-11-05' });
    expect(due(at('2026-11-05T08:55:00+01:00', { leadMinutes: 5 }))).toBe('start');
    const running = dueReminder(at('2026-11-05T09:02:00+01:00', { running: true }));
    expect(running).toEqual({ reminder: null, skip: ['start:2026-11-05'] });
  });

  it('lunch start only while the timer runs; lunch end only when stopped and there is a task to resume', () => {
    expect(due(at('2026-11-05T14:00:00+01:00', { running: true, seen: ['start:2026-11-05'] }))).toBe('lunchStart');
    expect(dueReminder(at('2026-11-05T14:00:00+01:00')).skip).toEqual(['lunchStart:2026-11-05']);
    expect(due(at('2026-11-05T15:03:00+01:00'))).toBe('lunchEnd');
    expect(due(at('2026-11-05T15:03:00+01:00', { running: true }))).toBeNull();
    expect(due(at('2026-11-05T15:03:00+01:00', { hasLastTask: false }))).toBeNull();
  });

  it('end: only while the timer runs', () => {
    expect(due(at('2026-11-05T18:00:00+01:00', { running: true }))).toBe('end');
    expect(dueReminder(at('2026-11-05T18:00:00+01:00')).skip).toEqual(['end:2026-11-05']);
  });

  it(`sleep: fires on waking within ${REMINDER_GRACE_MINUTES} min, never later`, () => {
    expect(due(at('2026-11-05T09:14:59+01:00'))).toBe('start');
    expect(dueReminder(at('2026-11-05T09:15:00+01:00'))).toEqual({ reminder: null, skip: [] });
    // Woken at 18:40 with the timer still running: neither the lunch nor the end reminder of hours ago.
    expect(dueReminder(at('2026-11-05T18:40:00+01:00', { running: true }))).toEqual({ reminder: null, skip: [] });
  });

  it('no duplicates: a seen slot never fires again; the latest of several due wins, the others are skipped', () => {
    expect(due(at('2026-11-05T09:05:00+01:00', { seen: ['start:2026-11-05'] }))).toBeNull();
    const week = { ...WEEK, 4: { off: false, start: '09:00', end: '18:00', lunchStart: '14:00', lunchEnd: '14:10' } };
    const both = dueReminder(at('2026-11-05T14:12:00+01:00', { week, running: false }));
    expect(both.reminder?.kind).toBe('lunchEnd');
    expect(both.skip).toEqual(['lunchStart:2026-11-05']);
  });

  it('an end time just before midnight still fires after it (the day before)', () => {
    const week = { ...WEEK, 4: { off: false, start: '15:00', end: '23:55', lunchStart: null, lunchEnd: null } };
    const result = dueReminder(at('2026-11-06T00:05:00+01:00', { week, running: true, seen: ['start:2026-11-06'] }));
    expect(result.reminder).toMatchObject({ kind: 'end', slot: 'end:2026-11-05', date: '2026-11-05' });
  });

  it('DST days and other zones', () => {
    // Sunday 29 March is a weekend; use a schedule that works on Sundays.
    const sunday = { ...WEEK, 7: { off: false, start: '09:00', end: '18:00', lunchStart: null, lunchEnd: null } };
    expect(due(at('2026-03-29T07:00:00Z', { week: sunday }))).toBe('start');
    expect(due(at('2026-03-29T08:00:00Z', { week: sunday }))).toBeNull();
    expect(due(at('2026-10-25T08:00:00Z', { week: sunday }))).toBe('start');
    expect(due(at('2026-10-25T07:00:00Z', { week: sunday }))).toBeNull();
    // A New York schedule read on a Madrid computer: 09:00 there is 15:00 here.
    expect(due(at('2026-11-05T14:00:00Z', { timeZone: 'America/New_York' }))).toBe('start');
    expect(due(at('2026-11-05T08:00:00Z', { timeZone: 'America/New_York' }))).toBeNull();
  });

  it('next reminder for the wake-up: later today, then the next working day, skipping days off and seen slots', () => {
    const next = (now: string, patch: Partial<ReminderInput> = {}) => {
      const value = nextReminderAt(at(now, patch));
      return value === null ? null : new Date(value).toISOString();
    };
    expect(next('2026-11-05T10:00:00+01:00')).toBe('2026-11-05T13:00:00.000Z');
    expect(next('2026-11-05T14:30:00+01:00')).toBe('2026-11-05T14:00:00.000Z');
    expect(next('2026-11-05T08:00:00+01:00', { leadMinutes: 10 })).toBe('2026-11-05T07:50:00.000Z');
    // Friday evening → Monday's start; with Monday off → Tuesday's.
    expect(next('2026-11-06T19:00:00+01:00')).toBe('2026-11-09T08:00:00.000Z');
    expect(next('2026-11-06T19:00:00+01:00', { daysOff: [{ date: '2026-11-09', kind: 'holiday', label: null, source: 'beacon' }] })).toBe('2026-11-10T08:00:00.000Z');
    expect(next('2026-11-05T08:00:00+01:00', { seen: ['start:2026-11-05'] })).toBe('2026-11-05T13:00:00.000Z');
    expect(nextReminderAt(at('2026-11-05T08:00:00+01:00', { week: mergeWeek(null, {}).week }))).toBeNull();
  });
});

describe('stored state', () => {
  it('markSeen: no duplicates, bounded', () => {
    expect(markSeen(['a'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(markSeen([], Array.from({ length: 100 }, (_, i) => `s${i}`))).toHaveLength(60);
  });

  it('sanitizeSchedule keeps what is valid', () => {
    expect(sanitizeSchedule(null)).toEqual(EMPTY_SCHEDULE);
    expect(sanitizeSchedule('x')).toEqual(EMPTY_SCHEDULE);
    const clean = sanitizeSchedule({
      overrides: { 1: { start: '08:00', end: 'late', lunchStart: null, off: 'no' }, 2: 'x', 3: {}, 9: { start: '07:00' } },
      daysOff: [{ date: '2026-12-24', label: 'Nochebuena'.repeat(10) }, { date: '2026-12-31' }, { date: 'nope' }, null],
      seen: ['start:2026-11-05', 4],
      recent: { start: [1, -1, 'x', 2], other: [1], end: 'x', lunchStart: [] },
      beacon: { workingHours: HOURS, daysOff: [], timezone: MADRID, extra: 1 },
    });
    expect(clean.overrides).toEqual({ 1: { start: '08:00', lunchStart: null } });
    expect(clean.daysOff).toEqual([{ date: '2026-12-24', label: 'Nochebuena'.repeat(8) }, { date: '2026-12-31' }]);
    expect(clean.seen).toEqual(['start:2026-11-05']);
    expect(clean.recent).toEqual({ start: [1, 2] });
    expect(clean.beacon).toEqual({ workingHours: HOURS, daysOff: [], timezone: MADRID });
    expect(beaconPart({ userId: 1 })).toEqual({ workingHours: null, daysOff: null, timezone: null });
  });
});

describe('reminder texts', () => {
  const poses = JSON.parse(readFileSync('src/ui/pose-art.json', 'utf8')) as string[];

  it('every locale: each moment has 4+ distinct lines with drawn poses, titles, buttons and add-ons', () => {
    for (const locale of MESSAGE_LOCALES) {
      const catalog = REMINDERS[locale];
      const all = REMINDER_LINE_KINDS.flatMap((kind) => catalog.lines[kind].map((line) => line.text));
      expect(new Set(all).size, `${locale} unique`).toBe(all.length);
      for (const kind of REMINDER_LINE_KINDS) {
        const lines = catalog.lines[kind];
        expect(lines.length, `${locale}.${kind}`).toBeGreaterThanOrEqual(4);
        for (const line of lines) {
          expect(POSE_IDS).toContain(line.pose);
          expect(poses, `${locale}.${kind} pose ${line.pose} has art`).toContain(line.pose);
          // Only "Back to {task}?" names the task in the line itself.
          expect(line.text.includes('{task}'), `${locale}.${kind}: ${line.text}`).toBe(kind === 'lunchEnd');
          expect(line.text).not.toMatch(/\{(?!task\})/);
        }
        expect(catalog.titles[kind].trim()).not.toBe('');
      }
      for (const label of Object.values(catalog.actions)) expect(label.trim()).not.toBe('');
      expect(catalog.lastTask).toContain('{task}');
      expect(catalog.today).toContain('{total}');
      if (locale !== 'en') expect(all.some((text) => REMINDERS.en.lines.start.some((line) => line.text === text))).toBe(false);
    }
  });

  it('the poses of each moment', () => {
    const used = (kind: (typeof REMINDER_LINE_KINDS)[number]) => new Set(MESSAGE_LOCALES.flatMap((locale) => REMINDERS[locale].lines[kind].map((line) => line.pose)));
    expect([...used('start')].sort()).toEqual(['early', 'sunrise']);
    expect([...used('lunchStart')]).toEqual(['lunch']);
    expect([...used('end')]).toEqual(['finished']);
    expect([...used('dayOff')].sort()).toEqual(['holiday', 'shades']);
  });

  const base = { slot: 's', locale: 'es' as const, state: EMPTY_SCHEDULE, rng: () => 0, now: new Date('2026-11-05T08:00:00Z'), task: 'Escribir guía', total: '3:20' };

  it('start: the line plus the last task, with a Start button; no task → no button', () => {
    const { note, state } = composeReminder({ ...base, kind: 'start' });
    expect(note).toMatchObject({ kind: 'start', title: 'Hora de entrada', text: '¿Empezamos? Última tarea: Escribir guía.', pose: 'sunrise', action: 'start', actionLabel: 'Empezar', shownAt: '2026-11-05T08:00:00.000Z' });
    expect(state.recent.start).toEqual([0]);
    const none = composeReminder({ ...base, kind: 'start', task: null }).note;
    expect(none).toMatchObject({ text: '¿Empezamos?', action: null, actionLabel: null });
  });

  it('lunch, back from lunch and end of the day', () => {
    expect(composeReminder({ ...base, kind: 'lunchStart' }).note).toMatchObject({ text: 'Hora de comer, ¿paro el temporizador?', action: 'stop', actionLabel: 'Parar', pose: 'lunch' });
    expect(composeReminder({ ...base, kind: 'lunchEnd' }).note).toMatchObject({ text: '¿Retomamos Escribir guía?', action: 'resume', actionLabel: 'Retomar' });
    expect(composeReminder({ ...base, kind: 'end' }).note).toMatchObject({ text: '¿Cerramos por hoy? Hoy llevas 3:20.', action: 'stop', pose: 'finished', title: 'Hora de salida' });
    expect(composeReminder({ ...base, kind: 'end', total: null }).note.text).toBe('¿Cerramos por hoy?');
    expect(composeReminder({ ...base, kind: 'dayOff', locale: 'en' }).note).toMatchObject({ text: 'Working on your holiday? Keep it short!', action: null, title: 'Day off' });
  });

  it('varied: no line repeats until the pool was shown', () => {
    let state = EMPTY_SCHEDULE;
    const shown: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = composeReminder({ ...base, kind: 'end', state, rng: () => 0.99 });
      shown.push(result.note.text);
      state = result.state;
    }
    expect(new Set(shown).size).toBe(4);
    expect(NO_REPEAT).toBeGreaterThanOrEqual(4);
  });

  it('button ids', () => {
    expect(actionOfId(ACTION_IDS.stop)).toBe('stop');
    expect(actionOfId('schedule-resume')).toBe('resume');
    expect(actionOfId('open')).toBeNull();
    expect(actionOfId(undefined)).toBeNull();
  });
});
