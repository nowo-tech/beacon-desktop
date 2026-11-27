/** Pure helpers of the Tasks module: dates, the quick-add syntax, My tasks groups, card labels. */
import type { TasksText } from './i18n';
import type { Priority, TaskCard } from './types';

/** The local date `YYYY-MM-DD` of `now` (what `GET my-tasks?today=` expects). */
export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whole days from `today` (`YYYY-MM-DD`) to the date part of `iso` (an all-day date is a UTC midnight). */
export function dayDiff(iso: string, today: string, allDay: boolean): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const date = allDay ? iso.slice(0, 10) : localDate(at);
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export interface DueInfo {
  label: string;
  /** `over` (past), `today`, `` (later). */
  tone: 'over' | 'today' | '';
  diff: number;
}

export function dueInfo(task: Pick<TaskCard, 'dueAt' | 'allDay'>, today: string, t: TasksText, locale: string): DueInfo | null {
  if (task.dueAt === null) return null;
  const diff = dayDiff(task.dueAt, today, task.allDay);
  if (diff === null) return null;
  let label: string;
  if (diff === 0) label = t('dueToday');
  else if (diff === 1) label = t('dueTomorrow');
  else if (diff === -1) label = t('dueYesterday');
  else {
    const date = task.allDay ? new Date(`${task.dueAt.slice(0, 10)}T12:00:00Z`) : new Date(task.dueAt);
    label = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(task.allDay ? { timeZone: 'UTC' } : {}) }).format(date);
  }
  return { label, tone: diff < 0 ? 'over' : diff === 0 ? 'today' : '', diff };
}

export interface QuickAdd {
  title: string;
  priority: Priority | null;
  tags: string[];
  /** All-day due date (`YYYY-MM-DDT00:00:00Z`). */
  dueAt: string | null;
  estimateMinutes: number | null;
}

/** `!urgent|high|normal|low`, `#tag`, `@today|@tomorrow`, `~2h|~30m` (the prototype's quick-add syntax). */
export function parseQuickAdd(text: string, today: string): QuickAdd {
  let priority: Priority | null = null;
  const tags: string[] = [];
  let dueAt: string | null = null;
  let estimateMinutes: number | null = null;
  const title = text
    .replace(/(^|\s)!(urgent|high|normal|low)\b/gi, (_, space: string, value: string) => {
      priority = value.toLowerCase() as Priority;
      return space;
    })
    .replace(/(^|\s)#([\p{L}\p{N}_-]{1,40})/gu, (_, space: string, tag: string) => {
      if (!tags.includes(tag.toLowerCase()) && tags.length < 20) tags.push(tag.toLowerCase());
      return space;
    })
    .replace(/(^|\s)@(today|tomorrow)\b/gi, (_, space: string, day: string) => {
      const base = Date.parse(`${today}T00:00:00Z`) + (day.toLowerCase() === 'tomorrow' ? 86_400_000 : 0);
      dueAt = new Date(base).toISOString().replace('.000Z', 'Z');
      return space;
    })
    .replace(/(^|\s)~(\d{1,4})(h|m)\b/gi, (_, space: string, amount: string, unit: string) => {
      const minutes = unit.toLowerCase() === 'h' ? Number(amount) * 60 : Number(amount);
      estimateMinutes = Math.min(minutes, 100_000);
      return space;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { title, priority, tags, dueAt, estimateMinutes };
}

export interface MineGroups {
  overdue: TaskCard[];
  today: TaskCard[];
  upcoming: TaskCard[];
  noDate: TaskCard[];
}

/** My tasks (assignee) grouped by due date against the local `today`; the server's order is kept in each group. */
export function groupMine(tasks: TaskCard[], today: string): MineGroups {
  const groups: MineGroups = { overdue: [], today: [], upcoming: [], noDate: [] };
  for (const task of tasks) {
    const diff = task.dueAt === null ? null : dayDiff(task.dueAt, today, task.allDay);
    if (diff === null) groups.noDate.push(task);
    else if (diff < 0) groups.overdue.push(task);
    else if (diff === 0) groups.today.push(task);
    else groups.upcoming.push(task);
  }
  return groups;
}

/** The short id shown on cards: `#123` with task numbers, else the start of the id. */
export function taskRef(task: Pick<TaskCard, 'number' | 'id'>): string {
  return task.number !== null ? `#${task.number}` : task.id.slice(0, 6);
}

export function priorityLabel(priority: Priority, t: TasksText): string {
  return t(priority === 'urgent' ? 'priorityUrgent' : priority === 'high' ? 'priorityHigh' : priority === 'low' ? 'priorityLow' : 'priorityNormal');
}

/** Minutes as `1 h 30 min` / `45 min`. */
export function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The plain all-day value of a `<input type=date>` (`YYYY-MM-DD`) for the API, or `null` for none. */
export function dateInputToApi(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : null;
}

export function apiToDateInput(task: Pick<TaskCard, 'dueAt' | 'allDay'>): string {
  if (task.dueAt === null) return '';
  return task.allDay ? task.dueAt.slice(0, 10) : localDate(new Date(task.dueAt));
}
