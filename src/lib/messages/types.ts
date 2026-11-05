/**
 * Friendly messages (0.5.0): the "Still there?" phrasings, the cheers on long stretches and the time-of-day moments.
 * Each locale has its own pools, written natively (not translated line by line). Every line carries the mascot pose
 * that goes with it (`POSE_IDS`). `wellbeing` marks a gentle health nudge (stretch, water, a short break):
 * those follow the "Wellbeing reminders" switch, the others "Fun messages".
 */

/**
 * Mascot poses of the friendly messages. Each id is drawn as `public/mascot/pose-<id>.webp` (+ `@2x`) once its art is
 * imported (`scripts/mascot/import-poses.sh`); until then `POSE_FALLBACK` in `src/ui/mascot.ts` shows the closest
 * existing pose.
 */
export const POSE_IDS = [
  'peek',
  'sleepy',
  'wave',
  'think',
  'heart',
  'celebrate',
  'thumbs',
  'flag',
  'music',
  'focus',
  'stretch',
  'water',
  'eyes',
  'sunrise',
  'coffee',
  'lunch',
  'moon',
  'friday',
  'weekend-start',
  'shades',
  'beach',
  'sofa',
  'park',
] as const;

export type PoseId = (typeof POSE_IDS)[number];

export interface Line {
  text: string;
  pose: PoseId;
  wellbeing?: true;
}

/** Pool kinds. `idle` is the "Still there?" phrasing; the rest are the cheer card. */
export const POOL_KINDS = ['idle', 'cheer', 'earlyBird', 'coffee', 'lunch', 'lateWork', 'friday', 'weekend', 'weekendRest'] as const;
export type PoolKind = (typeof POOL_KINDS)[number];

export type Pools = Record<PoolKind, readonly Line[]>;

/**
 * Local-time windows of the time-of-day moments, in minutes since midnight. `lateFrom` → `lateUntil` wraps past
 * midnight. Per locale, so a Spanish lunch is at 14:00 and a German coffee at 15:00.
 */
export interface Windows {
  /** A timer started before this time today (and after `lateUntil`: 01:00 is late work) is an early start. */
  earlyBefore: number;
  /** Early-start message only before this time (the morning of that day). */
  earlyUntil: number;
  coffeeAm: [number, number];
  coffeePm: [number, number];
  lunch: [number, number];
  lateFrom: number;
  lateUntil: number;
  /** Friday afternoon from this time (until `lateFrom`). */
  fridayFrom: number;
}

export const hm = (hours: number, minutes = 0): number => hours * 60 + minutes;

/** A fun line. */
export const f = (text: string, pose: PoseId): Line => ({ text, pose });
/** A wellbeing line. */
export const w = (text: string, pose: PoseId): Line => ({ text, pose, wellbeing: true });
