/**
 * The global quick switcher (Ctrl/⌘+K, UX batch 3, UXA-3; owner approval "global shortcuts in every module"): one list
 * over the three modules (conversations; boards and tasks; Time's timer actions and views). Pure ranking here; the shell
 * gathers the candidates and runs the chosen one.
 */
import { fuzzyScore } from '../chat/format';
import type { ChatIconName } from '../chat/icons';

export type SwitchModule = 'chat' | 'tasks' | 'time';

export interface SwitchItem {
  /** Unique in one list (DOM id and test hook). */
  key: string;
  module: SwitchModule;
  label: string;
  /** What it is or what it does ("Board", "Start timer", "3 unread"), after the label. */
  meta: string;
  icon: ChatIconName;
  /** Matched against the query as well as the label (a task's board, a conversation's kind). */
  extra?: string;
  unread?: number;
  /** Shown in bold (unread, not muted). */
  strong?: boolean;
  run: () => void;
}

/** A module's candidates, most relevant first, and the score of each for the query (`null`: no match). */
export interface SwitchGroup {
  module: SwitchModule;
  items: { item: SwitchItem; score: number }[];
}

/** Score of an item for `query`: the label first, else the extra words (a little lower). */
export function itemScore(query: string, item: Pick<SwitchItem, 'label' | 'extra'>): number | null {
  const label = fuzzyScore(query, item.label);
  if (label !== null) return label;
  const extra = item.extra !== undefined ? fuzzyScore(query, item.extra) : null;
  return extra === null ? null : extra - 2;
}

/** Scores `items` (kept in their order) and drops those that do not match. */
export function scoreItems(query: string, items: SwitchItem[]): { item: SwitchItem; score: number }[] {
  return items.map((item) => ({ item, score: itemScore(query, item) })).filter((entry): entry is { item: SwitchItem; score: number } => entry.score !== null);
}

/** With no query: the shown module's own items first (its order), then a few of each other module. */
const OWN_EMPTY = 8;
const OTHER_EMPTY = 3;

/**
 * One list for the switcher. No query: the module in view leads with its own recents / actions, the others follow with a
 * few each. A query: every match by score (the module in view wins ties), so "inv" finds the conversation, the task
 * and the timer on it wherever it is typed.
 */
export function mergeSwitch(groups: SwitchGroup[], current: SwitchModule, query: string, limit = 14): SwitchItem[] {
  const ordered = [...groups].sort((a, b) => Number(b.module === current) - Number(a.module === current));
  if (query.trim() === '') {
    return ordered.flatMap((group) => group.items.slice(0, group.module === current ? OWN_EMPTY : OTHER_EMPTY).map((entry) => entry.item)).slice(0, limit);
  }
  return ordered
    .flatMap((group, rank) => group.items.map((entry, index) => ({ ...entry, rank, index })))
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}
