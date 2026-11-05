import type { Task } from '../api/types';
import type { TaskKind } from './messages/types';
import { type IdleCheckState, type IdleSettings, type IdleStep, type RunningTimer, WATCHING, observeIdle, promptSpan } from './idleCheck';
import type { QueuedAction } from './replay';
import type { ServerFeatures } from './serverFeatures';

/**
 * The three answers on return from idle (desktop 0.5): **Keep** the idle time, **Discard** it (the timer stops at the
 * start of the idle time), or **Reassign** it — the idle span becomes its own entry on another task (pinned, recent,
 * a search, or a quick "Meeting" task) and the timer goes on with the same task from the return. They extend the
 * shared state machine of `idleCheck.ts` (kept identical with the extension) without changing it; the entries go
 * through the same queue and API client as every other start / stop, so the server validates them as usual.
 *
 * Also: the screen lock / system sleep (OS events, `src-tauri/src/session.rs`) counts as idle from the moment it
 * started, and the same question is asked on return (`lockReturn`).
 */

export interface TaskRef {
  id: string;
  title: string;
}

/**
 * How a reassignment can be written: `server` (`discard-idle` `reassign`, TimeTrackBundle 1.10 `features.idle_reassign`),
 * `backdate` (stop and start at given times, `start_backdate` + `stop_backdate`), or `null` (a 1.9 server: not offered).
 */
export type ReassignMode = 'server' | 'backdate' | null;

export function reassignMode(features: Pick<ServerFeatures, 'idleReassign' | 'startBackdate' | 'stopBackdate'>): ReassignMode {
  if (features.idleReassign) return 'server';
  return features.startBackdate && features.stopBackdate ? 'backdate' : null;
}

/**
 * "Reassign" while asking "Still there?": the span (last input → return) goes to `target`, the running task goes on
 * from the return. `null` when the server cannot write it (`mode` null) or the target is the running task.
 */
export function reassignWhileAsking(
  state: Extract<IdleCheckState, { phase: 'asking' }>,
  target: TaskRef,
  now: Date,
  mode: ReassignMode,
): { state: IdleCheckState; actions: QueuedAction[] } | null {
  if (mode === null || target.id === state.taskId) return null;
  const { from, to } = promptSpan(state, now);
  if (to.getTime() <= from.getTime()) return { state: WATCHING, actions: [] };
  const span = { from: from.toISOString(), to: to.toISOString() };
  if (mode === 'server') {
    return { state: WATCHING, actions: [{ kind: 'idle', ...span, action: 'reassign', taskId: target.id, taskTitle: target.title, then: 'continue' }] };
  }
  // Without the server's reassign: close the entry at the last input, the other task from then to the return, and the
  // same task again from the return (four ordinary, backdated starts and stops).
  return {
    state: WATCHING,
    actions: [
      { kind: 'stop', at: span.from },
      { kind: 'start', taskId: target.id, taskTitle: target.title, at: span.from },
      { kind: 'stop', at: span.to },
      { kind: 'start', taskId: state.taskId, taskTitle: state.taskTitle, at: span.to },
    ],
  };
}

/**
 * The tasks the picker offers: pinned and recent first, then the search results, without `exclude` (the task the time
 * was on) and without repeats.
 */
export function pickerTasks(quick: readonly Task[], results: readonly Task[] | null, exclude: string): Task[] {
  const seen = new Set<string>([exclude]);
  const result: Task[] = [];
  for (const task of [...(results ?? []), ...quick]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    result.push(task);
  }
  return result;
}

const MEETING_ORDER: readonly TaskKind[] = ['meeting', 'daily', 'technical', 'training'];

/** The quick "Meeting" choice: the first meeting-type task of `tasks` (a meeting before a daily, …), or null. */
export function meetingTask(tasks: readonly Task[], kindOf: (task: Task) => TaskKind | null): Task | null {
  let best: { task: Task; rank: number } | null = null;
  for (const task of tasks) {
    const kind = kindOf(task);
    if (kind === null) continue;
    const rank = MEETING_ORDER.indexOf(kind);
    if (best === null || rank < best.rank) best = { task, rank };
  }
  return best?.task ?? null;
}

/** A screen lock or sleep this short is not asked about. */
export const LOCK_MIN_MINUTES = 2;

/**
 * Back from a screen lock or a system sleep that started at `lockedAt`: that time counts as idle. Shorter than
 * `LOCK_MIN_MINUTES`: nothing. Longer than the usual threshold plus the countdown: the timer stops at the lock and the
 * "welcome back" question follows (as after an automatic stop). Otherwise the "Still there?" question, already
 * answered "back" (no countdown). Only while a timer runs and nobody is being asked already.
 */
export function lockReturn(state: IdleCheckState, timer: RunningTimer | null, lockedAt: Date, now: Date, settings: IdleSettings): IdleStep {
  if (state.phase !== 'watching' || timer === null || lockedAt.getTime() >= now.getTime()) return { state, effect: null, actions: [] };
  const autoStopAfter = settings.thresholdMinutes + settings.answerTimeoutMinutes;
  return observeIdle(WATCHING, timer, { now, lastInputAt: now, suspendedSince: lockedAt }, { thresholdMinutes: LOCK_MIN_MINUTES, answerTimeoutMinutes: Math.max(1, autoStopAfter - LOCK_MIN_MINUTES) });
}
