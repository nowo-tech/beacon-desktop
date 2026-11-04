import type { QueuedAction } from './replay';

/**
 * "Still there?" check (Beacon spec 199 block 0), as a pure state machine shared by the desktop app and the extension.
 *
 * Privacy: the only input is the time of the last keyboard / mouse input, read locally from the OS or the browser on
 * every check. It is never stored, logged or sent. What reaches the server is the person's decision only (a
 * `timer/discard-idle` action, or a start / stop at a given time), built by `decide()` below.
 *
 * Flow:
 * 1. `watching`: a timer runs. After `thresholdMinutes` without input → `asking` (the prompt).
 * 2. `asking`: the person answers (`decide`). If they are still away `answerTimeoutMinutes` after the prompt, the
 *    timer stops at the last input (`autoStop` effect) → `away`. If they come back without answering, the prompt
 *    stays and nothing is stopped.
 * 3. `away`: on the next input → `gap`: what to do with the time between the last input and the return.
 * 4. `gap`: answered with `decideGap` → `resume`: offers to start the task again.
 *
 * A screen lock keeps the OS idle counter running, so it counts as idle; a system sleep is detected by the caller
 * from a jump of the clock between two checks (`suspendedSince`) and counts as idle from the last check before it.
 *
 * Keep this file identical in time-track-extension and time-track-desktop.
 */

export interface RunningTimer {
  taskId: string;
  taskTitle: string;
  startedAt: string;
}

interface Base {
  /** Last input before the idle span (ISO). Never before the timer start. */
  from: string;
  taskId: string;
  taskTitle: string;
}

export type IdleCheckState =
  | { phase: 'watching' }
  | (Base & { phase: 'asking'; askedAt: string; returnedAt: string | null; timerStartedAt: string })
  | (Base & { phase: 'away' })
  | (Base & { phase: 'gap'; to: string })
  | { phase: 'resume'; taskId: string; taskTitle: string };

export const WATCHING: IdleCheckState = { phase: 'watching' };

export interface IdleSettings {
  thresholdMinutes: number;
  answerTimeoutMinutes: number;
}

export interface IdleObservation {
  now: Date;
  /** Last keyboard / mouse input (local only). */
  lastInputAt: Date;
  /** Time of the previous check when the device slept since then; the sleep counts as idle. */
  suspendedSince?: Date | null;
}

export type IdleEffect = 'ask' | 'autoStop' | 'askGap' | null;

export interface IdleStep {
  state: IdleCheckState;
  effect: IdleEffect;
  /** For `autoStop`: what to replay (stop at the last input). */
  actions: QueuedAction[];
}

/** Input within this margin of `from` is the same input (OS counters are rounded to the second). */
const SAME_INPUT_MS = 5000;

const iso = (time: number) => new Date(time).toISOString();

function stay(state: IdleCheckState): IdleStep {
  return { state, effect: null, actions: [] };
}

/** One check, every ~30 s while the app runs (and on wake). */
export function observeIdle(state: IdleCheckState, timer: RunningTimer | null, observation: IdleObservation, settings: IdleSettings): IdleStep {
  const now = observation.now.getTime();
  const threshold = settings.thresholdMinutes * 60_000;
  const timeout = settings.answerTimeoutMinutes * 60_000;
  const suspended = observation.suspendedSince?.getTime() ?? null;
  const lastInput = Math.min(observation.lastInputAt.getTime(), now);

  switch (state.phase) {
    case 'watching': {
      if (timer === null) return stay(state);
      const start = Date.parse(timer.startedAt);
      const base = { taskId: timer.taskId, taskTitle: timer.taskTitle };
      // Woken from sleep by an input: the away span is already over.
      if (suspended !== null && suspended < lastInput) {
        const from = Math.max(suspended, start);
        if (lastInput - from < threshold) return stay(state);
        if (lastInput - from >= threshold + timeout) {
          return autoStop({ ...base, phase: 'gap', from: iso(from), to: iso(lastInput) }, from);
        }
        return { state: { ...base, phase: 'asking', from: iso(from), askedAt: iso(from + threshold), returnedAt: iso(lastInput), timerStartedAt: timer.startedAt }, effect: 'ask', actions: [] };
      }
      const from = Math.max(suspended !== null ? Math.min(suspended, lastInput) : lastInput, start);
      if (now - from < threshold) return stay(state);
      const askedAt = from + threshold;
      if (now - askedAt >= timeout) return autoStop({ ...base, phase: 'away', from: iso(from) }, from);
      return { state: { ...base, phase: 'asking', from: iso(from), askedAt: iso(askedAt), returnedAt: null, timerStartedAt: timer.startedAt }, effect: 'ask', actions: [] };
    }
    case 'asking': {
      if (timer === null || timer.startedAt !== state.timerStartedAt) return stay(WATCHING);
      if (state.returnedAt !== null) return stay(state);
      const from = Date.parse(state.from);
      if (lastInput > from + SAME_INPUT_MS && (suspended === null || lastInput > suspended)) {
        return stay({ ...state, returnedAt: iso(lastInput) });
      }
      if (now - Date.parse(state.askedAt) >= timeout) {
        return autoStop({ phase: 'away', from: state.from, taskId: state.taskId, taskTitle: state.taskTitle }, from);
      }
      return stay(state);
    }
    case 'away': {
      if (timer !== null) return stay(WATCHING);
      if (lastInput > Date.parse(state.from) + SAME_INPUT_MS) {
        return { state: { ...state, phase: 'gap', to: iso(lastInput) }, effect: 'askGap', actions: [] };
      }
      return stay(state);
    }
    case 'gap':
    case 'resume':
      // Started something else meanwhile: the question no longer applies (the gap stays unrecorded).
      return stay(timer !== null ? WATCHING : state);
  }
}

