/**
 * Friendly messages (0.5.0): the "Still there?" phrasings, the cheers on long stretches and the time-of-day moments.
 * Each locale has its own pools, written natively (not translated line by line). Every line carries the mascot pose
 * that goes with it (`POSE_IDS`). `wellbeing` marks a gentle health nudge (stretch, water, a short break):
 * those follow the "Wellbeing reminders" switch, the others "Fun messages".
 */

/**
 * Mascot poses of the friendly messages. Each id is drawn as `public/mascot/pose-<id>.webp` (+ `@2x`) once its art is
 * imported (`scripts/mascot/import-poses.sh`); until then `POSE_FALLBACK` in `src/ui/mascot.ts` shows the closest
 * existing pose. beach, sofa and park have no art yet.
 */
export const POSE_IDS = [
  'peek',
  'peek-2',
  'peek-3',
  'peek-4',
  'think',
  'wave',
  'sleepy',
  'heart',
  'celebrate',
  'cheer-up',
  'thumbs',
  'flag',
  'music',
  'focus',
  'working',
  'keep-going',
  'progress',
  'achievement',
  'presentation',
  'task-complete',
  'finished',
  'deadline',
  'stretch',
  'stretch-legs',
  'water',
  'eyes',
  'mindfulness',
  'rest',
  'overtime',
  'early',
  'sunrise',
  'coffee',
  'lunch',
  'moon',
  'late-working',
  'friday',
  'holiday',
  'weekend-start',
  'shades',
  'teamwork',
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
export const POOL_KINDS = [
  'idle',
  'cheer',
  'earlyBird',
  'coffee',
  'lunch',
  'lateWork',
  'friday',
  'weekend',
  'weekendRest',
  /** Cheer at the milestones (MILESTONE_HOURS, 2 h and 4 h). */
  'milestone',
  /** Cheer from OVERTIME_FROM_HOURS (6 h): "take a real break". */
  'overtime',
  /** "Still there?" while a meeting-like task runs. */
  'meetingIdle',
  /** The first card after a long meeting: coffee or a stretch. */
  'meetingAfter',
  /** With the saved notice when a daily stops. */
  'dailyDone',
] as const;
export type PoolKind = (typeof POOL_KINDS)[number];

export type Pools = Record<PoolKind, readonly Line[]>;

/** Pools that reach the person as a toast or a desktop notification (the idle phrasings go with the prompt). */
export type NoticeKind = Exclude<PoolKind, 'idle' | 'meetingIdle'>;
/** Short title of each kind of desktop notification, per locale (the line is its body). */
export type Titles = Record<NoticeKind, string>;

/** Meeting-like task kinds, detected from the task's type, labels or name (`Keywords`, per locale). */
export const TASK_KINDS = ['daily', 'meeting', 'technical', 'training'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type Keywords = Record<TaskKind, readonly string[]>;

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
