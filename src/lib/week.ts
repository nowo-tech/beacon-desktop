import type { Entry, Timer } from '../api/types';
import { startOfDay, startOfWeek } from './summary';

/** A stretch of tracked time on one day (an entry or the running timer, clipped to that day). */
export interface DaySpan {
  taskId: string;
  taskTitle: string;
  from: Date;
  to: Date;
  seconds: number;
  /** The running timer (`to` is now). */
  running: boolean;
}

export interface DayTotal {
  /** Local midnight of the day. */
  date: Date;
  seconds: number;
}

function spans(entries: readonly Entry[], timer: Timer | null, now: Date): Omit<DaySpan, 'seconds'>[] {
  const result: Omit<DaySpan, 'seconds'>[] = [];
  for (const entry of entries) {
    const from = Date.parse(entry.startedAt);
    const to = Date.parse(entry.endedAt);
    if (!Number.isNaN(from) && !Number.isNaN(to) && to > from) result.push({ taskId: entry.taskId, taskTitle: entry.taskTitle, from: new Date(from), to: new Date(to), running: false });
  }
  const started = timer !== null ? Date.parse(timer.startedAt) : Number.NaN;
  if (timer !== null && !Number.isNaN(started) && now.getTime() > started) {
    result.push({ taskId: timer.taskId, taskTitle: timer.taskTitle, from: new Date(started), to: now, running: true });
  }
  return result;
}

function clip(span: Omit<DaySpan, 'seconds'>, dayStart: number, dayEnd: number): DaySpan | null {
  const from = Math.max(span.from.getTime(), dayStart);
  const to = Math.min(span.to.getTime(), dayEnd);
  if (to <= from) return null;
  return { ...span, from: new Date(from), to: new Date(to), seconds: Math.floor((to - from) / 1000) };
}

/** Day after `day` at local midnight (DST-safe: built from the calendar date, not by adding 24 h). */
function nextDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
}

/** Today's stretches (oldest first), optionally of one task; computed locally from the user's own entries. */
export function todaySpans(entries: readonly Entry[], timer: Timer | null, now: Date, taskId?: string): DaySpan[] {
  const day = startOfDay(now).getTime();
  const end = Math.min(nextDay(startOfDay(now)).getTime(), now.getTime());
  return spans(entries, timer, now)
    .filter((span) => taskId === undefined || span.taskId === taskId)
    .map((span) => clip(span, day, end))
    .filter((span): span is DaySpan => span !== null)
    .sort((a, b) => a.from.getTime() - b.from.getTime());
}

/** The seven days of this week (Monday first) with the time tracked on each, up to now. */
export function weekDays(entries: readonly Entry[], timer: Timer | null, now: Date): DayTotal[] {
  const all = spans(entries, timer, now);
  const days: DayTotal[] = [];
  let day = startOfWeek(now);
  for (let i = 0; i < 7; i++) {
    const next = nextDay(day);
    const start = day.getTime();
    const end = Math.min(next.getTime(), now.getTime());
    const seconds = all.reduce((sum, span) => sum + (clip(span, start, end)?.seconds ?? 0), 0);
    days.push({ date: day, seconds });
    day = next;
  }
  return days;
}

/** Seconds tracked this week on each task (for the detail pane). */
export function weekByTask(entries: readonly Entry[], timer: Timer | null, now: Date): Map<string, number> {
  const start = startOfWeek(now).getTime();
  const result = new Map<string, number>();
  for (const span of spans(entries, timer, now)) {
    const seconds = clip(span, start, now.getTime())?.seconds ?? 0;
    if (seconds > 0) result.set(span.taskId, (result.get(span.taskId) ?? 0) + seconds);
  }
  return result;
}
