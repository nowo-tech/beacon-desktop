import { ApiError, type TimeTrackApi } from '../api/client';
import type { Allocation, ClampReason, IdleAction, IdleThen, Timer } from '../api/types';
import { type ServerFeatures, serverFeatures } from './serverFeatures';

/**
 * Actions kept while the server cannot be reached (and the idle-check decisions), with the time they happened.
 * They are replayed in order with the real times:
 * - start at T → `timer/start {startedAt: T}` (1.10+). A 1.9 server ignores `startedAt` (no `startedAtResult`): the
 *   start is then recorded when the connection returned, and the person is told so;
 * - stop at T → `timer/stop {endedAt: T}` (1.10+), or on 1.9 `timer/discard-idle {from: T, to: now, action: discard}`
 *   (falls back to `timer/stop` when T is before the server's timer start);
 * - switch at T → stop at T, then start at T (`timer/switch` takes no time);
 * - idle → `timer/discard-idle` with the person's decision.
 * The server clamps out-of-range times and says so; every clamp is reported to the person (`ClampNote`).
 *
 * Keep this file identical in time-track-extension and time-track-desktop.
 */
export type QueuedAction = (
  | { kind: 'start'; taskId: string; taskTitle: string; at: string; note?: string; allocation?: Allocation }
  | { kind: 'stop'; at: string; note?: string; allocation?: Allocation; taskTitle?: string; startedAt?: string }
  | { kind: 'switch'; taskId: string; taskTitle: string; at: string; closing?: Allocation; allocation?: Allocation; closingTitle?: string; startedAt?: string }
  | { kind: 'idle'; from: string; to: string; action: IdleAction; taskId?: string; taskTitle?: string; then?: IdleThen; note?: string }
) & {
  /**
   * The tenant the action was recorded in (`X-Beacon-Context`, BD-3a, audit ZCD-M1): it is replayed there, never in the
   * organization shown at replay time. Absent on actions queued by older versions (replayed in the current one).
   */
  context?: string;
};

/** A time the server did not record as asked. `not_supported`: a 1.9 server recorded "now" instead. */
export interface ClampNote {
  kind: 'start' | 'stop';
  taskTitle: string | null;
  requested: string;
  applied: string;
  reason: ClampReason | 'not_supported' | null;
}

export interface SyncResult {
  synced: number;
  dropped: { action: QueuedAction; code: string }[];
  clamps: ClampNote[];
  /** The running timer after the last replayed action (`undefined`: nothing replayed). */
  timer: Timer | null | undefined;
  /**
   * The server refused a queued stop / switch for a missing required field (`409 activity_type_required` /
   * `allocation_required`, audit ZCD-M2): the action stays first in the queue (nothing after it was sent) until the
   * person answers (`withAllocation`).
   */
  blocked?: { action: QueuedAction; code: string };
}

/** Which API replays an action: bound to the action's own context (the client never changes it for a write). */
export type ApiFor = (context: string | null) => TimeTrackApi;

/** Where a client keeps the queue (localStorage on the desktop, `storage.local` in the extension). */
export interface QueueStore {
  read(): Promise<QueuedAction[]> | QueuedAction[];
  write(actions: QueuedAction[]): Promise<void> | void;
}

/** A start recorded this much later than asked, without a clamp report, is told to the person (1.9 servers). */
const UNREPORTED_MS = 60_000;

/**
 * Replays the queue, oldest first. Stops at the first network / 401 / 429 error (re-thrown; the rest stays queued);
 * other API errors drop that action and are reported. Each action is removed only once it is done, so a restart in the
 * middle replays from the first action not yet done.
 */
export function syncQueue(store: QueueStore, api: TimeTrackApi | ApiFor, now: () => Date = () => new Date(), knownFeatures?: ServerFeatures): Promise<SyncResult> {
  const apiFor: ApiFor = typeof api === 'function' ? api : () => api;
  return exclusive(() => drain(store, apiFor, now, knownFeatures));
}

/** The queued action with the person's answer to the fields the server required (audit ZCD-M2). */
export function withAllocation(action: QueuedAction, allocation: Allocation): QueuedAction {
  if (action.kind === 'stop') return { ...action, allocation: { ...action.allocation, ...allocation } };
  if (action.kind === 'switch') return { ...action, closing: { ...action.closing, ...allocation } };
  return action;
}

const ALLOCATION_REQUIRED = new Set(['activity_type_required', 'allocation_required']);

/** `dropped` code of a queued stop / switch whose timer was no longer running (audit ZCD-v-M1). */
export const STALE = 'already_stopped';

