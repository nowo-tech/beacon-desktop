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

/** Quick-add priority words, English and Spanish in both locales (UXA-18). */
const PRIORITY_WORDS: Record<string, Priority> = { urgent: 'urgent', urgente: 'urgent', high: 'high', alta: 'high', normal: 'normal', low: 'low', baja: 'low' };
/** Quick-add day words: days from today. `manana` (no tilde) is accepted too. */
const DAY_WORDS: Record<string, number> = { today: 0, hoy: 0, tomorrow: 1, 'mañana': 1, manana: 1 };

/** The all-day API value (`YYYY-MM-DDT00:00:00Z`) of `today` plus `days`. */
export function dayAfter(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().replace('.000Z', 'Z');
}

/** Days from `today` (`YYYY-MM-DD`) to next week's Monday (1..7). */
export function daysToNextWeek(today: string): number {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return ((8 - weekday) % 7) || 7;
}

/**
 * `!priority` (`urgent|high|normal|low`, `urgente|alta|normal|baja`), `#tag`, `@today|@tomorrow` (`@hoy|@mañana`),
 * `~2h|~30m|~1h30` (the prototype's quick-add syntax, with the Spanish words accepted in both locales).
 */
export function parseQuickAdd(text: string, today: string): QuickAdd {
  let priority: Priority | null = null;
  const tags: string[] = [];
  let dueAt: string | null = null;
  let estimateMinutes: number | null = null;
  const title = text
    .replace(/(^|\s)!([\p{L}]+)(?=\s|$)/gu, (match: string, space: string, word: string) => {
      const value = PRIORITY_WORDS[word.toLowerCase()];
      if (value === undefined) return match;
      priority = value;
      return space;
    })
    .replace(/(^|\s)#([\p{L}\p{N}_-]{1,40})/gu, (_, space: string, tag: string) => {
      if (!tags.includes(tag.toLowerCase()) && tags.length < 20) tags.push(tag.toLowerCase());
      return space;
    })
    .replace(/(^|\s)@([\p{L}]+)(?=\s|$)/gu, (match: string, space: string, word: string) => {
      const days = DAY_WORDS[word.toLowerCase()];
      if (days === undefined) return match;
      dueAt = dayAfter(today, days);
      return space;
    })
    .replace(/(^|\s)~(\S+)(?=\s|$)/gu, (match: string, space: string, amount: string) => {
      // A unit is required here (`~5` stays text): bare numbers are minutes only in the panel's estimate field.
      const minutes = /[hm:]/i.test(amount) ? parseDuration(amount) : null;
      if (minutes === null || minutes === 0) return match;
      estimateMinutes = minutes;
      return space;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { title, priority, tags, dueAt, estimateMinutes };
}

export const MAX_ESTIMATE_MINUTES = 100_000;

/**
 * A duration as typed (UXA-17): `4h`, `90m`, `90 min`, `1h30`, `1h 30m`, `1 h 30 min` (what `duration()` shows),
 * `1.5h` / `1,5 h`, `1:30`, or bare minutes (`240`). `null` when it is not a duration.
 */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase().replace(',', '.');
  if (value === '') return null;
  let minutes: number | null = null;
  let match: RegExpMatchArray | null;
  if ((match = /^(\d{1,4})$/.exec(value)) !== null) minutes = Number(match[1]);
  else if ((match = /^(\d{1,3}):([0-5]\d)$/.exec(value)) !== null) minutes = Number(match[1]) * 60 + Number(match[2]);
  else if ((match = /^(\d{1,4}(?:\.\d{1,2})?)\s*h(?:\s*(\d{1,2})\s*(?:m|min)?)?$/.exec(value)) !== null) {
    if (match[2] !== undefined && match[1].includes('.')) return null;
    minutes = Math.round(Number(match[1]) * 60) + Number(match[2] ?? 0);
  } else if ((match = /^(\d{1,5})\s*(?:m|min)$/.exec(value)) !== null) minutes = Number(match[1]);
  return minutes === null || minutes > MAX_ESTIMATE_MINUTES ? null : minutes;
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
