import type { ReminderAction, ReminderLineKind } from '../schedule';
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
  // Empty states of the main list (src/lib/emptyStates.ts), each with a variant with a light outer stroke for the dark
  // theme (`-dark`; without one the light art is used in both themes).
  'empty-pinned',
  'empty-recent',
  'empty-tasks',
  'empty-pinned-dark',
  'empty-recent-dark',
  'empty-tasks-dark',
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

/**
 * Working-hours reminders (`src/lib/schedule.ts`), per locale: a few phrasings per moment, the notification titles, the
 * button labels, and the two short add-ons (`{task}` = the last task, `{total}` = `H:MM` tracked today).
 */
export interface ReminderCatalog {
  lines: Record<ReminderLineKind, readonly Line[]>;
  titles: Record<ReminderLineKind, string>;
  actions: Record<ReminderAction, string>;
  /** After the start line, when there is a task to resume. */
  lastTask: string;
  /** After the end line. */
  today: string;
}

/**
 * "Working without a timer?" (`src/lib/nudge.ts`), per locale: a few phrasings with their pose, the notification
 * title, the add-on with the last task (`{task}`) and the two button labels (`{task}` in `resume`).
 */
export interface NudgeCatalog {
  lines: readonly Line[];
  title: string;
  lastTask: string;
  actions: { resume: string; choose: string };
}