function sameSecond(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return !Number.isNaN(x) && !Number.isNaN(y) && Math.abs(x - y) < 1000;
}

/**
 * Whether the server still runs the timer a queued stop / switch is about: the one a start of this replay created
 * (`created`, matched by id), else the one that started at `startedAt` (to the second).
 */
async function stillRunning(api: TimeTrackApi, startedAt: string, created: { at: string; id: string } | null): Promise<boolean> {
  const timer = await api.timer();
  if (timer === null) return false;
  if (created !== null && sameSecond(created.at, startedAt)) return timer.id === created.id;
  return sameSecond(timer.startedAt, startedAt);
}

/** Whether a queued stop / switch is about the timer that started at `startedAt` (to the second). */
export function closesTimer(action: QueuedAction, startedAt: string): boolean {
  if ((action.kind !== 'stop' && action.kind !== 'switch') || action.startedAt === undefined) return false;
  return Math.abs(Date.parse(action.startedAt) - Date.parse(startedAt)) < 1000;
}

/** Name of the Web Lock that serialises replays (the extension's popup and background share it). */
export const QUEUE_LOCK = 'time-track-queue';
let chain: Promise<unknown> = Promise.resolve();

/**
 * One replay at a time: two at once (a reconnect event plus a refresh, or popup plus background) would send the same
 * action twice. Uses the Web Locks API when the runtime has it (shared across extension contexts), else a local chain.
 */
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: { request?: (name: string, callback: () => Promise<T>) => Promise<T> } } | undefined)?.locks;
  if (typeof locks?.request === 'function') return locks.request(QUEUE_LOCK, run);
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

async function drain(store: QueueStore, apiFor: ApiFor, now: () => Date, knownFeatures: ServerFeatures | undefined): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, dropped: [], clamps: [], timer: undefined };
  const first = (await store.read())[0];
  if (first === undefined) return result;
  const features = knownFeatures ?? (await featuresOf(apiFor(first.context ?? null)));
  // The timer a replayed start / switch of this run created: its queued time and the server's id (ZCD-v2-L1).
  let created: { at: string; id: string } | null = null;
  for (let action = (await store.read())[0]; action !== undefined; action = (await store.read())[0]) {
    try {
      // A fresh client per action, bound to the context it was recorded in.
      const api = apiFor(action.context ?? null);
      // Audit ZCD-v-M1 / v2-L1: a queued stop / switch closes only the timer it was made for. When a start / switch
      // of this replay created that timer (same queued time), the server must still run that very timer (same id; its
      // start may have been clamped); otherwise the running timer must have the stored start. Any other running
      // timer (a newer one, started live or on another device) is never stopped by it.
      if ((action.kind === 'stop' || action.kind === 'switch') && action.startedAt !== undefined && !(await stillRunning(api, action.startedAt, created))) {
        result.dropped.push({ action, code: STALE });
        await store.write((await store.read()).slice(1));
        continue;
      }
      const outcome = await replay(api, action, features, now());
      result.timer = outcome.timer;
      if ((action.kind === 'start' || action.kind === 'switch') && outcome.timer !== null) created = { at: action.at, id: outcome.timer.id };
      else if (action.kind === 'stop' || action.kind === 'idle') created = null;
      result.clamps.push(...outcome.clamps);
      result.synced++;
    } catch (error) {
      if (!(error instanceof ApiError) || error.isNetwork || error.isUnauthorized || error.status === 429) {
        throw error;
      }
      if (ALLOCATION_REQUIRED.has(error.code) && (action.kind === 'stop' || action.kind === 'switch')) {
        // Never dropped: the timer is still running on the server. Kept first until the person answers.
        result.blocked = { action, code: error.code };
        return result;
      }
      if (error.code === 'context_forbidden' && action.context !== undefined) {
        // That organization is no longer usable: its remaining actions go too (never replayed in another one).
        const context = action.context;
        const rest = await store.read();
        for (const item of rest) if (item.context === context) result.dropped.push({ action: item, code: error.code });
        await store.write(rest.filter((item) => item.context !== context));
        continue;
      }
      result.dropped.push({ action, code: error.code });
    }
    await store.write((await store.read()).slice(1));
  }
  return result;
}

/** Features for the replay; a server that cannot say (non-network error on `me`) is treated as 1.9. */
async function featuresOf(api: TimeTrackApi): Promise<ServerFeatures> {
  try {
    return serverFeatures(await api.me());
  } catch (error) {
    if (!(error instanceof ApiError) || error.isNetwork || error.isUnauthorized || error.status === 429) throw error;
    return serverFeatures(null);
  }
}

