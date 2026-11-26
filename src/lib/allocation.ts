import type { ActivityType, Allocation, Me, Subject, Timer } from '../api/types';

/**
 * Required time fields (owner Q5, BD-3a; TimeTrackBundle 2.1 subjects and activity types, contract v0.4).
 *
 * The server decides what is required (`GET me.features.requireActivityType` / `requireAllocation`) and enforces it at
 * the stop (`409 activity_type_required` / `allocation_required`, the timer keeps running). The person chooses when the
 * app asks: on start, on stop (default, the server's moment) or both. With "use the task's last activity type" on, a
 * start takes the activity type last used with that task on this computer (ids only, local).
 */

/** When the app asks for the required fields. */
export type AskOn = 'start' | 'stop' | 'both';
export const ASK_ON: readonly AskOn[] = ['stop', 'start', 'both'];
export const DEFAULT_ASK_ON: AskOn = 'stop';

/** At most this many tasks keep their last activity type (oldest dropped first). */
export const MAX_TASK_ACTIVITIES = 200;

const ACTIVITY_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SUBJECT_TYPE = /^[a-z][a-z0-9_]{0,31}$/;

/** A subject type the host offers (`features.subjects`). */
export interface SubjectType {
  type: string;
  label: string;
  allowsTask: boolean;
}

/** What `GET me.features` says about subjects and activity types (all off on a 2.0 server or without providers). */
export interface AllocationFeatures {
  subjects: SubjectType[];
  activityTypes: boolean;
  requireAllocation: boolean;
  requireActivityType: boolean;
}

export const NO_ALLOCATION: AllocationFeatures = { subjects: [], activityTypes: false, requireAllocation: false, requireActivityType: false };

/** Reads the 2.1 keys of `features` defensively (unknown shapes count as off). */
export function allocationFeatures(me: Me | null): AllocationFeatures {
  const raw = (me?.features ?? null) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object') return NO_ALLOCATION;
  const subjects = Array.isArray(raw.subjects)
    ? raw.subjects.flatMap((item): SubjectType[] => {
        const value = item as Partial<SubjectType> | null;
        return typeof value?.type === 'string' && SUBJECT_TYPE.test(value.type) && typeof value.label === 'string' ? [{ type: value.type, label: value.label.slice(0, 120), allowsTask: value.allowsTask === true }] : [];
      })
    : [];
  return { subjects, activityTypes: raw.activityTypes === true, requireAllocation: raw.requireAllocation === true, requireActivityType: raw.requireActivityType === true };
}

/** Subject types that can go next to a task (the desktop always tracks a task). */
export function taskSubjectTypes(features: AllocationFeatures): SubjectType[] {
  return features.subjects.filter((item) => item.allowsTask);
}

/** The fields a running time still lacks before it may be stopped (the server's rule, mirrored). */
export interface Missing {
  activityType: boolean;
  /** Only without a task (never on the desktop today); kept for the dialog's wording. */
  subject: boolean;
}

export function missingFields(features: AllocationFeatures, timer: Pick<Timer, 'taskId' | 'activityType' | 'subject'> | null): Missing {
  if (timer === null) return { activityType: false, subject: false };
  const hasActivity = timer.activityType !== null && timer.activityType !== undefined && timer.activityType.key !== '';
  const hasTask = timer.taskId !== '';
  const hasSubject = timer.subject !== null && timer.subject !== undefined;
  return { activityType: features.requireActivityType && !hasActivity, subject: features.requireAllocation && !hasTask && !hasSubject };
}

export function anyMissing(missing: Missing): boolean {
  return missing.activityType || missing.subject;
}

export function asksOnStart(askOn: AskOn): boolean {
  return askOn === 'start' || askOn === 'both';
}

export function asksOnStop(askOn: AskOn): boolean {
  return askOn === 'stop' || askOn === 'both';
}

/** The stored "ask on" setting, defaulting to the stop. */
export function sanitizeAskOn(value: unknown): AskOn {
  return value === 'start' || value === 'both' || value === 'stop' ? value : DEFAULT_ASK_ON;
}

/** Key of a task's remembered activity type: per context, because activity types belong to an organization. */
export function taskActivityKey(context: string | null, taskId: string): string {
  return `${context ?? 'personal'}|${taskId}`;
}

/** The remembered `{context|taskId: activityKey}` map: valid keys only, at most `MAX_TASK_ACTIVITIES`. */
export function sanitizeTaskActivities(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(([key, activity]) => key.length <= 400 && key.includes('|') && typeof activity === 'string' && ACTIVITY_KEY.test(activity)) as [string, string][];
  return Object.fromEntries(entries.slice(-MAX_TASK_ACTIVITIES));
}

/** Remembers `activity` for the task (moved to the end, so the oldest are dropped first). */
export function rememberTaskActivity(map: Record<string, string>, key: string, activity: string | null | undefined): Record<string, string> {
  if (activity === null || activity === undefined || !ACTIVITY_KEY.test(activity)) return map;
  if (map[key] === activity) return map;
  const next = Object.fromEntries(Object.entries(map).filter(([name]) => name !== key));
  next[key] = activity;
  return sanitizeTaskActivities(next);
}

/** The activity type a start inherits: the task's last one, if the setting is on and it is still offered. */
export function inheritedActivity(enabled: boolean, map: Record<string, string>, key: string, offered: readonly ActivityType[] | null): string | null {
  if (!enabled) return null;
  const last = map[key];
  if (last === undefined) return null;
  return offered === null || offered.some((item) => item.key === last) ? last : null;
}

/** What the dialog returns: the allocation to send (only the fields the person set). */
export function allocationOf(activityTypeKey: string | null, subject: Subject | null): Allocation {
  const allocation: Allocation = {};
  if (activityTypeKey !== null && ACTIVITY_KEY.test(activityTypeKey)) allocation.activityTypeKey = activityTypeKey;
  if (subject !== null && subject.id !== undefined) allocation.subject = { type: subject.type, id: subject.id };
  return allocation;
}

/** `409 activity_type_required` / `allocation_required` (the stop was refused, the timer keeps running). */
export function isAllocationRequired(code: string): boolean {
  return code === 'activity_type_required' || code === 'allocation_required';
}

/** Activity types grouped for the `<select>` (`group` → `<optgroup>`), in the server's order. */
export function groupActivities(list: readonly ActivityType[]): { group: string | null; items: ActivityType[] }[] {
  const groups: { group: string | null; items: ActivityType[] }[] = [];
  for (const item of list) {
    const name = item.group ?? null;
    let bucket = groups.find((entry) => entry.group === name);
    if (bucket === undefined) {
      bucket = { group: name, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(item);
  }
  return groups;
}

/** Tenant contexts of `GET me` (TimeTrackBundle 2.2 with a host policy), well-formed ones only. */
export function meContexts(me: Me | null): { contexts: { key: string; label: string }[]; context: string | null } {
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const list = Array.isArray(me?.contexts) ? (me.contexts as unknown[]) : [];
  const contexts = list.flatMap((raw) => {
    const item = raw as { key?: unknown; label?: unknown } | null;
    return typeof item?.key === 'string' && pattern.test(item.key) && typeof item.label === 'string' ? [{ key: item.key, label: item.label.slice(0, 120) }] : [];
  });
  const context = typeof me?.context === 'string' && pattern.test(me.context) ? me.context : null;
  return { contexts, context };
}
