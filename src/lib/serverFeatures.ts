import type { Me } from '../api/types';

/**
 * What the connected server can do, from `GET me` (contract v0.3 §5 and §12). A 1.9 server sends neither `features`
 * nor `limits`: every 1.10 feature is then off and the idle check uses the local defaults below.
 *
 * Keep this file identical in time-track-extension and time-track-desktop.
 */
export interface ServerFeatures {
  /** `features` was present (TimeTrackBundle 1.10+). */
  known: boolean;
  startBackdate: boolean;
  stopBackdate: boolean;
  idleReassign: boolean;
  /**
   * `true` / `false`: the organisation turned the "Still there?" check on / off. `null`: a 1.9 server that says
   * nothing, so the person decides on this device (opt-in).
   */
  idleCheck: boolean | null;
  thresholdMinutes: number;
  answerTimeoutMinutes: number;
}

/** Local defaults when the server does not say (1.9): 10 minutes without input, 5 minutes to answer. */
export const DEFAULT_THRESHOLD_MINUTES = 10;
export const DEFAULT_ANSWER_TIMEOUT_MINUTES = 5;
/** Ranges of contract v0.3 §12 (the server clamps too; a client never trusts a value outside them). */
export const THRESHOLD_RANGE: readonly [number, number] = [5, 60];
export const ANSWER_TIMEOUT_RANGE: readonly [number, number] = [1, 30];

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

export function serverFeatures(me: Pick<Me, 'features' | 'limits'> | null | undefined): ServerFeatures {
  const features = me?.features ?? null;
  const idle = me?.limits?.idle_check ?? null;
  const known = features !== null;
  return {
    known,
    startBackdate: features?.start_backdate === true,
    stopBackdate: features?.stop_backdate === true,
    idleReassign: features?.idle_reassign === true,
    idleCheck: known ? features.idle_check === true : null,
    thresholdMinutes: clampInt(idle?.threshold_minutes, THRESHOLD_RANGE, DEFAULT_THRESHOLD_MINUTES),
    answerTimeoutMinutes: clampInt(idle?.answer_timeout_minutes, ANSWER_TIMEOUT_RANGE, DEFAULT_ANSWER_TIMEOUT_MINUTES),
  };
}

/**
 * Minutes without input before the prompt. The organisation sets the minimum; the person may only lengthen it, up to
 * 60 (spec 199 FR-000a).
 */
export function effectiveThreshold(features: ServerFeatures, personal: number | null | undefined): number {
  const own = typeof personal === 'number' && Number.isFinite(personal) ? Math.round(personal) : features.thresholdMinutes;
  return Math.min(THRESHOLD_RANGE[1], Math.max(features.thresholdMinutes, own));
}

/** Choices offered for the person's own threshold: the organisation's value and longer ones. */
export function thresholdChoices(features: ServerFeatures): number[] {
  return [...new Set([features.thresholdMinutes, 10, 15, 20, 30, 45, 60])].filter((m) => m >= features.thresholdMinutes).sort((a, b) => a - b);
}
