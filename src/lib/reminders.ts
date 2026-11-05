import { type MessageLocale, pickLine, remember } from './friendly';
import * as de from './messages/de';
import * as en from './messages/en';
import * as es from './messages/es';
import * as fr from './messages/fr';
import * as it from './messages/it';
import * as nl from './messages/nl';
import * as pt from './messages/pt';
import type { PoseId, ReminderCatalog } from './messages/types';
import { REMINDER_ACTION, type ReminderAction, type ReminderLineKind, type ScheduleState } from './schedule';

/** Working-hours reminder texts per locale (`reminders` of each `messages/<locale>.ts`). */
export const REMINDERS: Record<MessageLocale, ReminderCatalog> = {
  en: en.reminders,
  es: es.reminders,
  de: de.reminders,
  fr: fr.reminders,
  it: it.reminders,
  nl: nl.reminders,
  pt: pt.reminders,
};

/** Ids of the notification buttons (the host only accepts these, src-tauri/src/notify.rs). */
export const ACTION_IDS: Record<ReminderAction, string> = { start: 'schedule-start', stop: 'schedule-stop', resume: 'schedule-resume' };

export function actionOfId(id: unknown): ReminderAction | null {
  const entry = Object.entries(ACTION_IDS).find(([, value]) => value === id);
  return entry !== undefined ? (entry[0] as ReminderAction) : null;
}

/** A reminder ready to show: as a desktop notification (title, body, pose, button) or as a toast. */
export interface ReminderNote {
  kind: ReminderLineKind;
  /** Reminder slot (`start:2026-11-05`, `dayOff:2026-12-25`). */
  slot: string;
  title: string;
  text: string;
  pose: PoseId;
  locale: MessageLocale;
  /** The button, when there is something to do (none without a task to resume). */
  action: ReminderAction | null;
  actionLabel: string | null;
  shownAt: string;
}

export interface ComposeInput {
  kind: ReminderLineKind;
  slot: string;
  locale: MessageLocale;
  state: ScheduleState;
  rng: () => number;
  now: Date;
  /** Last task's title (start, lunch end). */
  task: string | null;
  /** Tracked today, `H:MM` (end). */
  total: string | null;
}

const fill = (text: string, params: Record<string, string>) => text.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);

/** The note for a reminder (a line not among the last shown of its pool) and the updated history. */
export function composeReminder(input: ComposeInput): { note: ReminderNote; state: ScheduleState } {
  const catalog = REMINDERS[input.locale];
  const lines = catalog.lines[input.kind];
  const index = pickLine(lines, input.state.recent[input.kind] ?? [], input.rng) as number;
  const line = lines[index]!;
  const task = input.task ?? '';
  let text = fill(line.text, { task });
  if (input.kind === 'start' && input.task !== null) text = `${text} ${fill(catalog.lastTask, { task })}`;
  if (input.kind === 'end' && input.total !== null) text = `${text} ${fill(catalog.today, { total: input.total })}`;
  const wanted = REMINDER_ACTION[input.kind];
  const action = wanted === 'start' || wanted === 'resume' ? (input.task !== null ? wanted : null) : wanted;
  return {
    note: {
      kind: input.kind,
      slot: input.slot,
      title: catalog.titles[input.kind],
      text,
      pose: line.pose,
      locale: input.locale,
      action,
      actionLabel: action !== null ? catalog.actions[action] : null,
      shownAt: input.now.toISOString(),
    },
    state: { ...input.state, recent: { ...input.state.recent, [input.kind]: remember(input.state.recent[input.kind], index) } },
  };
}