function autoStop(state: IdleCheckState, from: number): IdleStep {
  return { state, effect: 'autoStop', actions: [{ kind: 'stop', at: iso(from) }] };
}

/** Answers to the prompt. `meeting` keeps the time (the note goes on the entry when it stops) or reassigns it. */
export type IdleChoice =
  | { kind: 'here' }
  | { kind: 'meeting'; note?: string; reassignTo?: { id: string; title: string } }
  | { kind: 'discard' }
  | { kind: 'pause' };

export interface Decision {
  state: IdleCheckState;
  actions: QueuedAction[];
  /** Note to attach to the running entry when it stops ("I was in a meeting", kept on the same task). */
  pendingNote: string | null;
}

/** The span of the prompt: from the last input to the return (or now, when the answer comes first). */
export function promptSpan(state: Extract<IdleCheckState, { phase: 'asking' }>, now: Date): { from: Date; to: Date } {
  const from = new Date(state.from);
  const to = state.returnedAt !== null ? new Date(state.returnedAt) : now;
  return { from, to: to.getTime() > now.getTime() ? now : to };
}

/**
 * `keepNote`: the server takes a note on `keep` (`features.idle_keep_note`), so a "meeting" note on the same task is
 * sent with the decision; without it the note waits locally for the next stop / switch (`pendingNote`).
 */
export function decide(state: Extract<IdleCheckState, { phase: 'asking' }>, choice: IdleChoice, now: Date, options: { keepNote?: boolean } = {}): Decision {
  const { from, to } = promptSpan(state, now);
  const span = { from: from.toISOString(), to: to.toISOString() };
  const note = choice.kind === 'meeting' ? choice.note?.trim() || null : null;
  if (to.getTime() <= from.getTime()) return { state: WATCHING, actions: [], pendingNote: note };
  switch (choice.kind) {
    case 'here':
      return { state: WATCHING, actions: [{ kind: 'idle', ...span, action: 'keep' }], pendingNote: null };
    case 'meeting':
      if (choice.reassignTo !== undefined) {
        return {
          state: WATCHING,
          actions: [{ kind: 'idle', ...span, action: 'reassign', taskId: choice.reassignTo.id, taskTitle: choice.reassignTo.title, then: 'continue', ...(note !== null ? { note } : {}) }],
          pendingNote: null,
        };
      }
      if (note !== null && options.keepNote === true) {
        return { state: WATCHING, actions: [{ kind: 'idle', ...span, action: 'keep', note }], pendingNote: null };
      }
      return { state: WATCHING, actions: [{ kind: 'idle', ...span, action: 'keep' }], pendingNote: note };
    case 'discard':
      return { state: WATCHING, actions: [{ kind: 'idle', ...span, action: 'split' }], pendingNote: null };
    case 'pause':
      return { state: { phase: 'resume', taskId: state.taskId, taskTitle: state.taskTitle }, actions: [{ kind: 'idle', ...span, action: 'discard' }], pendingNote: null };
  }
}

/** Answers to the gap question (timer already stopped at the last input). Keeping needs a 1.10 server (backdating). */
export type GapChoice = { kind: 'keep' } | { kind: 'reassign'; task: { id: string; title: string }; note?: string } | { kind: 'discard' };

export function decideGap(state: Extract<IdleCheckState, { phase: 'gap' }>, choice: GapChoice): { state: IdleCheckState; actions: QueuedAction[] } {
  const next: IdleCheckState = { phase: 'resume', taskId: state.taskId, taskTitle: state.taskTitle };
  if (choice.kind === 'discard') return { state: next, actions: [] };
  const task = choice.kind === 'keep' ? { id: state.taskId, title: state.taskTitle } : choice.task;
  const note = choice.kind === 'reassign' ? choice.note?.trim() || undefined : undefined;
  return {
    state: next,
    actions: [
      { kind: 'start', taskId: task.id, taskTitle: task.title, at: state.from },
      { kind: 'stop', at: state.to, ...(note !== undefined ? { note } : {}) },
    ],
  };
}
