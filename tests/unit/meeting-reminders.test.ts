import { describe, expect, it } from 'vitest';
import { ApiError, parseRetryAfter, TimeTrackApi } from '../../src/api/client';
import { ALL_SCOPES, type Me, MEETINGS_SCOPE } from '../../src/api/types';
import { runDeviceFlow, DeviceFlowError } from '../../src/lib/deviceFlow';
import { externalUrl, meetingJoinUrl } from '../../src/lib/links';
import {
  allowedAt,
  cacheExpiry,
  calendarConnected,
  coveredByReminder,
  DEFAULT_LEAD_MINUTES,
  DEFAULT_REMINDER_SETTINGS,
  dedupeSource,
  dueNow,
  fired,
  FRESH_POLL,
  groupNote,
  isStale,
  type KeyedMeeting,
  MAX_BACKOFF_SECONDS,
  MAX_MARKS,
  type Meeting,
  MEETINGS_KEY,
  MeetingStore,
  meetingLine,
  meetingSupport,
  meetingTitle,
  nextDueAt,
  type NoteContext,
  parseMeeting,
  parseMeetingsPage,
  parseReminderActionId,
  pausedNote,
  type PlanInput,
  pollDue,
  pollFailed,
  pollStarted,
  pollSucceeded,
  pruneMarks,
  putMark,
  refreshHint,
  reminderActionId,
  reminderAt,
  reminderNote,
  remindersEnabled,
  type ReminderSettings,
  sanitizeLead,
  sanitizeMarks,
  sanitizeReminderSettings,
  sha256Hex,
  shortKey,
  snoozeChoices,
  snoozeUntil,
  startNote,
  todayMeetings,
  withKeys,
} from '../../src/lib/meetingReminders';
import { MEETING_REMINDERS } from '../../src/lib/messages/meetingReminders';
import { MESSAGE_LOCALES } from '../../src/lib/friendly';
import { POSE_IDS } from '../../src/lib/messages/types';

