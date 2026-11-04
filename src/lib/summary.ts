import type { Entry, Task, Timer } from '../api/types';

/** Local midnight of `now`. */
export function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Local Monday 00:00 of the week of `now` (ISO weeks). */
export function startOfWeek(now: Date): Date {
  const day = startOfDay(now);
  const offset = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - offset);
}

function overlapSeconds(from: number, to: number, start: number, end: number): number {
  return Math.max(0, Math.floor((Math.min(to, end) - Math.max(from, start)) / 1000));
}

export interface Totals {
  today: number;
  week: number;
}

/**
 * Today / this-week totals in seconds from the user's own entries plus the running timer, each clipped to the period
 * (an entry that crosses midnight counts in both days). Computed locally; nothing is sent.
 */
export function computeTotals(entries: readonly Entry[], timer: Timer | null, now: Date): Totals {
  const end = now.getTime();
  const day = startOfDay(now).getTime();
  const week = startOfWeek(now).getTime();
  const spans: [number, number][] = [];
  for (const entry of entries) {
    const from = Date.parse(entry.startedAt);
    const to = Date.parse(entry.endedAt);
    if (!Number.isNaN(from) && !Number.isNaN(to)) spans.push([from, to]);
  }
  const started = timer !== null ? Date.parse(timer.startedAt) : Number.NaN;
  if (!Number.isNaN(started)) spans.push([started, end]);
  let today = 0;
  let thisWeek = 0;
  for (const [from, to] of spans) {
    today += overlapSeconds(from, to, day, end);
    thisWeek += overlapSeconds(from, to, week, end);
  }
  return { today, week: thisWeek };
}

/** Seconds tracked today on each task (for "today H:MM" on the rows). */
export function todayByTask(entries: readonly Entry[], timer: Timer | null, now: Date): Map<string, number> {
  const end = now.getTime();
  const day = startOfDay(now).getTime();
  const result = new Map<string, number>();
  const add = (taskId: string, from: number, to: number) => {
    const seconds = overlapSeconds(from, to, day, end);
    if (seconds > 0) result.set(taskId, (result.get(taskId) ?? 0) + seconds);
  };
  for (const entry of entries) add(entry.taskId, Date.parse(entry.startedAt), Date.parse(entry.endedAt));
  if (timer !== null) add(timer.taskId, Date.parse(timer.startedAt), end);
  return result;
}

/** Distinct tasks of the entries (newest first, as the API returns them), as task references. */
export function recentTasks(entries: readonly Entry[], known: readonly Task[] = [], limit = 9): Task[] {
  const byId = new Map(known.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const result: Task[] = [];
  const sorted = [...entries].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const entry of sorted) {
    if (seen.has(entry.taskId)) continue;
    seen.add(entry.taskId);
    result.push(byId.get(entry.taskId) ?? { id: entry.taskId, title: entry.taskTitle, boardId: entry.boardId ?? null });
    if (result.length >= limit) break;
  }
  return result;
}

/** `H:MM` (tray title, totals, rows). */
export function formatHoursMinutes(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** "Project · Board" with the parts that exist (`projectTitle` is optional: TimeTrackBundle 1.9 does not send it). */
export function taskContext(task: { projectTitle?: string | null; boardTitle?: string | null }): string {
  return [task.projectTitle, task.boardTitle].filter((part): part is string => typeof part === 'string' && part.trim() !== '').join(' · ');
}
