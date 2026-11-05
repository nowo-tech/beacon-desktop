import { describe, expect, it } from 'vitest';
import { MESSAGE_LOCALES } from '../../src/lib/friendly';
import {
  APP_NAMES,
  appName,
  askNote,
  ASK_GAP_MINUTES,
  callApp,
  callMinutes,
  END_GRACE_MS,
  endedNote,
  ENDED_TTL_MINUTES,
  finishMeeting,
  ignoreCall,
  inCall,
  MEETING_ACTION_IDS,
  MEETING_APPS,
  meetingActionOfId,
  meetingCandidates,
  type MeetingContext,
  type MeetingState,
  MEETINGS,
  type MicSignal,
  NO_MEETING,
  observeMic,
  parseMicSignal,
  sanitizeMeeting,
  sanitizeMuted,
  sanitizeTaskRef,
  searchTasks,
  tracking,
  withinWorkingDay,
} from '../../src/lib/meetings';
import { MEETING_ACTIONS } from '../../src/lib/messages/types';

const T0 = Date.parse('2026-11-05T09:00:00Z');
const MIN = 60_000;
const mic = (offset: number, apps: MicSignal['apps'] = ['teams'], inUse = apps.length > 0): MicSignal => ({ at: T0 + offset, inUse, apps, source: 'process' });
const ctx = (patch: Partial<MeetingContext> = {}): MeetingContext => ({ minMinutes: 2, muted: [], running: null, quiet: false, ...patch });
const DOCS = { id: 'T-101', title: 'Write onboarding guide' };
const SYNC = { id: 'T-200', title: 'Weekly sync' };

/** Feeds probes every 20 s from `from` to `to` (ms after T0) with the same apps; returns the last state and every effect. */
function run(state: MeetingState, from: number, to: number, apps: MicSignal['apps'], context: MeetingContext = ctx()) {
  const effects: { at: number; effect: string }[] = [];
  let current = state;
  for (let at = from; at <= to; at += 20_000) {
    const step = observeMic(current, mic(at, apps), context);
    current = step.state;
    if (step.effect !== 'none') effects.push({ at, effect: step.effect });
  }
  return { state: current, effects };
}

describe('microphone reports', () => {
  it('keeps only known apps and checks every field', () => {
    expect(parseMicSignal({ at: 5, inUse: true, apps: ['zoom', 'evil', 'browser'], source: 'fallback' })).toEqual({ at: 5, inUse: true, apps: ['zoom', 'browser'], source: 'fallback' });
    // Apps imply "in use"; an unknown source counts as a process report.
    expect(parseMicSignal({ at: 5, inUse: false, apps: ['teams'], source: '??' })).toEqual({ at: 5, inUse: true, apps: ['teams'], source: 'process' });
    for (const bad of [null, 'x', { at: 'now', inUse: true, apps: [] }, { at: 1, inUse: 'yes', apps: [] }, { at: 1, inUse: true }, { at: Number.NaN, inUse: true, apps: [] }]) {
      expect(parseMicSignal(bad)).toBeNull();
    }
  });

  it('picks the dedicated app before a browser, skipping muted apps', () => {
    expect(callApp(mic(0, ['browser', 'zoom']), [])).toBe('zoom');
    expect(callApp(mic(0, ['browser', 'zoom']), ['zoom'])).toBe('browser');
    expect(callApp(mic(0, ['zoom']), ['zoom'])).toBeNull();
    expect(callApp(mic(0, []), [])).toBeNull();
  });
});