const MIN = 60_000;
/** Thursday 2026-11-05 10:00 in Madrid. */
const TEN = Date.parse('2026-11-05T09:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

function raw(id: string, startMin: number, extra: Record<string, unknown> = {}) {
  return {
    id: `mtg_${id.padEnd(16, '0')}`,
    start: iso(TEN + startMin * MIN),
    end: iso(TEN + (startMin + 30) * MIN),
    timeZone: 'Europe/Madrid',
    allDay: false,
    date: null,
    busy: true,
    private: false,
    title: 'Sprint review',
    joinUrl: 'https://meet.google.com/abc-defg-hij',
    joinProvider: 'meet',
    organizerIsMe: false,
    attendees: [{ id: 'u1', name: 'Luis Pérez' }],
    externalCount: 2,
    taskLinks: [{ taskId: 'T-105', key: '#T-105' }],
    updatedAt: iso(TEN - 60 * MIN),
    ...extra,
  };
}

async function keyed(...items: ReturnType<typeof raw>[]): Promise<KeyedMeeting[]> {
  return withKeys(items.map((item) => parseMeeting(item) as Meeting));
}

/** Working 09:00–18:00 Madrid on weekdays; 2026-12-25 off. */
const gate = {
  working: (at: number) => {
    const local = new Date(at + 3600_000);
    const day = local.getUTCDay();
    const hour = local.getUTCHours();
    return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
  },
  dayOff: (at: number) => new Date(at + 3600_000).toISOString().startsWith('2026-12-25'),
};

const settings = (patch: Partial<ReminderSettings> = {}): ReminderSettings => ({ ...DEFAULT_REMINDER_SETTINGS, ...patch });

function plan(meetings: KeyedMeeting[], now: number, patch: Partial<PlanInput> = {}): PlanInput {
  return { now, meetings, marks: [], settings: settings(), gate, runningTaskId: null, ...patch };
}

describe('meetings answer', () => {
  it('keeps only well-formed meetings, sorted, without duplicates', () => {
    const page = parseMeetingsPage({
      sync: { status: 'needs_reconnect', refreshAfterSeconds: 30 },
      truncated: true,
      meetings: [raw('b', 60), raw('a', 30), raw('a', 30), raw('bad', 0, { id: 'evt_1' }), raw('c', 0, { end: iso(TEN) }), raw('d', 0, { start: '2026-11-05T10:00:00+01:00' }), raw('e', 0, { end: iso(TEN + 25 * 60 * MIN) }), null, 'x'],
    });
    expect(page?.meetings.map((item) => item.id)).toEqual(['mtg_a000000000000000', 'mtg_b000000000000000']);
    expect(page).toMatchObject({ status: 'needs_reconnect', refreshAfterSeconds: 60, truncated: true });
    expect(parseMeetingsPage({ meetings: [] })).toEqual({ status: 'connected', refreshAfterSeconds: 300, truncated: false, meetings: [] });
    expect(parseMeetingsPage({ sync: { status: 'disabled' }, meetings: [] })?.status).toBe('connected');
    expect(parseMeetingsPage(null)).toBeNull();
    expect(parseMeetingsPage({ meetings: 'no' })).toBeNull();
    expect(refreshHint(99_999)).toBe(3600);
    expect(refreshHint('300')).toBe(300);
  });

  it('a private meeting keeps its join link and nothing else; free and unknown fields are read safely', () => {
    const meeting = parseMeeting(raw('p', 10, { private: true, title: 'Secret', attendees: [{ id: 'u', name: 'X' }], taskLinks: [{ taskId: 'T-1', key: 'k' }], externalCount: 3 })) as Meeting;
    expect(meeting).toMatchObject({ private: true, title: null, attendees: [], taskLinks: [], externalCount: null, joinUrl: 'https://meet.google.com/abc-defg-hij', joinProvider: 'meet' });
    expect(meetingTitle(meeting, 'es')).toBe('Ocupado');
    const odd = parseMeeting(raw('o', 10, { busy: undefined, title: '‮evil\u0007 title  ', attendees: [{ id: 1, name: 'x' }, { id: 'u', name: '  ' }, null], taskLinks: [{ taskId: 'bad id!' }, { taskId: 'T-7' }], externalCount: -1, joinUrl: 'http://meet.google.com/x' })) as Meeting;
    expect(odd).toMatchObject({ busy: true, title: 'evil title', attendees: [], taskLinks: [{ taskId: 'T-7', key: 'T-7' }], externalCount: null, joinUrl: null, joinProvider: null });
    expect(parseMeeting(raw('f', 10, { busy: false, allDay: true, attendees: 'x', taskLinks: 'y' }))).toMatchObject({ busy: false, allDay: true, attendees: [], taskLinks: [] });
    expect(parseMeeting(null)).toBeNull();
  });

  it('the join link is opened only for the allow-listed video-call hosts (contract §22.4 vectors)', () => {
    const ok = {
      'https://teams.microsoft.com/l/meetup-join/19%3a': 'teams',
      'https://teams.live.com/meet/123': 'teams',
      'https://meet.google.com/abc-defg-hij': 'meet',
      'https://zoom.us/j/123?pwd=abc': 'zoom',
      'https://acme.zoom.us/j/123': 'zoom',
      'https://zoomgov.com/j/1': 'zoom',
      'https://x.zoomgov.com/j/1': 'zoom',
      'https://meet.jit.si/Room': 'jitsi',
      'https://acme.webex.com/meet/x': 'webex',
      'https://MEET.GOOGLE.COM/abc': 'meet',
    };
    for (const [url, provider] of Object.entries(ok)) expect(meetingJoinUrl(url)?.provider, url).toBe(provider);
    const hostile = [
      'javascript:alert(1)',
      'http://meet.google.com/abc',
      'https://user:pw@meet.google.com/abc',
      'https://meet.goog1e.com/abc',
      'https://zoom.us.evil.tld/j/1',
      'https://evilzoom.us/j/1',
      'https://.zoom.us/j/1',
      'https://webex.com/meet',
      'https://meet.google.com/abc ',
      'https://meet.google.com/a"b',
      "https://meet.google.com/a'b",
      'https://meet.google.com/a\u0000b',
      'https://meet.google.com:8443/abc',
      `https://meet.google.com/${'a'.repeat(4096)}`,
      'not a url',
      '',
      null,
      42,
    ];
    for (const url of hostile) expect(meetingJoinUrl(url), String(url).slice(0, 60)).toBeNull();
    expect(externalUrl('https://zoom.us/j/1', { kind: 'meeting' })).toBe('https://zoom.us/j/1');
    expect(externalUrl('https://example.com/j/1', { kind: 'meeting' })).toBeNull();
  });
});

describe('server support and settings', () => {
  const me = (patch: Partial<Me>): Me => ({ userId: 1, identifier: 'ada', scopes: [...ALL_SCOPES, MEETINGS_SCOPE], ...patch });

  it('reads GET me: older servers, re-consent, the sync state and the calendars page', () => {
    expect(meetingSupport(null)).toEqual({ kind: 'unsupported' });
    expect(meetingSupport(me({}))).toEqual({ kind: 'unsupported' });
    expect(meetingSupport(me({ features: { meetings: false } }))).toEqual({ kind: 'unsupported' });
    expect(meetingSupport(me({ features: { meetings: true }, scopes: [...ALL_SCOPES], links: { calendars: 'https://beacon.example/account/calendars' } }))).toEqual({ kind: 'consent', calendarsUrl: 'https://beacon.example/account/calendars' });
    expect(meetingSupport(me({ features: { meetings: true }, scopes: [] }), [MEETINGS_SCOPE])).toMatchObject({ kind: 'on', status: 'connected', refreshAfterSeconds: 300, calendarsUrl: null });
    expect(meetingSupport(me({ features: { meetings: true }, meetings: { status: 'not_connected', refreshAfterSeconds: 120 }, links: { calendars: 'ftp://beacon.example/x' } }))).toEqual({ kind: 'on', status: 'not_connected', refreshAfterSeconds: 120, calendarsUrl: null });
    expect(meetingSupport(me({ features: { meetings: true }, links: { calendars: 'not a url' } }))).toMatchObject({ calendarsUrl: null });
  });

  it('reminders are on by default only with a calendar connected, and switchable', () => {
    const on = { kind: 'on', status: 'connected', refreshAfterSeconds: 300, calendarsUrl: null } as const;
    expect(remindersEnabled(null, on)).toBe(true);
    expect(remindersEnabled(null, { ...on, status: 'not_connected' })).toBe(false);
    expect(remindersEnabled(true, { ...on, status: 'not_connected' })).toBe(true);
    expect(remindersEnabled(false, on)).toBe(false);
    expect(remindersEnabled(true, { kind: 'consent', calendarsUrl: null })).toBe(false);
    expect(calendarConnected('syncing')).toBe(true);
  });

  it('lead time: off, presets or a whole 1–120; stored settings are made safe', () => {
    for (const value of [0, 1, 2, 5, 10, 15, 30, 7, 120]) expect(sanitizeLead(value)).toBe(value);
    for (const value of [-1, 121, 2.5, '5', null, Number.NaN]) expect(sanitizeLead(value)).toBe(DEFAULT_LEAD_MINUTES);
    expect(sanitizeReminderSettings(undefined)).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(sanitizeReminderSettings({ meetingReminders: false, meetingLeadMinutes: 45, meetingOutsideHours: true, meetingDaysOff: 'yes', meetingAskOnStart: false, meetingAutoPause: true, meetingConsentSeen: true })).toEqual({
      meetingReminders: false,
      meetingLeadMinutes: 45,
      meetingOutsideHours: true,
      meetingDaysOff: false,
      meetingAskOnStart: false,
      meetingAutoPause: true,
      meetingConsentSeen: true,
    });
  });
});

describe('scheduling', () => {
  it('reminds at start − lead (default 5 min), once, and at once when the app wakes later but before the start', async () => {
    const [meeting] = await keyed(raw('a', 30));
    const m = meeting as KeyedMeeting;
    expect(dueNow(plan([m], TEN + 24 * MIN)).reminders).toEqual([]);
    expect(dueNow(plan([m], TEN + 25 * MIN)).reminders).toEqual([m]);
    // Woke up after a sleep, 2 minutes before: at once.
    expect(dueNow(plan([m], TEN + 28 * MIN)).reminders).toEqual([m]);
    // After the start: no reminder (only the start prompt may come).
    expect(dueNow(plan([m], TEN + 30 * MIN)).reminders).toEqual([]);
    const marks = fired([], [m], TEN + 25 * MIN, { firedAt: iso(TEN + 25 * MIN) });
    expect(dueNow(plan([m], TEN + 26 * MIN, { marks })).reminders).toEqual([]);
    expect(nextDueAt(plan([m], TEN))).toBe(TEN + 25 * MIN);
    expect(nextDueAt(plan([m], TEN + 26 * MIN, { marks }))).toBe(TEN + 30 * MIN);
    expect(nextDueAt(plan([m], TEN + 26 * MIN, { marks: fired(marks, [m], TEN, { prompted: true }) }))).toBeNull();
  });

  it('lead times: presets, custom 1–120 and off', async () => {
    const [m] = (await keyed(raw('a', 150))) as [KeyedMeeting];
    for (const lead of [1, 2, 10, 15, 30, 37, 120]) {
      expect(reminderAt(m, { marks: [], settings: settings({ meetingLeadMinutes: lead }) }), String(lead)).toBe(m.start - lead * MIN);
    }
    expect(reminderAt(m, { marks: [], settings: settings({ meetingLeadMinutes: 0 }) })).toBeNull();
    expect(dueNow(plan([m], m.start - MIN, { settings: settings({ meetingLeadMinutes: 0 }) })).reminders).toEqual([]);
    // A 120-minute lead at 10:00 for a 12:30 meeting is not due yet; at 10:30 it is.
    expect(dueNow(plan([m], TEN, { settings: settings({ meetingLeadMinutes: 120 }) })).reminders).toEqual([]);
    expect(dueNow(plan([m], TEN + 30 * MIN, { settings: settings({ meetingLeadMinutes: 120 }) })).reminders).toEqual([m]);
  });

  it('free, all-day and past meetings never remind', async () => {
    const list = await keyed(raw('f', 30, { busy: false }), raw('d', 30, { allDay: true }), raw('p', -60));
    expect(dueNow(plan(list, TEN + 26 * MIN)).reminders).toEqual([]);
    expect(nextDueAt(plan(list, TEN))).toBeNull();
  });

  it('working hours and days off gate the reminders, unless switched on', async () => {
    // 19:30 Madrid (after hours), and Christmas (a day off) at 10:00 Madrid.
    const late = (await keyed(raw('l', 9.5 * 60)))[0] as KeyedMeeting;
    const xmas = (await keyed({ ...raw('x', 0), start: '2026-12-25T09:00:00Z', end: '2026-12-25T09:30:00Z' }))[0] as KeyedMeeting;
    expect(dueNow(plan([late], late.start - 5 * MIN)).reminders).toEqual([]);
    expect(dueNow(plan([late], late.start - 5 * MIN, { settings: settings({ meetingOutsideHours: true }) })).reminders).toEqual([late]);
    expect(dueNow(plan([xmas], xmas.start - 5 * MIN)).reminders).toEqual([]);
    expect(dueNow(plan([xmas], xmas.start - 5 * MIN, { settings: settings({ meetingOutsideHours: true }) })).reminders).toEqual([]);
    expect(dueNow(plan([xmas], xmas.start - 5 * MIN, { settings: settings({ meetingDaysOff: true }) })).reminders).toEqual([xmas]);
    // A 09:00 meeting (start of the day) is reminded at 08:55.
    const nine = (await keyed({ ...raw('n', 0), start: '2026-11-05T08:00:00Z', end: '2026-11-05T08:30:00Z' }))[0] as KeyedMeeting;
    expect(dueNow(plan([nine], nine.start - 5 * MIN)).reminders).toEqual([nine]);
    expect(allowedAt(nine.start, settings(), gate)).toBe(true);
  });

  it('is DST aware in Europe/Madrid: the gate reads local time on the day the clocks change', async () => {
    const { zonedParts } = await import('../../src/lib/friendly');
    // Sunday 2026-03-29 (clocks go forward at 02:00) and Monday 2026-03-30 09:00 CEST = 07:00Z.
    const monday = Date.parse('2026-03-30T07:00:00Z');
    const madrid = { working: (at: number) => zonedParts(new Date(at), 'Europe/Madrid').minute >= 9 * 60, dayOff: () => false };
    const [m] = (await keyed({ ...raw('s', 0), start: iso(monday), end: iso(monday + 30 * MIN) })) as [KeyedMeeting];
    expect(dueNow({ ...plan([m], monday - 5 * MIN), gate: madrid }).reminders).toEqual([m]);
    // 08:59 CEST is outside.
    expect(allowedAt(monday - MIN, settings(), madrid)).toBe(false);
  });

  it('dedupe by id + start: a moved meeting reminds again, a new title does not', async () => {
    const [first] = (await keyed(raw('a', 30))) as [KeyedMeeting];
    const [renamed] = (await keyed(raw('a', 30, { title: 'Renamed' }))) as [KeyedMeeting];
    const [moved] = (await keyed(raw('a', 60))) as [KeyedMeeting];
    expect(renamed.key).toBe(first.key);
    expect(moved.key).not.toBe(first.key);
    expect(first.key).toBe(await sha256Hex('mtg_a000000000000000|2026-11-05T09:30:00Z'));
    expect(dedupeSource(first)).toBe('mtg_a000000000000000|2026-11-05T09:30:00Z');
    const marks = fired([], [first], TEN + 25 * MIN, { firedAt: iso(TEN + 25 * MIN) });
    expect(dueNow(plan([renamed], TEN + 26 * MIN, { marks })).reminders).toEqual([]);
    expect(dueNow(plan([moved], TEN + 56 * MIN, { marks })).reminders).toEqual([moved]);
  });

  it('snooze: until 1 min before the start by default, or 1 / 5 min, never past the start; fires again once', async () => {
    const [m] = (await keyed(raw('a', 30))) as [KeyedMeeting];
    const now = TEN + 25 * MIN;
    expect(snoozeUntil(m, now)).toBe(m.start - MIN);
    expect(snoozeUntil(m, now, 1)).toBe(now + MIN);
    expect(snoozeUntil(m, now, 5)).toBeNull();
    expect(snoozeChoices(m, now)).toEqual(['default', 1]);
    expect(snoozeChoices(m, m.start - 30_000)).toEqual([]);
    expect(snoozeChoices(m, TEN)).toEqual(['default', 1, 5]);
    const marks = putMark(fired([], [m], now, { firedAt: iso(now) }), { key: m.key, start: iso(m.start), firedAt: iso(now), snoozedUntil: iso(now + MIN) });
    expect(dueNow(plan([m], now + 30_000, { marks })).reminders).toEqual([]);
    expect(nextDueAt(plan([m], now + 30_000, { marks }))).toBe(now + MIN);
    expect(dueNow(plan([m], now + MIN, { marks })).reminders).toEqual([m]);
    const after = fired(marks, [m], now + MIN, { firedAt: iso(now + MIN), snoozedUntil: null });
    expect(dueNow(plan([m], now + 2 * MIN, { marks: after })).reminders).toEqual([]);
  });

  it('start prompt: a timer runs, within 10 min of the start, not on a linked task, once', async () => {
    const [m] = (await keyed(raw('a', 30))) as [KeyedMeeting];
    const at = m.start + MIN;
    expect(dueNow(plan([m], at)).starts).toEqual([]);
    expect(dueNow(plan([m], at, { runningTaskId: 'T-101' })).starts).toEqual([m]);
    expect(dueNow(plan([m], at, { runningTaskId: 'T-105' })).starts).toEqual([]);
    expect(dueNow(plan([m], m.start + 10 * MIN, { runningTaskId: 'T-101' })).starts).toEqual([]);
    expect(dueNow(plan([m], at, { runningTaskId: 'T-101', settings: settings({ meetingAskOnStart: false }) })).starts).toEqual([]);
    expect(dueNow(plan([m], at, { runningTaskId: 'T-101', settings: settings({ meetingAskOnStart: false, meetingAutoPause: true }) })).starts).toEqual([m]);
    expect(dueNow(plan([m], at, { runningTaskId: 'T-101', marks: fired([], [m], at, { prompted: true }) })).starts).toEqual([]);
  });

  it('today list, microphone interplay and marks housekeeping', async () => {
    const list = await keyed(raw('a', -60), raw('b', -10), raw('c', 30), raw('d', 14 * 60), raw('e', 30, { allDay: true }));
    const dayEnd = Date.parse('2026-11-05T23:00:00Z');
    expect(todayMeetings(list, TEN, dayEnd).map((m) => m.id.slice(4, 5))).toEqual(['b', 'c']);
    const c = list[2] as KeyedMeeting;
    expect(coveredByReminder(list, [], c.start)).toBe(false);
    const marks = fired([], [c], c.start - 5 * MIN, { firedAt: iso(c.start - 5 * MIN) });
    expect(coveredByReminder(list, marks, c.start + 9 * MIN)).toBe(true);
    expect(coveredByReminder(list, marks, c.start + 11 * MIN)).toBe(false);
    expect(coveredByReminder(list, fired([], [c], c.start, { prompted: true }), c.start - 10 * MIN)).toBe(true);
    expect(coveredByReminder(list, fired([], [c], c.start, {}), c.start)).toBe(false);
    const many = Array.from({ length: MAX_MARKS + 5 }, (_, index) => ({ key: index.toString(16).padStart(64, '0'), start: iso(TEN), firedAt: null }));
    expect(sanitizeMarks(many)).toHaveLength(MAX_MARKS);
    expect(sanitizeMarks([{ key: 'nothex', start: iso(TEN) }, { key: 'a'.repeat(64), start: 'never' }, null, { key: 'b'.repeat(64), start: iso(TEN), firedAt: 'x', snoozedUntil: iso(TEN), prompted: true }])).toEqual([
      { key: 'b'.repeat(64), start: iso(TEN), firedAt: null, snoozedUntil: iso(TEN), prompted: true },
    ]);
    expect(sanitizeMarks('x')).toEqual([]);
    expect(pruneMarks([{ key: 'a'.repeat(64), start: iso(TEN - 25 * 3600_000), firedAt: null }, { key: 'b'.repeat(64), start: iso(TEN - 23 * 3600_000), firedAt: null }], TEN)).toHaveLength(1);
  });
});

describe('notes', () => {
  const ctx = (patch: Partial<NoteContext> = {}): NoteContext => ({ now: TEN + 25 * MIN, locale: 'en', time: (at) => new Date(at + 3600_000).toISOString().slice(11, 16), stale: false, ...patch });

  it('reminder: title, local range, minutes left, first names, externals; Join and Snooze', async () => {
    const [m] = (await keyed(raw('a', 30, { attendees: [{ id: '1', name: 'Ana Ruiz' }, { id: '2', name: 'Luis Pérez' }, { id: '3', name: 'Marta' }, { id: '4', name: 'Pablo' }, { id: '5', name: 'Eva' }] }))) as [KeyedMeeting];
    const note = reminderNote(m, ctx());
    expect(note).toMatchObject({ kind: 'reminder', key: m.key, title: 'Sprint review', body: '10:30–11:00 · in 5 min · Ana, Luis, Marta +2 · +2 external', pose: 'teamwork' });
    expect(note.native.map((action) => action.id)).toEqual([`meeting-join:${shortKey(m.key)}`, `meeting-snooze:${shortKey(m.key)}`]);
    const [plain] = (await keyed(raw('b', 30, { private: true, joinUrl: null }))) as [KeyedMeeting];
    const busy = reminderNote(plain, ctx({ locale: 'es', stale: true, now: plain.start - 30_000 }));
    expect(busy.title).toBe('Ocupado');
    expect(busy.body).toBe('10:30–11:00 · en 1 min (puede no estar al día)');
    expect(busy.native).toEqual([]);
    expect(meetingLine({ ...plain, externalCount: 0 }, ctx({ now: plain.start }))).toBe('10:30–11:00 · starting now');
  });

  it('grouped, start prompt and automatic pause', async () => {
    const list = await keyed(raw('a', 30), raw('b', 30), raw('c', 30), raw('d', 30));
    expect(groupNote(list, ctx())).toMatchObject({ kind: 'group', key: null, title: '4 meetings at 10:30', body: 'Open TimeTrack to see them and join.', native: [] });
    expect(groupNote(list, ctx({ stale: true })).body).toContain('(may be outdated)');
    const start = startNote(list[0] as KeyedMeeting, 'Docs', ctx());
    expect(start.body).toBe('Sprint review has started. Keep timing "Docs", pause, or track the meeting?');
    expect(start.native.map((action) => action.label)).toEqual(['Pause', 'Track the meeting']);
    const paused = pausedNote(list[0] as KeyedMeeting, 'Docs', ctx({ locale: 'de' }));
    expect(paused).toMatchObject({ title: 'Timer pausiert', native: [{ label: 'Rückgängig' }] });
  });

  it('every locale has every text, buttons fit a notification and the poses exist', () => {
    const keys = Object.keys(MEETING_REMINDERS.en).sort();
    for (const locale of MESSAGE_LOCALES) {
      const catalog = MEETING_REMINDERS[locale];
      expect(Object.keys(catalog).sort(), locale).toEqual(keys);
      for (const label of Object.values(catalog.actions)) expect(label.length, `${locale} ${label}`).toBeLessThanOrEqual(24);
    }
    expect(POSE_IDS).toContain('teamwork');
    expect(POSE_IDS).toContain('presentation');
  });

  it('button ids carry a known kind and the short key only', () => {
    const key = 'ab'.repeat(32);
    expect(reminderActionId('join', key)).toBe('meeting-join:abababababababab');
    expect(parseReminderActionId('meeting-undo:abababababababab')).toEqual({ kind: 'undo', short: 'abababababababab' });
    for (const id of ['meeting-join', 'meeting-open:abababababababab', 'meeting-join:ABABABABABABABAB', 'meeting-join:abab', 5, null]) expect(parseReminderActionId(id)).toBeNull();
  });
});

describe('polling', () => {
  const input = (patch: Partial<Parameters<typeof pollDue>[0]> = {}) => ({ now: TEN, state: FRESH_POLL, refreshAfterSeconds: 300, force: false, outsideHours: false, working: true, nextSlotStart: null, ...patch });

  it('first fetch at once; then every max(hint, 300 s) ± jitter; never twice within 60 s', () => {
    expect(pollDue(input())).toBe(true);
    const done = pollSucceeded(pollStarted(FRESH_POLL, TEN), TEN, () => 1);
    expect(done.jitter).toBeCloseTo(0.1);
    expect(pollDue(input({ state: done, now: TEN + 320 * 1000 }))).toBe(false);
    expect(pollDue(input({ state: done, now: TEN + 331 * 1000 }))).toBe(true);
    expect(pollDue(input({ state: done, now: TEN + 30 * 1000, force: true }))).toBe(false);
    expect(pollDue(input({ state: done, now: TEN + 61 * 1000, force: true }))).toBe(true);
    const slow = pollSucceeded(pollStarted(FRESH_POLL, TEN), TEN, () => 0.5);
    expect(pollDue(input({ state: slow, refreshAfterSeconds: 900, now: TEN + 899 * 1000 }))).toBe(false);
    expect(pollDue(input({ state: slow, refreshAfterSeconds: 900, now: TEN + 900 * 1000 }))).toBe(true);
  });

  it('outside working hours: no regular poll, except one fetch in the two hours before the next slot', () => {
    const done = pollSucceeded(pollStarted(FRESH_POLL, TEN), TEN, () => 0.5);
    const next = TEN + 10 * 3600_000;
    expect(pollDue(input({ state: done, now: TEN + 3600_000, working: false, nextSlotStart: next }))).toBe(false);
    expect(pollDue(input({ state: done, now: next - 90 * MIN, working: false, nextSlotStart: next }))).toBe(true);
    const fetched = pollSucceeded(pollStarted(done, next - 90 * MIN), next - 90 * MIN, () => 0.5);
    expect(pollDue(input({ state: fetched, now: next - 30 * MIN, working: false, nextSlotStart: next }))).toBe(false);
    expect(pollDue(input({ state: done, now: TEN + 3600_000, working: false, outsideHours: true }))).toBe(true);
    // Events (start, wake) still fetch outside hours.
    expect(pollDue(input({ state: done, now: TEN + 3600_000, working: false, force: true }))).toBe(true);
  });

  it('429 / 503: no request before Retry-After, then a doubling wait up to 30 min; 401 / 403 / 404', () => {
    const started = pollStarted(FRESH_POLL, TEN);
    const first = pollFailed(started, TEN, { status: 429, code: 'rate_limited', retryAfter: 120 });
    expect(first.outcome).toBe('retry');
    expect(first.state.notBefore).toBe(TEN + 120_000);
    expect(pollDue(input({ state: first.state, now: TEN + 119_000, force: true }))).toBe(false);
    expect(pollDue(input({ state: first.state, now: TEN + 120_000 }))).toBe(true);
    const second = pollFailed(first.state, TEN + 120_000, { status: 503, code: 'meetings_unavailable', retryAfter: 60 });
    expect(second.state.backoffSeconds).toBe(240);
    let state = second.state;
    for (let i = 0; i < 6; i++) state = pollFailed(state, TEN, { status: 0, code: 'network_error', retryAfter: null }).state;
    expect(state.backoffSeconds).toBe(MAX_BACKOFF_SECONDS);
    expect(pollFailed(FRESH_POLL, TEN, { status: 0, code: 'network_error', retryAfter: null }).state.notBefore).toBe(TEN + 60_000);
    expect(pollFailed(FRESH_POLL, TEN, { status: 401, code: 'invalid_token', retryAfter: null }).outcome).toBe('unauthorized');
    expect(pollFailed(FRESH_POLL, TEN, { status: 403, code: 'insufficient_scope', retryAfter: null })).toMatchObject({ outcome: 'scope', state: { stopped: 'scope' } });
    const off = pollFailed(FRESH_POLL, TEN, { status: 404, code: 'not_found', retryAfter: null });
    expect(off).toMatchObject({ outcome: 'off', state: { stopped: 'off' } });
    expect(pollDue(input({ state: off.state, force: true }))).toBe(false);
    expect(pollSucceeded(off.state, TEN, () => 0.5).stopped).toBeNull();
  });

  it('Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('Thu, 05 Nov 2026 09:02:00 GMT', TEN)).toBe(120);
    expect(parseRetryAfter('Thu, 05 Nov 2026 08:00:00 GMT', TEN)).toBe(0);
    expect(parseRetryAfter('-5')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('local store', () => {
  function memory(): Storage {
    const data = new Map<string, string>();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
      clear: () => data.clear(),
      key: () => null,
      get length() {
        return data.size;
      },
    };
  }

  it('keeps the list until the end of tomorrow (never past 48 h), per account; marks per account, at most 4', async () => {
    const storage = memory();
    const store = new MeetingStore(storage);
    const meetings = await keyed(raw('a', 30), raw('p', 60, { private: true }));
    const windowEnd = Date.parse('2026-11-06T23:00:00Z');
    expect(cacheExpiry(TEN, windowEnd)).toBe(windowEnd);
    expect(cacheExpiry(TEN, TEN + 72 * 3600_000)).toBe(TEN + 48 * 3600_000);
    store.saveCache({ account: 'a', fetchedAt: iso(TEN), expiresAt: iso(windowEnd), status: 'connected', refreshAfterSeconds: 300, meetings });
    expect(store.cache('a', TEN + MIN)?.meetings).toEqual(meetings);
    expect(store.cache('b', TEN + MIN)).toBeNull();
    expect(store.cache('a', windowEnd)).toBeNull();
    expect(isStale({ fetchedAt: iso(TEN) }, TEN + 61 * MIN)).toBe(true);
    expect(isStale({ fetchedAt: iso(TEN) }, TEN + 59 * MIN)).toBe(false);
    // The stored list holds what the API returned, never more; the marks hold hashes and times only.
    const stored = storage.getItem(MEETINGS_KEY) as string;
    expect(stored).not.toContain('Secret');
    store.saveMarks('a', fired([], meetings, TEN, { firedAt: iso(TEN) }));
    expect(store.marks('a', TEN)).toHaveLength(2);
    expect(JSON.stringify(store.marks('a', TEN))).not.toMatch(/mtg_|Sprint/);
    for (const account of ['b', 'c', 'd', 'e']) store.saveMarks(account, []);
    expect(store.marks('a', TEN)).toEqual([]);
    expect(store.marks('e', TEN)).toEqual([]);
    store.saveCache({ account: 'a', fetchedAt: iso(TEN), expiresAt: iso(TEN + 50 * 3600_000), status: 'syncing', refreshAfterSeconds: 300, meetings });
    expect(store.cache('a', TEN)).toBeNull();
    storage.setItem(MEETINGS_KEY, JSON.stringify({ cache: { account: 'a', fetchedAt: iso(TEN), expiresAt: iso(windowEnd), status: 'weird', meetings: [{ ...meetings[0], key: 'bad' }, meetings[1], null] } }));
    expect(store.cache('a', TEN)).toMatchObject({ status: 'connected', meetings: [meetings[1]] });
    storage.setItem(MEETINGS_KEY, JSON.stringify({ cache: { account: 'a', fetchedAt: 'x' } }));
    expect(store.cache('a', TEN)).toBeNull();
    storage.setItem(MEETINGS_KEY, '{oops');
    expect(store.marks('a', TEN)).toEqual([]);
    const full = { ...memory(), setItem: () => { throw new Error('full'); } } as Storage;
    expect(() => new MeetingStore(full).saveCache(null)).not.toThrow();
  });
});

describe('API client and device flow', () => {
  function fakeFetch(handler: (url: URL, init: RequestInit) => Response): { fetch: typeof fetch; calls: { url: URL; init: RequestInit }[] } {
    const calls: { url: URL; init: RequestInit }[] = [];
    return {
      calls,
      fetch: (async (input: string, init: RequestInit) => {
        const url = new URL(input);
        calls.push({ url, init });
        return handler(url, init);
      }) as typeof fetch,
    };
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  it('GET me/meetings sends UTC bounds without fractions, tz and limit, and reports 429 with Retry-After', async () => {
    const fake = fakeFetch((url) => (url.searchParams.get('limit') === '1' ? json({ error: 'rate_limited', retryAfter: 30 }, 429, { 'Retry-After': '30' }) : json({ meetings: [] })));
    const api = new TimeTrackApi({ baseUrl: 'https://beacon.example', source: 'desktop', token: 't', fetchImpl: fake.fetch });
    await api.meetings({ from: new Date(TEN + 123), to: new Date(TEN + 3600_000), tz: 'Europe/Madrid' });
    const url = fake.calls[0]?.url as URL;
    expect(url.pathname).toBe('/api/time-track/me/meetings');
    expect(url.searchParams.get('from')).toBe('2026-11-05T09:00:00Z');
    expect(url.searchParams.get('to')).toBe('2026-11-05T10:00:00Z');
    expect(url.searchParams.get('tz')).toBe('Europe/Madrid');
    expect(url.searchParams.has('limit')).toBe(false);
    await api.meetings({ from: new Date(TEN), to: new Date(TEN + 1), tz: null });
    expect(fake.calls[1]?.url.searchParams.has('tz')).toBe(false);
    const error = await api.meetings({ from: new Date(TEN), to: new Date(TEN + 1), limit: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 30 });
  });

  it('GET me keeps the 1.14 meetings and links objects; a switch marks "Track the meeting"', async () => {
    const fake = fakeFetch((url) => (url.pathname.endsWith('/me') ? json({ userId: 1, identifier: 'a', scopes: [], meetings: { status: 'connected' }, links: { calendars: 'https://b/c' } }) : json({ timer: null, entry: null }, 201)));
    const api = new TimeTrackApi({ baseUrl: 'https://beacon.example', source: 'desktop', token: 't', fetchImpl: fake.fetch });
    expect(await api.me()).toMatchObject({ meetings: { status: 'connected' }, links: { calendars: 'https://b/c' } });
    await api.switchTask('T-1', undefined, { meeting: true });
    await api.switchTask('T-2');
    expect(JSON.parse(fake.calls[1]?.init.body as string)).toEqual({ taskId: 'T-1', source: 'desktop', metadata: { origin: 'meeting' } });
    expect(JSON.parse(fake.calls[2]?.init.body as string)).toEqual({ taskId: 'T-2', source: 'desktop' });
    const bare = fakeFetch(() => json({ userId: 1, identifier: 'a', meetings: 'x', links: null }));
    expect(await new TimeTrackApi({ baseUrl: 'https://beacon.example', source: 'desktop', token: 't', fetchImpl: bare.fetch }).me()).toMatchObject({ meetings: null, links: null });
  });

  it('device flow: an older server refuses meetings:read as unknown, the sign-in goes on without it', async () => {
    const fake = fakeFetch((url, init) => {
      const body = JSON.parse(init.body as string) as { scopes?: string[] };
      if (url.pathname.endsWith('device/code')) {
        return body.scopes?.includes(MEETINGS_SCOPE) ? json({ error: 'invalid_scope' }, 400) : json({ deviceCode: 'd', userCode: 'U', verificationUri: 'https://b/device', interval: 1 });
      }
      return json({ token: 'tok', expiresAt: '', scopes: ALL_SCOPES });
    });
    const api = new TimeTrackApi({ baseUrl: 'https://beacon.example', source: 'desktop', fetchImpl: fake.fetch });
    const login = await runDeviceFlow(api, { clientName: 'x', scopes: [...ALL_SCOPES, MEETINGS_SCOPE], fallbackScopes: ALL_SCOPES, onCode: () => undefined, sleep: async () => undefined });
    expect(login.scopes).toEqual(ALL_SCOPES);
    expect(fake.calls.filter((call) => call.url.pathname.endsWith('device/code'))).toHaveLength(2);
    await expect(runDeviceFlow(api, { clientName: 'x', scopes: [MEETINGS_SCOPE], onCode: () => undefined, sleep: async () => undefined })).rejects.toBeInstanceOf(DeviceFlowError);
    const down = fakeFetch(() => json({ error: 'server_error' }, 500));
    await expect(runDeviceFlow(new TimeTrackApi({ baseUrl: 'https://beacon.example', source: 'desktop', fetchImpl: down.fetch }), { clientName: 'x', fallbackScopes: ALL_SCOPES, onCode: () => undefined })).rejects.toBeInstanceOf(ApiError);
  });
});
