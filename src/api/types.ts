/**
 * Types of the TimeTrackBundle client API, contract v0.3 (TimeTrackBundle 1.10.0, docs/CLIENT-API.md). Every v0.3
 * addition is optional: a 1.9 server (contract v0.2) omits it and the clients fall back (see lib/serverFeatures.ts).
 *
 * Keep this file and `client.ts` identical in time-track-extension and time-track-desktop:
 * they are the only place that knows the wire format.
 */

export type Scope = 'timer:read' | 'timer:write' | 'tasks:read' | 'entries:read';

/** Closed enum sent as `source` on timer/start (contract §3, replaces free `metadata`). */
export type ClientSource = 'extension' | 'desktop' | 'web';

export const ALL_SCOPES: readonly Scope[] = ['timer:read', 'timer:write', 'tasks:read', 'entries:read'];

export interface LoginResult {
  token: string;
  expiresAt: string;
  scopes: Scope[];
}

/**
 * Working hours as published by the host on `GET me` (optional, `null` in Beacon at first).
 * TimeTrackBundle 1.9.0 passes the host array through unchanged; this is the shape the clients understand
 * (`day`: ISO weekday, 1 = Monday … 7 = Sunday; `from` / `to`: `HH:MM` local time). Any other shape is treated
 * as "outside working hours" (fail closed: no reminders).
 */
export interface WorkingHoursSlot {
  day: number;
  from: string;
  to: string;
}

export interface WorkingHours {
  timezone?: string | null;
  slots: WorkingHoursSlot[];
}

/** One day off of `GET me.daysOff`: local date in the schedule's time zone. */
export interface DayOff {
  date: string;
  kind: 'holiday' | 'vacation';
  label?: string | null;
}

export interface Me {
  userId: string | number;
  identifier: string;
  displayName?: string | null;
  scopes: Scope[];
  workingHours?: WorkingHours | null;
  /**
   * Holidays and vacations of the user (proposed for TimeTrackBundle, not sent by 1.11): no working-hours reminders on
   * them. Read defensively by lib/schedule.ts (`beaconDaysOff`).
   */
  daysOff?: DayOff[] | null;
  /** Oldest client version the server still supports for this client type (TimeTrack 1.9.1+; absent before). */
  minSupportedVersion?: string | null;
  /** Feature switches (1.10+; absent on 1.9). Unknown keys are ignored; a missing or `false` key means "off". */
  features?: Features | null;
  /** Policy numbers (1.10+; absent on 1.9). */
  limits?: Limits | null;
}

/** `GET me.features` (contract v0.3 §5): an object of booleans that may grow. */
export interface Features {
  task_details?: boolean;
  start_backdate?: boolean;
  stop_backdate?: boolean;
  idle_reassign?: boolean;
  idle_check?: boolean;
  /** `discard-idle` `keep` accepts an optional `note` (TimeTrackBundle 1.10.x). */
  idle_keep_note?: boolean;
  /** Reserved, always false in 1.10. */
  workday?: boolean;
  /** Reserved, always false in 1.10. */
  monitoring?: boolean;
  [key: string]: boolean | undefined;
}

/** `GET me.limits` (contract v0.3 §5 and §12). */
export interface Limits {
  backdate?: { max_seconds?: number; clock_skew_seconds?: number } | null;
  idle_check?: {
    threshold_minutes?: number;
    answer_timeout_minutes?: number;
    /** The person may turn the check off (personal accounts). Absent = false (organisation policy). */
    user_can_disable?: boolean;
  } | null;
}

/** Why the server moved a requested `startedAt` / `endedAt` (contract v0.3 §4.2 and §4.4). */
export type ClampReason = 'future' | 'overlap' | 'max_backdate' | 'disabled' | 'before_start';

/** `startedAtResult` / `endedAtResult`: what was asked, what was stored and why. */
export interface ClampedTime {
  requested: string;
  applied: string;
  clamped: boolean;
  reason: ClampReason | null;
}

export interface Task {
  id: string;
  title: string;
  boardId?: string | null;
  boardTitle?: string | null;
  /** Project of the task (optional; proposed for Beacon's TaskProvider bridge, absent in TimeTrackBundle 1.9). */
  projectId?: string | null;
  projectTitle?: string | null;
  /**
   * Absolute URL of the task page in the host app (optional; Beacon adds it through its TaskProvider bridge, older
   * servers omit it). Clients only open it when it is https on the connected server's origin.
   */
  url?: string | null;
}

/** `metadata` of timers and entries: only `note` is set by these clients (free metadata is rejected). */
export interface Metadata {
  note?: string;
  [key: string]: unknown;
}

export interface Timer {
  id: string;
  taskId: string;
  taskTitle: string;
  boardId?: string | null;
  /** Optional context, as on `Task` (absent in TimeTrackBundle 1.9). */
  boardTitle?: string | null;
  projectId?: string | null;
  projectTitle?: string | null;
  startedAt: string;
  lastHeartbeatAt?: string | null;
  clientType?: string | null;
  metadata?: Metadata | null;
  /** Absolute URL of the task page (optional, same rules as `Task.url`). */
  url?: string | null;
}

export interface Entry {
  id: string;
  taskId: string;
  taskTitle: string;
  boardId?: string | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  source?: string | null;
  metadata?: Metadata | null;
}

/** `timer/switch` (201) and `timer/discard-idle` (200): the closed entry (if any) and the running timer (if any). */
export interface TimerChange {
  entry: Entry | null;
  timer: Timer | null;
  /** `discard-idle` with `reassign` (1.10+): the entry written on the other task. */
  reassigned?: Entry | null;
}

/** `timer/start` (201). `startedAtResult` is present only when the request had `startedAt` and the server knows it. */
export interface StartResult {
  timer: Timer;
  startedAtResult: ClampedTime | null;
}

/** `timer/stop` (200). `entry` is null when no timer was running; `endedAtResult` as for `StartResult`. */
export interface StopResult {
  entry: Entry | null;
  endedAtResult: ClampedTime | null;
}

export interface EntriesPage {
  entries: Entry[];
  limit: number;
  offset: number;
}

/** The user's decision about a locally detected idle period (contract §3 `timer/discard-idle`; `reassign` 1.10+). */
export type IdleAction = 'keep' | 'discard' | 'split' | 'reassign';

/** What runs after a reassigned span (contract v0.3 §3.1). */
export type IdleThen = 'continue' | 'stop' | 'switch';

/**
 * Extra fields of `discard-idle`: for `reassign` the other task (required), what runs next and an optional note; for
 * `keep` an optional note when the server has `features.idle_keep_note`. Ignored for the other actions.
 */
export interface IdleOptions {
  taskId?: string;
  then?: IdleThen;
  note?: string;
}

export type ExportFormat = 'csv' | 'json';

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export type DeviceTokenResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'invalid_scope' }
  | ({ status: 'approved' } & LoginResult);

export interface EntryQuery {
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface TaskQuery {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}
