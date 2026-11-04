/**
 * Tests of the modules shared with time-track-extension (api/, lib/serverFeatures.ts, lib/idleCheck.ts,
 * lib/replay.ts). Keep this file identical in both repositories.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TimeTrackApi, clampedTime } from '../../src/api/client';
import type { Timer } from '../../src/api/types';
import { type IdleCheckState, type RunningTimer, WATCHING, decide, decideGap, observeIdle, promptSpan } from '../../src/lib/idleCheck';
import { type QueueStore, type QueuedAction, applyLocally, syncQueue } from '../../src/lib/replay';
import { effectiveThreshold, serverFeatures, thresholdChoices } from '../../src/lib/serverFeatures';
import { nodeFetch, startMock } from './helpers';

const T0 = Date.parse('2026-11-04T09:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
const settings = { thresholdMinutes: 10, answerTimeoutMinutes: 5 };
const timer: RunningTimer = { taskId: 'T-1', taskTitle: 'Write docs', startedAt: iso(0) };

function memoryStore(initial: QueuedAction[] = []): QueueStore & { actions: QueuedAction[] } {
  const store = { actions: [...initial], read: () => store.actions, write: (next: QueuedAction[]) => void (store.actions = [...next]) };
  return store;
}

describe('server features (GET me)', () => {
  it('falls back to a 1.9 server with local defaults', () => {
    expect(serverFeatures(null)).toEqual({
      known: false,
      startBackdate: false,
      stopBackdate: false,
      idleReassign: false,
      idleCheck: null,
      thresholdMinutes: 10,
      answerTimeoutMinutes: 5,
    });
  });

  it('reads 1.10 features and clamps the limits into their ranges', () => {
    const features = serverFeatures({
      features: { start_backdate: true, stop_backdate: true, idle_reassign: true, idle_check: false, workday: true, future_key: true },
      limits: { idle_check: { threshold_minutes: 2, answer_timeout_minutes: 99 } },
    });
    expect(features).toMatchObject({ known: true, startBackdate: true, idleReassign: true, idleCheck: false, thresholdMinutes: 5, answerTimeoutMinutes: 30 });
    expect(serverFeatures({ features: {}, limits: { idle_check: { threshold_minutes: 'x' as never } } })).toMatchObject({ idleCheck: false, thresholdMinutes: 10 });
  });

  it('lets the person only lengthen the threshold, up to 60', () => {
    const org = serverFeatures({ features: { idle_check: true }, limits: { idle_check: { threshold_minutes: 15 } } });
    expect(effectiveThreshold(org, null)).toBe(15);
    expect(effectiveThreshold(org, 5)).toBe(15);
    expect(effectiveThreshold(org, 30)).toBe(30);
    expect(effectiveThreshold(org, 600)).toBe(60);
    expect(thresholdChoices(org)).toEqual([15, 20, 30, 45, 60]);
    expect(thresholdChoices(serverFeatures(null))).toEqual([10, 15, 20, 30, 45, 60]);
  });
});

describe('"Still there?" state machine', () => {
  it('asks after the threshold, from the last input', () => {
    expect(observeIdle(WATCHING, timer, { now: at(9), lastInputAt: at(0.5) }, settings)).toEqual({ state: WATCHING, effect: null, actions: [] });
    const step = observeIdle(WATCHING, timer, { now: at(13), lastInputAt: at(2) }, settings);
    expect(step.effect).toBe('ask');
    expect(step.state).toEqual({ phase: 'asking', from: iso(2), askedAt: iso(12), returnedAt: null, taskId: 'T-1', taskTitle: 'Write docs', timerStartedAt: iso(0) });
    // Never before the timer start; never without a timer.
    expect(observeIdle(WATCHING, { ...timer, startedAt: iso(5) }, { now: at(14), lastInputAt: at(0) }, settings).state).toBe(WATCHING);
    expect(observeIdle(WATCHING, null, { now: at(60), lastInputAt: at(0) }, settings).state).toBe(WATCHING);
  });

  it('stops at the last input when nobody answers, then asks about the gap on return', () => {
    const asking = observeIdle(WATCHING, timer, { now: at(13), lastInputAt: at(2) }, settings).state;
    expect(observeIdle(asking, timer, { now: at(16), lastInputAt: at(2) }, settings).state).toBe(asking);
    const stopped = observeIdle(asking, timer, { now: at(17), lastInputAt: at(2) }, settings);
    expect(stopped.effect).toBe('autoStop');
    expect(stopped.actions).toEqual([{ kind: 'stop', at: iso(2) }]);
    expect(stopped.state).toEqual({ phase: 'away', from: iso(2), taskId: 'T-1', taskTitle: 'Write docs' });
    expect(observeIdle(stopped.state, null, { now: at(30), lastInputAt: at(2) }, settings).effect).toBeNull();
    const back = observeIdle(stopped.state, null, { now: at(40), lastInputAt: at(39.5) }, settings);
    expect(back.effect).toBe('askGap');
    expect(back.state).toEqual({ phase: 'gap', from: iso(2), to: iso(39.5), taskId: 'T-1', taskTitle: 'Write docs' });
    // A timer started meanwhile (elsewhere) ends the question.
    expect(observeIdle(back.state, timer, { now: at(41), lastInputAt: at(41) }, settings).state).toBe(WATCHING);
    expect(observeIdle(stopped.state, timer, { now: at(41), lastInputAt: at(41) }, settings).state).toBe(WATCHING);
  });

  it('keeps the prompt (no auto-stop) once the person is back, and drops it when the timer changes', () => {
    const asking = observeIdle(WATCHING, timer, { now: at(13), lastInputAt: at(2) }, settings).state;
    const back = observeIdle(asking, timer, { now: at(14), lastInputAt: at(13.9) }, settings).state;
    expect(back).toMatchObject({ phase: 'asking', returnedAt: iso(13.9) });
    expect(observeIdle(back, timer, { now: at(40), lastInputAt: at(40) }, settings).state).toBe(back);
    expect(observeIdle(asking, null, { now: at(14), lastInputAt: at(2) }, settings).state).toBe(WATCHING);
    expect(observeIdle(asking, { ...timer, startedAt: iso(13) }, { now: at(14), lastInputAt: at(2) }, settings).state).toBe(WATCHING);
  });

  it('counts sleep as idle: woken by input after a long sleep, the gap question comes at once', () => {
    const short = observeIdle(WATCHING, timer, { now: at(20), lastInputAt: at(19.9), suspendedSince: at(8) }, settings);
    expect(short.state).toMatchObject({ phase: 'asking', from: iso(8), returnedAt: iso(19.9) });
    const long = observeIdle(WATCHING, timer, { now: at(60), lastInputAt: at(59.9), suspendedSince: at(5) }, settings);
    expect(long.effect).toBe('autoStop');
    expect(long.actions).toEqual([{ kind: 'stop', at: iso(5) }]);
    expect(long.state).toMatchObject({ phase: 'gap', from: iso(5), to: iso(59.9) });
    expect(observeIdle(WATCHING, timer, { now: at(8), lastInputAt: at(7.9), suspendedSince: at(3) }, settings).state).toBe(WATCHING);
    // Still asleep-idle (no input since before the sleep): counted from the earlier of both.
    const locked = observeIdle(WATCHING, timer, { now: at(30), lastInputAt: at(4), suspendedSince: at(20) }, settings);
    expect(locked).toMatchObject({ effect: 'autoStop', actions: [{ kind: 'stop', at: iso(4) }] });
    const asking = observeIdle(WATCHING, timer, { now: at(13), lastInputAt: at(2) }, settings).state;
    expect(observeIdle(asking, timer, { now: at(14), lastInputAt: at(14), suspendedSince: at(14.5) }, settings).state).toBe(asking);
  });

  it('turns each answer into the decision only', () => {
    const asking = observeIdle(WATCHING, timer, { now: at(13), lastInputAt: at(2) }, settings).state as Extract<IdleCheckState, { phase: 'asking' }>;
    const span = { from: iso(2), to: iso(15) };
    expect(decide(asking, { kind: 'here' }, at(15))).toEqual({ state: WATCHING, actions: [{ kind: 'idle', ...span, action: 'keep' }], pendingNote: null });
    expect(decide(asking, { kind: 'meeting', note: '  Standup ' }, at(15))).toEqual({ state: WATCHING, actions: [{ kind: 'idle', ...span, action: 'keep' }], pendingNote: 'Standup' });
    expect(decide(asking, { kind: 'meeting', note: ' ', reassignTo: { id: 'T-2', title: 'Meetings' } }, at(15)).actions).toEqual([
      { kind: 'idle', ...span, action: 'reassign', taskId: 'T-2', taskTitle: 'Meetings', then: 'continue' },
    ]);
    expect(decide(asking, { kind: 'meeting', note: 'Call', reassignTo: { id: 'T-2', title: 'Meetings' } }, at(15)).actions[0]).toMatchObject({ note: 'Call' });
    expect(decide(asking, { kind: 'discard' }, at(15)).actions).toEqual([{ kind: 'idle', ...span, action: 'split' }]);
    expect(decide(asking, { kind: 'pause' }, at(15))).toEqual({
      state: { phase: 'resume', taskId: 'T-1', taskTitle: 'Write docs' },
      actions: [{ kind: 'idle', ...span, action: 'discard' }],
      pendingNote: null,
    });
    const returned = { ...asking, returnedAt: iso(14) };
    expect(promptSpan(returned, at(15))).toEqual({ from: at(2), to: at(14) });
    expect(promptSpan({ ...asking, returnedAt: iso(20) }, at(15)).to).toEqual(at(15));
    expect(decide(asking, { kind: 'here' }, at(1)).actions).toEqual([]);
  });

  it('answers the gap with a start and stop at the real times', () => {
    const gap = { phase: 'gap' as const, from: iso(2), to: iso(40), taskId: 'T-1', taskTitle: 'Write docs' };
    const resume = { phase: 'resume', taskId: 'T-1', taskTitle: 'Write docs' };
    expect(decideGap(gap, { kind: 'discard' })).toEqual({ state: resume, actions: [] });
    expect(decideGap(gap, { kind: 'keep' })).toEqual({
      state: resume,
      actions: [
        { kind: 'start', taskId: 'T-1', taskTitle: 'Write docs', at: iso(2) },
        { kind: 'stop', at: iso(40) },
      ],
    });
    expect(decideGap(gap, { kind: 'reassign', task: { id: 'T-2', title: 'Meetings' }, note: 'Call' }).actions).toEqual([
      { kind: 'start', taskId: 'T-2', taskTitle: 'Meetings', at: iso(2) },
      { kind: 'stop', at: iso(40), note: 'Call' },
    ]);
  });
});

describe('applyLocally (screen while offline)', () => {
  const running: Timer = { id: 't', taskId: 'T-1', taskTitle: 'A', startedAt: iso(0) };
  it('mirrors each queued action', () => {
    expect(applyLocally(running, [{ kind: 'stop', at: iso(5) }])).toBeNull();
    expect(applyLocally(null, [{ kind: 'start', taskId: 'T-2', taskTitle: 'B', at: iso(5) }])).toMatchObject({ taskId: 'T-2', startedAt: iso(5) });
    expect(applyLocally(running, [{ kind: 'switch', taskId: 'T-2', taskTitle: 'B', at: iso(5) }])).toMatchObject({ taskId: 'T-2' });
    const idle = (action: QueuedAction) => applyLocally(running, [action]);
    expect(idle({ kind: 'idle', from: iso(1), to: iso(5), action: 'keep' })).toBe(running);
    expect(idle({ kind: 'idle', from: iso(1), to: iso(5), action: 'discard' })).toBeNull();
    expect(idle({ kind: 'idle', from: iso(1), to: iso(5), action: 'split' })).toMatchObject({ taskId: 'T-1', startedAt: iso(5) });
    expect(idle({ kind: 'idle', from: iso(1), to: iso(5), action: 'reassign', taskId: 'T-2', then: 'continue' })).toMatchObject({ taskId: 'T-1', startedAt: iso(5) });
    expect(idle({ kind: 'idle', from: iso(1), to: iso(5), action: 'reassign', taskId: 'T-2', then: 'stop' })).toBeNull();
    expect(idle({ kind: 'idle', from: iso(1), to: iso(5), action: 'reassign', taskId: 'T-2', taskTitle: 'B', then: 'switch' })).toMatchObject({ taskId: 'T-2', taskTitle: 'B', startedAt: iso(5) });
    expect(idle({ kind: 'idle', from: iso(1), to: iso(5), action: 'reassign', taskId: 'T-2', then: 'switch' })).toMatchObject({ taskTitle: 'T-2' });
    expect(applyLocally(null, [{ kind: 'idle', from: iso(1), to: iso(5), action: 'split' }])).toBeNull();
  });
});

describe('client v0.3 and replay against the mock', () => {
  let env: Awaited<ReturnType<typeof startMock>>;
  let api: TimeTrackApi;
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
  type Entries = Record<string, { taskId: string; startedAt: string; endedAt: string; metadata: { note?: string } | null }[]>;
  const entries = async () => Object.values(((await env.control('state')) as { entries: Entries }).entries).flat();

  beforeAll(async () => {
    env = await startMock();
  });
  afterAll(() => env.mock.close());
  beforeEach(async () => {
    await env.control('reset', {});
    api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', fetchImpl: nodeFetch });
    api.setToken((await api.login('ada@example.com', 'app-password-123')).token);
  });

  it('reads features and limits, and validates clamp results', async () => {
    const me = await api.me();
    expect(serverFeatures(me)).toMatchObject({ known: true, startBackdate: true, stopBackdate: true, idleReassign: true, idleCheck: true });
    await env.control('config', { apiVersion: '1.9' });
    expect(serverFeatures(await api.me()).known).toBe(false);
    expect(clampedTime(null)).toBeNull();
    expect(clampedTime({ requested: 'a', applied: 'b' })).toBeNull();
    expect(clampedTime({ requested: 'a', applied: 'b', clamped: false, reason: 7 })).toEqual({ requested: 'a', applied: 'b', clamped: false, reason: null });
  });

  it('replays with the real times and reports the clamps (1.10)', async () => {
    const store = memoryStore([
      { kind: 'start', taskId: 'T-101', taskTitle: 'Guide', at: ago(600).toISOString() },
      { kind: 'stop', at: ago(300).toISOString(), note: 'Offline work' },
      // Starts before the previous entry ended: the server moves it (overlap).
      { kind: 'start', taskId: 'T-102', taskTitle: 'Review', at: ago(400).toISOString() },
      // Stops before its own start: before_start.
      { kind: 'stop', at: ago(900).toISOString() },
    ]);
    const result = await syncQueue(store, api);
    expect(result.synced).toBe(4);
    expect(store.actions).toEqual([]);
    expect(result.clamps.map((c) => [c.kind, c.reason, c.taskTitle])).toEqual([
      ['start', 'overlap', 'Review'],
      ['stop', 'before_start', null],
    ]);
    const [first, second] = await entries();
    expect(Math.abs(Date.parse(first.startedAt) - ago(600).getTime())).toBeLessThan(3000);
    expect(Math.abs(Date.parse(first.endedAt) - ago(300).getTime())).toBeLessThan(3000);
    expect(first.metadata).toEqual({ note: 'Offline work' });
    expect(second.startedAt).toBe(first.endedAt);
    expect(second.endedAt).toBe(second.startedAt);
  });

  it('replays idle decisions, including reassign, and drops what the server refuses', async () => {
    await api.startAt('T-101', { startedAt: ago(1200) });
    const store = memoryStore([
      { kind: 'idle', from: ago(1100).toISOString(), to: ago(900).toISOString(), action: 'reassign', taskId: 'T-103', taskTitle: 'Call', then: 'continue', note: 'Acme call' },
      { kind: 'idle', from: ago(600).toISOString(), to: ago(500).toISOString(), action: 'keep' },
      { kind: 'idle', from: ago(400).toISOString(), to: ago(300).toISOString(), action: 'reassign', taskId: 'T-101', then: 'continue' },
    ]);
    const result = await syncQueue(store, api);
    expect(result.synced).toBe(2);
    expect(result.dropped).toEqual([{ action: expect.objectContaining({ taskId: 'T-101' }), code: 'invalid_request' }]);
    expect(result.timer).toMatchObject({ taskId: 'T-101' });
    const decisions = ((await env.control('state')) as { idleDecisions: { action: string; taskId?: string; note?: string }[] }).idleDecisions;
    expect(decisions.map((d) => d.action)).toEqual(['reassign', 'keep']);
    expect(decisions[0]).toMatchObject({ taskId: 'T-103', note: 'Acme call' });
    expect((await entries()).map((e) => e.taskId)).toEqual(['T-101', 'T-103']);
    await api.stop();
    expect((await syncQueue(memoryStore([{ kind: 'idle', from: ago(10).toISOString(), to: ago(5).toISOString(), action: 'keep' }]), api)).timer).toBeNull();
  });

  it('falls back on a 1.9 server: start recorded on return (told), stop via discard-idle', async () => {
    await env.control('config', { apiVersion: '1.9' });
    const store = memoryStore([
      { kind: 'start', taskId: 'T-101', taskTitle: 'Guide', at: ago(600).toISOString() },
      { kind: 'stop', at: ago(1).toISOString() },
      { kind: 'start', taskId: 'T-102', taskTitle: 'Review', at: ago(10).toISOString() },
      { kind: 'switch', taskId: 'T-103', taskTitle: 'Call', at: ago(5).toISOString() },
      { kind: 'idle', from: ago(4).toISOString(), to: ago(3).toISOString(), action: 'reassign', taskId: 'T-104', then: 'continue' },
      { kind: 'stop', at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    const result = await syncQueue(store, api);
    expect(result.clamps).toEqual([expect.objectContaining({ kind: 'start', taskTitle: 'Guide', reason: 'not_supported' })]);
    expect(result.dropped.map((d) => d.code)).toEqual(['invalid_request']);
    const requests = ((await env.control('state')) as { requests: { path: string; body: string }[] }).requests;
    expect(requests.filter((r) => r.path.endsWith('discard-idle')).length).toBeGreaterThan(0);
    expect((await entries()).map((e) => e.taskId)).toEqual(['T-101', 'T-102', 'T-103']);
  });

  it('switches when a timer already runs, and treats a server without me as 1.9', async () => {
    await api.start('T-101');
    expect((await syncQueue(memoryStore([{ kind: 'start', taskId: 'T-102', taskTitle: 'B', at: new Date().toISOString() }]), api)).timer?.taskId).toBe('T-102');
    await env.control('config', { notFound: ['me'] });
    const result = await syncQueue(memoryStore([{ kind: 'stop', at: ago(2).toISOString() }]), api);
    expect(result.synced).toBe(1);
    await env.control('config', { notFound: [], failNext: { status: 429, error: 'rate_limited' } });
    await expect(syncQueue(memoryStore([{ kind: 'stop', at: ago(2).toISOString() }]), api)).rejects.toMatchObject({ status: 429 });
    expect((await syncQueue(memoryStore(), api)).synced).toBe(0);
  });
});

describe('one replay at a time', () => {
  let env: Awaited<ReturnType<typeof startMock>>;
  beforeAll(async () => {
    env = await startMock();
  });
  afterAll(() => env.mock.close());

  it('never sends an action twice when two replays start together (local chain and Web Locks)', async () => {
    const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', fetchImpl: nodeFetch });
    api.setToken((await api.login('ada@example.com', 'app-password-123')).token);
    const store = memoryStore([{ kind: 'start', taskId: 'T-101', taskTitle: 'A', at: new Date(Date.now() - 60_000).toISOString() }]);
    const [first, second] = await Promise.all([syncQueue(store, api), syncQueue(store, api)]);
    expect([first.synced, second.synced]).toEqual([1, 0]);
    await api.stop();

    const names: string[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks: { request: (name: string, callback: () => Promise<unknown>) => (names.push(name), callback()) } },
    });
    try {
      expect((await syncQueue(memoryStore([{ kind: 'start', taskId: 'T-102', taskTitle: 'B', at: new Date().toISOString() }]), api)).synced).toBe(1);
      expect(names).toEqual(['time-track-queue']);
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'navigator', original);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
    const failing = memoryStore([{ kind: 'stop', at: new Date().toISOString() }]);
    const offline = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: 'x', fetchImpl: () => Promise.reject(new Error('offline')) });
    await expect(syncQueue(failing, offline)).rejects.toMatchObject({ code: 'network_error' });
    expect((await syncQueue(memoryStore(), api)).synced).toBe(0);
  });
});
