import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/api/types';
import { MESSAGE_LOCALES, taskKind } from '../../src/lib/friendly';
import type { IdleCheckState } from '../../src/lib/idleCheck';
import { LOCK_MIN_MINUTES, lockReturn, meetingTask, pickerTasks, reassignMode, reassignWhileAsking } from '../../src/lib/idleChoices';
import { POSE_IDS } from '../../src/lib/messages/types';
import {
  BREAK_SECONDS,
  composeNudge,
  DEFAULT_NUDGE_MINUTES,
  EMPTY_NUDGE,
  NUDGE_EVERY_MINUTES,
  NUDGE_IDS,
  nudgeActionOf,
  NUDGES,
  observeActivity,
  sanitizeNudge,
  watchingActivity,
  workingNow,
} from '../../src/lib/nudge';
import { type Week, EMPTY_SCHEDULE, mergeWeek } from '../../src/lib/schedule';
import { DEFAULT_SETTINGS, loadLocal } from '../../src/lib/settings';
import { DEFAULT_RESUME_SHORTCUT } from '../../src/platform';
import { shortcutLabel } from '../../src/ui/app';

const T0 = Date.parse('2026-11-03T13:45:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

const asking = (over: Partial<Extract<IdleCheckState, { phase: 'asking' }>> = {}): Extract<IdleCheckState, { phase: 'asking' }> => ({
  phase: 'asking',
  taskId: 'T-101',
  taskTitle: 'Write onboarding guide',
  from: at(-20).toISOString(),
  askedAt: at(-10).toISOString(),
  returnedAt: at(-2).toISOString(),
  timerStartedAt: at(-60).toISOString(),
  ...over,
});

describe('three choices on return from idle', () => {
  const features = (idleReassign: boolean, backdate: boolean) => ({ idleReassign, startBackdate: backdate, stopBackdate: backdate });

  it('reassigns through the server when it can, else with backdated stops and starts, else not at all', () => {
    expect(reassignMode(features(true, true))).toBe('server');
    expect(reassignMode(features(true, false))).toBe('server');
    expect(reassignMode(features(false, true))).toBe('backdate');
    expect(reassignMode({ idleReassign: false, startBackdate: true, stopBackdate: false })).toBeNull();
    expect(reassignMode(features(false, false))).toBeNull();
  });

  it('splits the idle span into its own entry on the other task; the timer goes on from the return', () => {
    const target = { id: 'T-103', title: 'Customer call' };
    const server = reassignWhileAsking(asking(), target, at(0), 'server');
    expect(server?.state).toEqual({ phase: 'watching' });
    expect(server?.actions).toEqual([{ kind: 'idle', from: at(-20).toISOString(), to: at(-2).toISOString(), action: 'reassign', taskId: 'T-103', taskTitle: 'Customer call', then: 'continue' }]);
    const backdate = reassignWhileAsking(asking(), target, at(0), 'backdate');
    expect(backdate?.actions).toEqual([
      { kind: 'stop', at: at(-20).toISOString() },
      { kind: 'start', taskId: 'T-103', taskTitle: 'Customer call', at: at(-20).toISOString() },
      { kind: 'stop', at: at(-2).toISOString() },
      { kind: 'start', taskId: 'T-101', taskTitle: 'Write onboarding guide', at: at(-2).toISOString() },
    ]);
    // Answered before any input came back: up to now.
    const open = reassignWhileAsking(asking({ returnedAt: null }), target, at(0), 'server');
    expect(open?.actions[0]).toMatchObject({ to: at(0).toISOString() });
  });

  it('refuses a reassignment the server cannot write, or onto the same task; an empty span writes nothing', () => {
    expect(reassignWhileAsking(asking(), { id: 'T-103', title: 'x' }, at(0), null)).toBeNull();
    expect(reassignWhileAsking(asking(), { id: 'T-101', title: 'same' }, at(0), 'server')).toBeNull();
    expect(reassignWhileAsking(asking({ from: at(0).toISOString(), returnedAt: at(0).toISOString() }), { id: 'T-103', title: 'x' }, at(0), 'backdate')).toEqual({ state: { phase: 'watching' }, actions: [] });
  });

  it('offers search results first, then pinned and recent, without the task the time was on or repeats', () => {
    const task = (id: string): Task => ({ id, title: id });
    expect(pickerTasks([task('A'), task('B'), task('X')], null, 'X').map((t) => t.id)).toEqual(['A', 'B']);
    expect(pickerTasks([task('A'), task('B')], [task('C'), task('A'), task('X')], 'X').map((t) => t.id)).toEqual(['C', 'A', 'B']);
  });

  it('picks a meeting-type task for the quick "Meeting" choice (a meeting before a daily)', () => {
    const kind = (task: Task) => taskKind(task, 'en');
    const tasks: Task[] = [
      { id: 'A', title: 'Fix login' },
      { id: 'B', title: 'Daily standup' },
      { id: 'C', title: 'Customer call: Acme' },
    ];
    expect(meetingTask(tasks, kind)?.id).toBe('C');
    expect(meetingTask(tasks.slice(0, 2), kind)?.id).toBe('B');
    expect(meetingTask(tasks.slice(0, 1), kind)).toBeNull();
    expect(meetingTask([{ id: 'D', title: 'Reunión de equipo' }], (task) => taskKind(task, 'es'))?.id).toBe('D');
  });
});

describe('screen lock and sleep count as idle', () => {
  const timer = { taskId: 'T-101', taskTitle: 'Write onboarding guide', startedAt: at(-60).toISOString() };
  const settings = { thresholdMinutes: 10, answerTimeoutMinutes: 5 };

  it('a short lock asks nothing', () => {
    const step = lockReturn({ phase: 'watching' }, timer, at(-(LOCK_MIN_MINUTES - 1)), at(0), settings);
    expect(step).toEqual({ state: { phase: 'watching' }, effect: null, actions: [] });
  });

  it('a lock of a few minutes asks the three-choice question about it, already answered "back"', () => {
    const step = lockReturn({ phase: 'watching' }, timer, at(-6), at(0), settings);
    expect(step.effect).toBe('ask');
    expect(step.state).toMatchObject({ phase: 'asking', from: at(-6).toISOString(), returnedAt: at(0).toISOString(), timerStartedAt: timer.startedAt });
  });

  it('a lock longer than the threshold plus the countdown stops the timer at the lock, then asks about the gap', () => {
    const step = lockReturn({ phase: 'watching' }, timer, at(-15), at(0), settings);
    expect(step.effect).toBe('autoStop');
    expect(step.actions).toEqual([{ kind: 'stop', at: at(-15).toISOString() }]);
    expect(step.state).toMatchObject({ phase: 'gap', from: at(-15).toISOString(), to: at(0).toISOString() });
    // Never before the timer started.
    const late = lockReturn({ phase: 'watching' }, { ...timer, startedAt: at(-4).toISOString() }, at(-30), at(0), settings);
    expect(late.state).toMatchObject({ phase: 'asking', from: at(-4).toISOString() });
  });

  it('nothing without a timer, while another question is open, or with a lock time in the future', () => {
    expect(lockReturn({ phase: 'watching' }, null, at(-6), at(0), settings).effect).toBeNull();
    const open = asking();
    expect(lockReturn(open, timer, at(-6), at(0), settings).state).toBe(open);
    expect(lockReturn({ phase: 'watching' }, timer, at(1), at(0), settings).effect).toBeNull();
  });
});

describe('"Working without a timer?"', () => {
  const base = { enabled: true, running: false, working: true, prompting: false, minutes: DEFAULT_NUDGE_MINUTES };

  it('nudges after N minutes of input in a row, once, then not again for 45 minutes', () => {
    let state = EMPTY_NUDGE;
    const fired: number[] = [];
    for (let minute = 0; minute <= 120; minute++) {
      const step = observeActivity(state, { ...base, now: at(minute), idleSeconds: 4 });
      state = step.state;
      if (step.fire) fired.push(minute);
    }
    expect(fired).toEqual([10, 55, 100]);
    expect(state.lastAt).toBe(at(100).toISOString());
  });

  it('a break in the input starts the stretch again', () => {
    let state = observeActivity(EMPTY_NUDGE, { ...base, now: at(0), idleSeconds: 2 }).state;
    state = observeActivity(state, { ...base, now: at(8), idleSeconds: 2 }).state;
    state = observeActivity(state, { ...base, now: at(9), idleSeconds: BREAK_SECONDS }).state;
    expect(state.activeSince).toBeNull();
    const step = observeActivity(state, { ...base, now: at(11), idleSeconds: 2 });
    expect(step.fire).toBe(false);
    expect(step.state.activeSince).toBe(at(11).toISOString());
  });

  it('a counter stuck at 0 (the system cannot tell) never nudges', () => {
    let state = EMPTY_NUDGE;
    let fired = false;
    for (let minute = 0; minute <= 30; minute++) {
      const step = observeActivity(state, { ...base, now: at(minute), idleSeconds: 0 });
      state = step.state;
      fired ||= step.fire;
    }
    expect(fired).toBe(false);
    expect(state.measured).toBe(false);
  });

  it('only while on, outside a timer, during working hours and with no question open; the counter is not read otherwise', () => {
    for (const off of [{ enabled: false }, { running: true }, { working: false }, { prompting: true }]) {
      expect(watchingActivity({ ...base, ...off })).toBe(false);
      const step = observeActivity({ ...EMPTY_NUDGE, activeSince: at(-30).toISOString(), measured: true }, { ...base, ...off, now: at(0), idleSeconds: null });
      expect(step).toEqual({ state: { ...EMPTY_NUDGE, activeSince: null, measured: false }, fire: false });
    }
    expect(watchingActivity(base)).toBe(true);
    // Nothing to reset: the same state back.
    expect(observeActivity(EMPTY_NUDGE, { ...base, enabled: false, now: at(0), idleSeconds: null }).state).toBe(EMPTY_NUDGE);
    // A clock that went back does not block the next nudge forever.
    const back = observeActivity({ activeSince: at(-20).toISOString(), measured: true, lastAt: at(60).toISOString(), recent: [] }, { ...base, now: at(0), idleSeconds: 3 });
    expect(back.fire).toBe(true);
    expect(NUDGE_EVERY_MINUTES).toBe(45);
  });

  const week = (plan: Partial<Week[1]>): Week => mergeWeek(null, { 2: { off: false, start: '09:00', end: '18:00', lunchStart: '14:00', lunchEnd: '14:30', ...plan } }).week;

  it('knows the working hours: the day, the lunch break, days off, the time zone', () => {
    // Tuesday 2026-11-03, 14:45 in Madrid.
    const input = { now: at(0), timeZone: 'Europe/Madrid', week: week({}), daysOff: [] };
    expect(workingNow(input)).toBe(true);
    expect(workingNow({ ...input, now: at(-30) })).toBe(false);
    expect(workingNow({ ...input, now: at(-6 * 60) })).toBe(false);
    expect(workingNow({ ...input, now: at(4 * 60) })).toBe(false);
    expect(workingNow({ ...input, week: week({ lunchStart: null, lunchEnd: null }), now: at(-30) })).toBe(true);
    expect(workingNow({ ...input, week: week({ off: true }) })).toBe(false);
    expect(workingNow({ ...input, week: week({ start: null }) })).toBe(false);
    expect(workingNow({ ...input, daysOff: [{ date: '2026-11-03', kind: 'holiday', label: null, source: 'local' }] })).toBe(false);
    // Monday has no hours.
    expect(workingNow({ ...input, now: at(-24 * 60) })).toBe(false);
    expect(workingNow({ ...input, week: mergeWeek(null, EMPTY_SCHEDULE.overrides).week })).toBe(false);
  });

  it('says it with the last task and two buttons; no "Start" for a meeting or without a last task', () => {
    const last = { id: 'T-102', title: 'Review pull request queue' };
    const { note, state } = composeNudge({ locale: 'es', rng: () => 0, now: at(0), last, lastIsMeeting: false, state: EMPTY_NUDGE });
    expect(note.title).toBe('¿Trabajando sin temporizador?');
    expect(note.text).toBe('Llevas un rato a tope y no hay temporizador en marcha. ¿Lo registramos? Última tarea: Review pull request queue.');
    expect(note.pose).toBe('think');
    expect(note.resume).toEqual({ id: NUDGE_IDS.resume, label: 'Seguir con Review pull request queue', task: last });
    expect(note.choose).toEqual({ id: NUDGE_IDS.choose, label: 'Elegir tarea' });
    expect(state.recent).toEqual([0]);
    // The next one uses another line.
    expect(composeNudge({ locale: 'es', rng: () => 0, now: at(1), last, lastIsMeeting: false, state }).note.pose).toBe('peek');
    expect(composeNudge({ locale: 'en', rng: () => 0, now: at(0), last, lastIsMeeting: true, state: EMPTY_NUDGE }).note.resume).toBeNull();
    const none = composeNudge({ locale: 'en', rng: () => 0, now: at(0), last: null, lastIsMeeting: false, state: EMPTY_NUDGE }).note;
    expect(none.resume).toBeNull();
    expect(none.text).toBe("You've been busy for a while and no timer is running. Shall we track it?");
  });

  it('has its texts in the seven languages, with known poses and the task placeholders', () => {
    for (const locale of MESSAGE_LOCALES) {
      const catalog = NUDGES[locale];
      expect(catalog.lines.length, locale).toBeGreaterThanOrEqual(4);
      for (const line of catalog.lines) expect(POSE_IDS, `${locale}: ${line.text}`).toContain(line.pose);
      expect(catalog.lastTask, locale).toContain('{task}');
      expect(catalog.actions.resume, locale).toContain('{task}');
      expect(catalog.title.length, locale).toBeGreaterThan(0);
      expect(catalog.actions.choose.length, locale).toBeLessThanOrEqual(24);
    }
  });

  it('maps the notification buttons and cleans what was stored', () => {
    expect(nudgeActionOf('nudge-resume')).toBe('resume');
    expect(nudgeActionOf('nudge-choose')).toBe('choose');
    expect(nudgeActionOf('schedule-start')).toBeNull();
    expect(nudgeActionOf(7)).toBeNull();
    expect(sanitizeNudge(null)).toEqual(EMPTY_NUDGE);
    expect(sanitizeNudge({ activeSince: 'nope', lastAt: at(0).toISOString(), measured: true, recent: [1, 'x', 2.5, 3] })).toEqual({ activeSince: null, lastAt: at(0).toISOString(), measured: true, recent: [1, 3] });
  });
});

describe('settings of the quick wins', () => {
  const storage = (value: unknown) => ({ getItem: () => JSON.stringify(value), setItem: () => undefined }) as unknown as Storage;

  it('defaults: the "Continue last" shortcut, the nudge after 10 minutes and the pause on lock, all on', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ resumeShortcut: DEFAULT_RESUME_SHORTCUT, nudgeWithoutTimer: true, nudgeMinutes: 10, pauseOnLock: true });
    expect(DEFAULT_RESUME_SHORTCUT).toBe('CommandOrControl+Alt+Space');
    expect(loadLocal(storage({})).nudge).toEqual(EMPTY_NUDGE);
  });

  it('keeps valid stored values and drops invalid ones', () => {
    const kept = loadLocal(storage({ settings: { resumeShortcut: 'Alt+F9', nudgeWithoutTimer: false, nudgeMinutes: 20, pauseOnLock: false }, nudge: { lastAt: at(0).toISOString() } }));
    expect(kept.settings).toMatchObject({ resumeShortcut: 'Alt+F9', nudgeWithoutTimer: false, nudgeMinutes: 20, pauseOnLock: false });
    expect(kept.nudge.lastAt).toBe(at(0).toISOString());
    const dropped = loadLocal(storage({ settings: { resumeShortcut: '  ', nudgeWithoutTimer: 'yes', nudgeMinutes: 7, pauseOnLock: 1 } }));
    expect(dropped.settings).toMatchObject({ resumeShortcut: DEFAULT_RESUME_SHORTCUT, nudgeWithoutTimer: true, nudgeMinutes: 10, pauseOnLock: true });
  });

  it('shows shortcuts as people read them', () => {
    expect(shortcutLabel('CommandOrControl+Alt+Space', false)).toBe('Ctrl+Alt+Space');
    expect(shortcutLabel('CommandOrControl+Alt+Space', true)).toBe('⌘⌥Space');
    expect(shortcutLabel('Control+Shift+F9', false)).toBe('Ctrl+Shift+F9');
    expect(shortcutLabel('Super + Option + K', true)).toBe('⌘⌥K');
    expect(shortcutLabel('Cmd+Ctrl+X', false)).toBe('Cmd+Ctrl+X');
  });
});