describe('call state machine', () => {
  it('asks once the call lasted the configured minutes, not before', () => {
    const { state, effects } = run(NO_MEETING, 0, 3 * MIN, ['teams']);
    expect(effects).toEqual([{ at: 2 * MIN, effect: 'ask' }]);
    expect(state.phase).toBe('asking');
    expect(state.app).toBe('teams');
    expect(state.since).toBe(new Date(T0).toISOString());
    expect(state.askedAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    // With 5 minutes configured: not at 2.
    expect(run(NO_MEETING, 0, 4 * MIN, ['teams'], ctx({ minMinutes: 5 })).effects).toEqual([]);
  });

  it('a short call never asks; a mic blip inside the grace keeps counting', () => {
    let { state } = run(NO_MEETING, 0, MIN, ['zoom']);
    // Free for 40 s (a device switch), then back.
    ({ state } = run(state, MIN + 20_000, MIN + 40_000, []));
    expect(state.phase).toBe('starting');
    expect(state.releasedAt).not.toBeNull();
    const back = run(state, MIN + 60_000, 3 * MIN, ['zoom']);
    expect(back.effects).toEqual([{ at: 2 * MIN, effect: 'ask' }]);
    // Free for a whole minute: the short call is forgotten without a question.
    const short = run(run(NO_MEETING, 0, MIN, ['zoom']).state, MIN + 20_000, MIN + 20_000 + END_GRACE_MS, []);
    expect(short.state.phase).toBe('idle');
    expect(short.effects).toEqual([]);
  });

  it('no question while a meeting-like task runs, nor for muted apps, nor while quiet', () => {
    const meeting = ctx({ running: { ...SYNC, meeting: true } });
    const covered = run(NO_MEETING, 0, 5 * MIN, ['teams'], meeting);
    expect(covered.state.phase).toBe('ignored');
    expect(covered.effects).toEqual([]);
    // Muted: a muted app does not even start a call; muting it mid-call ignores it.
    expect(run(NO_MEETING, 0, 5 * MIN, ['zoom'], ctx({ muted: ['zoom'] })).state.phase).toBe('idle');
    const started = run(NO_MEETING, 0, MIN, ['zoom']).state;
    expect(observeMic(started, mic(MIN + 20_000, ['zoom']), ctx({ muted: ['zoom'] })).state.phase).toBe('ignored');
    // Quiet (paused, outside working hours): it waits, and asks once allowed during the same call.
    const quiet = run(NO_MEETING, 0, 5 * MIN, ['teams'], ctx({ quiet: true }));
    expect(quiet.effects).toEqual([]);
    expect(quiet.state.phase).toBe('starting');
    expect(observeMic(quiet.state, mic(5 * MIN + 20_000), ctx()).effect).toBe('ask');
    // A meeting task started by hand during "starting" ends it quietly.
    expect(observeMic(started, mic(MIN + 20_000, ['zoom']), meeting).state.phase).toBe('ignored');
  });

  it('rate limit: at most one question every ASK_GAP_MINUTES', () => {
    const first = run(NO_MEETING, 0, 2 * MIN, ['teams']).state;
    const ended = run(ignoreCall(first), 2 * MIN + 20_000, 2 * MIN + 20_000 + END_GRACE_MS, []).state;
    expect(ended.phase).toBe('idle');
    expect(ended.askedAt).toBe(first.askedAt);
    // A new call right away: no question until the gap has passed.
    const start = 4 * MIN;
    const second = run(ended, start, start + 9 * MIN, ['zoom']);
    const due = 2 * MIN + ASK_GAP_MINUTES * MIN;
    expect(second.effects).toEqual([{ at: Math.ceil((due - start) / 20_000) * 20_000 + start, effect: 'ask' }]);
  });

  it('answers: tracking a task, then the end question after the grace, only while its task still runs', () => {
    const asking = run(NO_MEETING, 0, 2 * MIN, ['teams']).state;
    const tracked = tracking(asking, SYNC, DOCS);
    expect(tracked.phase).toBe('tracking');
    expect(tracked.previous).toEqual(DOCS);
    expect(inCall(tracked)).toBe(true);
    const onSync = ctx({ running: { ...SYNC, meeting: false } });
    const during = run(tracked, 2 * MIN + 20_000, 32 * MIN, ['teams'], onSync).state;
    expect(during.phase).toBe('tracking');
    const end = run(during, 32 * MIN + 20_000, 33 * MIN + 40_000, [], onSync);
    expect(end.effects).toEqual([{ at: 33 * MIN + 20_000, effect: 'ended' }]);
    expect(end.state.phase).toBe('ended');
    expect(end.state.endedAt).toBe(new Date(T0 + 32 * MIN + 20_000).toISOString());
    expect(callMinutes(end.state)).toBe(32);
    expect(inCall(end.state)).toBe(false);
    // Stopped by hand before the end: nothing to ask.
    const stopped = run(during, 32 * MIN + 20_000, 34 * MIN, [], ctx({ running: null }));
    expect(stopped.effects).toEqual([]);
    expect(stopped.state.phase).toBe('idle');
    // Quiet at the end: no end question either.
    expect(run(during, 32 * MIN + 20_000, 34 * MIN, [], ctx({ running: { ...SYNC, meeting: false }, quiet: true })).state.phase).toBe('idle');
    // Previous equal to the meeting task is dropped.
    expect(tracking(asking, SYNC, SYNC).previous).toBeNull();
  });

  it('the end question goes away when answered, expired, the timer changed or a new call begins', () => {
    const asking = run(NO_MEETING, 0, 2 * MIN, ['teams']).state;
    const onSync = ctx({ running: { ...SYNC, meeting: false } });
    const ended = run(tracking(asking, SYNC, DOCS), 2 * MIN + 20_000, 5 * MIN, [], onSync).state;
    expect(ended.phase).toBe('ended');
    expect(observeMic(ended, mic(6 * MIN, []), onSync)).toEqual({ state: ended, effect: 'none' });
    expect(observeMic(ended, mic(6 * MIN + ENDED_TTL_MINUTES * MIN, []), onSync)).toMatchObject({ state: { phase: 'idle' }, effect: 'clear' });
    expect(observeMic(ended, mic(6 * MIN, []), ctx({ running: { ...DOCS, meeting: false } }))).toMatchObject({ state: { phase: 'idle' }, effect: 'clear' });
    expect(observeMic(ended, mic(6 * MIN, ['zoom']), onSync)).toMatchObject({ state: { phase: 'starting', app: 'zoom' }, effect: 'clear' });
    expect(observeMic(ended, mic(6 * MIN, ['zoom']), ctx({ running: { ...SYNC, meeting: true } }))).toMatchObject({ state: { phase: 'ignored' } });
    expect(finishMeeting(ended)).toEqual({ ...NO_MEETING, askedAt: ended.askedAt });
  });

  it('the open question: cleared when the call ends or a meeting task is started by hand', () => {
    const asking = run(NO_MEETING, 0, 2 * MIN, ['teams']).state;
    const gone = run(asking, 2 * MIN + 20_000, 2 * MIN + 20_000 + END_GRACE_MS, []);
    expect(gone.effects).toEqual([{ at: 2 * MIN + 20_000 + END_GRACE_MS, effect: 'clear' }]);
    const byHand = observeMic(asking, mic(3 * MIN), ctx({ running: { ...SYNC, meeting: true } }));
    expect(byHand.effect).toBe('clear');
    expect(byHand.state).toMatchObject({ phase: 'tracking', task: SYNC, previous: null });
    // Still asking while the call goes on.
    expect(observeMic(asking, mic(3 * MIN), ctx()).effect).toBe('none');
    // Ignored calls end quietly.
    const ignored = run(ignoreCall(asking), 3 * MIN, 3 * MIN + END_GRACE_MS + 20_000, []);
    expect(ignored.state.phase).toBe('idle');
    expect(ignored.effects).toEqual([]);
    expect(run(ignoreCall(asking), 3 * MIN, 4 * MIN, ['teams']).state.phase).toBe('ignored');
    expect(ignoreCall(NO_MEETING)).toBe(NO_MEETING);
    expect(callMinutes(NO_MEETING)).toBe(1);
  });
});

describe('questions in every language', () => {
  it('every locale has every text, the placeholders and short notification buttons', () => {
    for (const locale of MESSAGE_LOCALES) {
      const catalog = MEETINGS[locale];
      expect(catalog.ask).toContain('{app}');
      expect(catalog.askSwitch).toContain('{app}');
      expect(catalog.askSwitch).toContain('{task}');
      expect(catalog.ended).toContain('{minutes}');
      expect(catalog.ended).toContain('{task}');
      expect(catalog.endedStop).toContain('{minutes}');
      for (const action of MEETING_ACTIONS) expect(catalog.actions[action].length, `${locale} ${action}`).toBeGreaterThan(0);
      // Native buttons are capped at 24 characters (src-tauri/src/notify.rs).
      for (const action of ['generic', 'switch', 'back', 'stop'] as const) expect(catalog.actions[action].length, `${locale} ${action}`).toBeLessThanOrEqual(24);
      expect(catalog.titles.ask.length).toBeGreaterThan(0);
    }
  });

  it('composes the question and the end question (Spanish)', () => {
    expect(askNote('es', 'teams', null, null)).toEqual({
      kind: 'ask',
      title: '¿Reunión?',
      text: 'Parece que estás en una reunión (Teams). ¿Qué reunión es?',
      pose: 'teamwork',
      locale: 'es',
      actions: ['choose', 'generic', 'notMeeting', 'mute'],
      native: null,
      labels: MEETINGS.es.actions,
    });
    const switching = askNote('es', 'browser', DOCS, SYNC);
    expect(switching.text).toBe('Parece que estás en una reunión (llamada en el navegador) y el reloj sigue en Write onboarding guide. ¿Cambiamos a la reunión?');
    expect(switching.actions).toEqual(['switch', 'choose', 'notMeeting', 'mute']);
    expect(switching.native).toBe('switch');
    expect(askNote('en', 'zoom', null, SYNC).native).toBe('generic');
    expect(endedNote('es', 32, DOCS)).toMatchObject({ kind: 'ended', title: 'Reunión terminada', text: 'Reunión terminada (32 min). ¿Volver a Write onboarding guide?', actions: ['back', 'stop'], native: 'back' });
    expect(endedNote('en', 5, null)).toMatchObject({ text: 'Meeting over (5 min). Stop the timer?', actions: ['stop'], native: 'stop' });
    expect(appName('jitsi', 'de')).toBe('Jitsi Meet');
    expect(appName('browser', 'fr')).toBe('appel dans le navigateur');
    expect(Object.keys(APP_NAMES).length).toBe(MEETING_APPS.length - 1);
  });

  it('notification button ids round-trip and nothing else is accepted', () => {
    for (const [action, id] of Object.entries(MEETING_ACTION_IDS)) expect(meetingActionOfId(id)).toBe(action);
    expect(meetingActionOfId('schedule-stop')).toBeNull();
    expect(meetingActionOfId(undefined)).toBeNull();
  });
});

describe('task choice', () => {
  const tasks = [
    { id: 'A', title: 'Write docs' },
    { id: 'B', title: 'Daily standup' },
    { id: 'C', title: 'Reunión de equipo' },
    { id: 'D', title: 'Fix bug' },
  ];
  const isMeeting = (task: { title: string }) => /daily|reuni/i.test(task.title);

  it('meeting-like tasks first, each once, without the running one', () => {
    expect(meetingCandidates([[tasks[0]!], tasks], isMeeting, 'D').map((t) => t.id)).toEqual(['B', 'C', 'A']);
    expect(meetingCandidates([tasks], isMeeting, null, 2).map((t) => t.id)).toEqual(['B', 'C']);
  });

  it('search ignores case and accents', () => {
    expect(searchTasks(tasks, 'REUNION').map((t) => t.id)).toEqual(['C']);
    expect(searchTasks(tasks, '  ')).toEqual([]);
    expect(searchTasks(tasks, 'i', 2).map((t) => t.id)).toEqual(['A', 'B']);
  });

  it('working day: days off and outside start–end are quiet; no schedule is working time', () => {
    const day = { off: false, start: '09:00', end: '18:00', lunchStart: null, lunchEnd: null };
    expect(withinWorkingDay(day, 10 * 60, false)).toBe(true);
    expect(withinWorkingDay(day, 8 * 60, false)).toBe(false);
    expect(withinWorkingDay(day, 18 * 60, false)).toBe(false);
    expect(withinWorkingDay(day, 10 * 60, true)).toBe(false);
    expect(withinWorkingDay({ ...day, off: true }, 10 * 60, false)).toBe(false);
    expect(withinWorkingDay({ ...day, start: null }, 3 * 60, false)).toBe(true);
    expect(withinWorkingDay(undefined, 3 * 60, false)).toBe(true);
  });
});

describe('stored state', () => {
  it('keeps a valid call and drops anything broken', () => {
    const asking = run(NO_MEETING, 0, 2 * MIN, ['teams']).state;
    expect(sanitizeMeeting(JSON.parse(JSON.stringify(asking)))).toEqual(asking);
    const tracked = tracking(asking, SYNC, DOCS);
    expect(sanitizeMeeting(tracked)).toEqual(tracked);
    expect(sanitizeMeeting(null)).toEqual(NO_MEETING);
    expect(sanitizeMeeting({ phase: 'party' })).toEqual(NO_MEETING);
    // Incomplete: tracking without a task, ended without an end, a call without an app; the rate limit survives.
    expect(sanitizeMeeting({ ...tracked, task: null })).toEqual({ ...NO_MEETING, askedAt: asking.askedAt });
    expect(sanitizeMeeting({ ...tracked, phase: 'ended', endedAt: 'nope' }).phase).toBe('idle');
    expect(sanitizeMeeting({ ...asking, app: 'myspace' }).phase).toBe('idle');
    expect(sanitizeMuted(['zoom', 'nope', 'teams'])).toEqual(['teams', 'zoom']);
    expect(sanitizeMuted('zoom')).toEqual([]);
    expect(sanitizeTaskRef({ id: 'T', title: 'x', extra: 1 })).toEqual({ id: 'T', title: 'x' });
    expect(sanitizeTaskRef({ id: 3, title: 'x' })).toBeNull();
    expect(sanitizeTaskRef(null)).toBeNull();
  });
});
