/**
 * Types of the TimeTrackBundle client API, contract v0.2 (TimeTrackBundle 1.9.0, docs/CLIENT-API.md).
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

export interface Me {
  userId: string | number;
  identifier: string;
  displayName?: string | null;
  scopes: Scope[];
  workingHours?: WorkingHours | null;
  /** Oldest client version the server still supports for this client type (TimeTrack 1.9.1+; absent before). */
  minSupportedVersion?: string | null;
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
}

export interface EntriesPage {
  entries: Entry[];
  limit: number;
  offset: number;
}

/** The user's decision about a locally detected idle period (contract §3 `timer/discard-idle`). */
export type IdleAction = 'keep' | 'discard' | 'split';

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