interface Outcome {
  timer: Timer | null;
  clamps: ClampNote[];
}

function notPast(at: string, now: Date): Date {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) || date > now ? now : date;
}

async function stopAt(api: TimeTrackApi, at: Date, now: Date, features: ServerFeatures, note: string | undefined, allocation?: Allocation): Promise<ClampNote[]> {
  if (features.stopBackdate) {
    const { endedAtResult } = await api.stopAt({ endedAt: at, note, allocation });
    return endedAtResult?.clamped ? [{ kind: 'stop', taskTitle: null, requested: endedAtResult.requested, applied: endedAtResult.applied, reason: endedAtResult.reason }] : [];
  }
  try {
    if (at.getTime() >= now.getTime() - 1000) {
      await api.stopAt({ note, allocation });
      return [];
    }
    if (allocation !== undefined && Object.keys(allocation).length > 0) await api.allocate(allocation);
    await api.discardIdle(at, now, 'discard');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'invalid_request') {
      await api.stopAt({ note, allocation });
      return [];
    }
    if (error instanceof ApiError && error.code === 'no_active_timer') return [];
    throw error;
  }
  return [];
}

async function startAt(api: TimeTrackApi, taskId: string, taskTitle: string, at: Date, now: Date, note: string | undefined, allocation?: Allocation): Promise<Outcome> {
  try {
    const { timer, startedAtResult } = await api.startAt(taskId, { startedAt: at, note, allocation });
    if (startedAtResult !== null) {
      return {
        timer,
        clamps: startedAtResult.clamped ? [{ kind: 'start', taskTitle, requested: startedAtResult.requested, applied: startedAtResult.applied, reason: startedAtResult.reason }] : [],
      };
    }
    return { timer, clamps: unreported(taskTitle, at, timer, now) };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'timer_running') {
      const timer = (await api.switchTask(taskId, undefined, { allocation })).timer;
      return { timer, clamps: timer !== null ? unreported(taskTitle, at, timer, now) : [] };
    }
    throw error;
  }
}

/** A 1.9 server ignored `startedAt`: tell the person when the gap is worth mentioning. */
function unreported(taskTitle: string, at: Date, timer: Timer, now: Date): ClampNote[] {
  const applied = Date.parse(timer.startedAt);
  const recorded = Number.isNaN(applied) ? now.getTime() : applied;
  return recorded - at.getTime() >= UNREPORTED_MS ? [{ kind: 'start', taskTitle, requested: at.toISOString(), applied: new Date(recorded).toISOString(), reason: 'not_supported' }] : [];
}

export async function replay(api: TimeTrackApi, action: QueuedAction, features: ServerFeatures, now: Date): Promise<Outcome> {
  switch (action.kind) {
    case 'stop':
      return { timer: null, clamps: await stopAt(api, notPast(action.at, now), now, features, action.note, action.allocation) };
    case 'switch': {
      const at = notPast(action.at, now);
      const stopped = await stopAt(api, at, now, features, undefined, action.closing);
      const started = await startAt(api, action.taskId, action.taskTitle, at, now, undefined, action.allocation);
      return { timer: started.timer, clamps: [...stopped, ...started.clamps] };
    }
    case 'start':
      return startAt(api, action.taskId, action.taskTitle, notPast(action.at, now), now, action.note, action.allocation);
    case 'idle': {
      const options = { taskId: action.taskId, then: action.then, note: action.note };
      try {
        const change = await api.discardIdle(new Date(action.from), notPast(action.to, now), action.action, options);
        return { timer: change.timer, clamps: [] };
      } catch (error) {
        if (error instanceof ApiError && error.code === 'no_active_timer') return { timer: null, clamps: [] };
        throw error;
      }
    }
  }
}

/** What the timer looks like once `actions` are done, for the screen while they wait in the queue. */
export function applyLocally(timer: Timer | null, actions: QueuedAction[]): Timer | null {
  let current = timer;
  for (const action of actions) {
    if (action.kind === 'stop') current = null;
    else if (action.kind === 'start' || action.kind === 'switch') current = { id: 'offline', taskId: action.taskId, taskTitle: action.taskTitle, startedAt: action.at };
    else if (current !== null) {
      if (action.action === 'discard' || (action.action === 'reassign' && action.then === 'stop')) current = null;
      else if (action.action === 'reassign' && action.then === 'switch' && action.taskId !== undefined) current = { id: 'offline', taskId: action.taskId, taskTitle: action.taskTitle ?? action.taskId, startedAt: action.to };
      else if (action.action === 'split' || action.action === 'reassign') current = { ...current, id: current.id, startedAt: action.to };
    }
  }
  return current;
}
