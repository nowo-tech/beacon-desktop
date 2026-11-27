/**
 * TaskBoard client API v1 (TaskBoardBundle 3.4.1, `docs/CLIENT-API.md`, `docs/openapi/task-board-client-v1.yaml`): the
 * shapes the Tasks module reads, and parsers that check every field. Anything malformed is dropped or replaced by a
 * safe default; text stays data (tokens/1, rendered as text nodes by the chat body renderer).
 */
import { type Block, parseToken, safeUrl, type Token } from '../chat/types';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type ColumnType = 'open' | 'custom' | 'done' | 'closed';
export type Bucket = 'overdue' | 'today' | 'upcoming' | 'no_date' | 'review' | 'all';

export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

export interface Person {
  id: string;
  name: string;
  initials: string;
}

export interface Context {
  key: string;
  label: string;
}

export interface TasksMe {
  user: Person | null;
  scopes: string[];
  context: Context | null;
  contexts: Context[];
  features: { timeTracking: boolean; taskNumbers: boolean; realtime: boolean };
  limits: { pageSize: number; columnPageSize: number; changes: number };
}

export interface Column {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  type: ColumnType;
}

export interface Board {
  id: string;
  title: string;
  icon: string | null;
  group: { type: 'space' | 'folder'; id: string; label: string } | null;
  columns: Column[];
  canCreate: boolean;
  canMove: boolean;
  /** `GET boards/{id}` only. */
  counts: { open: number; capped: boolean } | null;
  people: Person[];
  tags: string[];
}

export interface TaskCard {
  id: string;
  number: number | null;
  title: string;
  boardId: string;
  column: { id: string; name: string; icon: string | null; type: ColumnType } | null;
  priority: Priority;
  tags: string[];
  startAt: string | null;
  dueAt: string | null;
  allDay: boolean;
  assignees: Person[];
  subtasks: { total: number; done: number };
  checklist: { total: number; done: number };
  openQuestions: number;
  waitingForMe: boolean;
  comments: number;
  estimateMinutes: number | null;
  timeSpentMinutes: number;
  archived: boolean;
  completed: boolean;
  revision: number;
  updatedAt: string;
}

export interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
  revision: number;
}

export interface TaskDetail extends TaskCard {
  description: Block[] | null;
  descriptionTruncated: boolean;
  parent: { visible: true; id: string; number: number | null; title: string } | { visible: false } | null;
  members: { user: Person; role: 'assignee' | 'reviewer' | 'stakeholder' | 'watcher' }[];
  checklists: { name: string; items: ChecklistItem[] }[];
  links: ({ visible: true; title: string; url: string | null } | { visible: false })[];
  createdBy: Person | null;
  createdAt: string;
  permissions: { canEdit: boolean; canMove: boolean; canAssign: boolean; canTrackTime: boolean };
  webUrl: string | null;
}

export interface TaskPage {
  tasks: TaskCard[];
  nextCursor: string | null;
}

export interface MyTasksPage extends TaskPage {
  counts: { overdue: number; today: number; upcoming: number; review: number } | null;
}

export interface Changes {
  changes: { taskId: string; boardId: string; revision: number }[];
  nextCursor: string | null;
  reset: boolean;
}

export interface Comment {
  id: string;
  author: Person | null;
  body: Block[] | null;
  createdAt: string;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const strOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const int = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback);
const intOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const bool = (value: unknown): boolean => value === true;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** TaskBoard ids (UUIDs; boards and columns too) and the host's public people ids: a safe path segment only. */
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

const COLUMN_TYPES: readonly ColumnType[] = ['open', 'custom', 'done', 'closed'];

export function parsePerson(raw: unknown): Person | null {
  if (!isObject(raw) || !isId(raw.id)) return null;
  const name = str(raw.name).trim() || '?';
  const given = str(raw.initials).trim();
  const initials = (given !== '' ? given : name.split(/\s+/).map((part) => [...part][0] ?? '').join('')).slice(0, 2).toUpperCase();
  return { id: raw.id, name, initials };
}

const people = (raw: unknown): Person[] => list(raw).map(parsePerson).filter((item): item is Person => item !== null);
const tags = (raw: unknown): string[] => list(raw).filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 50);

function context(raw: unknown): Context | null {
  if (!isObject(raw) || typeof raw.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.key)) return null;
  return { key: raw.key, label: str(raw.label).trim() || raw.key };
}

export function parseMe(raw: unknown): TasksMe {
  const value = isObject(raw) ? raw : {};
  const features = isObject(value.features) ? value.features : {};
  const limits = isObject(value.limits) ? value.limits : {};
  return {
    user: parsePerson(value.user),
    scopes: list(value.scopes).filter((item): item is string => typeof item === 'string'),
    context: context(value.context),
    contexts: list(value.contexts).map(context).filter((item): item is Context => item !== null),
    features: { timeTracking: bool(features.timeTracking), taskNumbers: bool(features.taskNumbers), realtime: bool(features.realtime) },
    limits: {
      pageSize: Math.min(Math.max(int(limits.pageSize, 100), 1), 100),
      columnPageSize: Math.min(Math.max(int(limits.columnPageSize, 30), 1), 100),
      changes: Math.min(Math.max(int(limits.changes, 200), 1), 200),
    },
  };
}

export function parseColumn(raw: unknown): Column | null {
  if (!isObject(raw) || !isId(raw.id)) return null;
  return {
    id: raw.id,
    name: str(raw.name).trim() || '…',
    color: typeof raw.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(raw.color) ? raw.color : null,
    icon: strOrNull(raw.icon) !== null && [...str(raw.icon)].length <= 4 ? str(raw.icon) : null,
    type: COLUMN_TYPES.includes(raw.type as ColumnType) ? (raw.type as ColumnType) : 'open',
  };
}

export function parseBoard(raw: unknown): Board | null {
  if (!isObject(raw) || !isId(raw.id)) return null;
  const groupType: 'space' | 'folder' | null = isObject(raw.group) && (raw.group.type === 'space' || raw.group.type === 'folder') ? raw.group.type : null;
  const group = groupType !== null && isObject(raw.group) ? { type: groupType, id: str(raw.group.id), label: str(raw.group.label) } : null;
  const permissions = isObject(raw.permissions) ? raw.permissions : {};
  const counts = isObject(raw.counts) ? { open: int(raw.counts.open), capped: bool(raw.counts.capped) } : null;
  return {
    id: raw.id,
    title: str(raw.title).trim() || '…',
    icon: strOrNull(raw.icon) !== null && [...str(raw.icon)].length <= 4 ? str(raw.icon) : null,
    group,
    columns: list(raw.columns).map(parseColumn).filter((item): item is Column => item !== null),
    canCreate: bool(permissions.canCreate),
    canMove: bool(permissions.canMove),
    counts,
    people: people(raw.people),
    tags: tags(raw.tags),
  };
}

const PRIOS: readonly Priority[] = ['low', 'normal', 'high', 'urgent'];

export function parseCard(raw: unknown): TaskCard | null {
  if (!isObject(raw) || !isId(raw.id) || !isId(raw.boardId)) return null;
  const column = isObject(raw.column) && isId(raw.column.id) ? { id: raw.column.id, name: str(raw.column.name), icon: strOrNull(raw.column.icon), type: COLUMN_TYPES.includes(raw.column.type as ColumnType) ? (raw.column.type as ColumnType) : 'open' } : null;
  const summary = (value: unknown) => (isObject(value) ? { total: int(value.total), done: int(value.done) } : { total: 0, done: 0 });
  return {
    id: raw.id,
    number: intOrNull(raw.number),
    title: str(raw.title).trim() || '…',
    boardId: raw.boardId,
    column,
    priority: PRIOS.includes(raw.priority as Priority) ? (raw.priority as Priority) : 'normal',
    tags: tags(raw.tags),
    startAt: strOrNull(raw.startAt),
    dueAt: strOrNull(raw.dueAt),
    allDay: bool(raw.allDay),
    assignees: people(raw.assignees),
    subtasks: summary(raw.subtaskSummary),
    checklist: summary(raw.checklistSummary),
    openQuestions: int(raw.openQuestions),
    waitingForMe: bool(raw.waitingForMe),
    comments: int(raw.comments),
    estimateMinutes: intOrNull(raw.estimateMinutes),
    timeSpentMinutes: int(raw.timeSpentMinutes),
    archived: bool(raw.archived),
    completed: bool(raw.completed),
    revision: int(raw.revision),
    updatedAt: str(raw.updatedAt),
  };
}

/**
 * tokens/1 of TaskBoard (paragraph, heading, quote, list with `checked`, code, rule; text, break, code, link, reference,
 * image) mapped onto the chat renderer's blocks: a heading is a bold paragraph, a task-list item starts with ☑ / ☐, a
 * rule is dropped, an image is a neutral "image" placeholder (no file id or alt is used: files are 3.5).
 */
export function parseText(raw: unknown, origin: string, imageLabel: string): { blocks: Block[] | null; truncated: boolean } {
  if (!isObject(raw) || raw.format !== 'tokens/1') return { blocks: null, truncated: false };
  const tokens = (value: unknown, bold = false): Token[] =>
    list(value)
      .map((item): Token | null => {
        if (isObject(item) && item.type === 'image') return { type: 'reference', visible: false, text: imageLabel };
        if (isObject(item) && item.type === 'reference' && item.visible === true) {
          return { type: 'reference', visible: true, refType: str(item.refType), id: str(item.id), typeLabel: str(item.refType), title: str(item.title), subtitle: '', badge: '', tone: 'neutral', url: safeUrl(item.url, origin) };
        }
        const token = parseToken(item, origin);
        if (bold && token?.type === 'text' && !token.marks.includes('bold')) return { ...token, marks: [...token.marks, 'bold'] };
        return token;
      })
      .filter((item): item is Token => item !== null);
  const blocks: Block[] = [];
  for (const block of list(raw.blocks)) {
    if (!isObject(block)) continue;
    if (block.type === 'paragraph' || block.type === 'quote') blocks.push({ type: block.type, tokens: tokens(block.tokens) });
    else if (block.type === 'heading') blocks.push({ type: 'paragraph', tokens: tokens(block.tokens, true) });
    else if (block.type === 'code') blocks.push({ type: 'code', text: str(block.text) });
    else if (block.type === 'list') {
      const checked = list(block.checked);
      blocks.push({
        type: 'list',
        ordered: bool(block.ordered),
        items: list(block.items).map((item, index) => {
          const mark = checked[index] === true ? '☑ ' : checked[index] === false ? '☐ ' : '';
          const inner = tokens(item);
          return mark === '' ? inner : [{ type: 'text' as const, text: mark, marks: [] }, ...inner];
        }),
      });
    }
  }
  return { blocks, truncated: bool(raw.truncated) };
}

export function parseDetail(raw: unknown, origin: string, imageLabel: string): TaskDetail | null {
  const value = isObject(raw) && isObject(raw.task) ? raw.task : raw;
  const card = parseCard(value);
  if (card === null || !isObject(value)) return null;
  const text = parseText(value.description, origin, imageLabel);
  const parent = isObject(value.parent) ? (value.parent.visible === true && isId(value.parent.id) ? { visible: true as const, id: value.parent.id, number: intOrNull(value.parent.number), title: str(value.parent.title) } : { visible: false as const }) : null;
  const permissions = isObject(value.permissions) ? value.permissions : {};
  const roles = ['assignee', 'reviewer', 'stakeholder', 'watcher'] as const;
  return {
    ...card,
    description: text.blocks,
    descriptionTruncated: text.truncated,
    parent,
    members: list(value.members)
      .filter(isObject)
      .map((item) => ({ user: parsePerson(item.user), role: roles.includes(item.role as (typeof roles)[number]) ? (item.role as (typeof roles)[number]) : 'watcher' }))
      .filter((item): item is TaskDetail['members'][number] => item.user !== null),
    checklists: list(value.checklists)
      .filter(isObject)
      .map((item) => ({
        name: str(item.name).trim() || '…',
        items: list(item.items)
          .filter(isObject)
          .filter((entry) => isId(entry.id))
          .map((entry) => ({ id: entry.id as string, title: str(entry.title), done: bool(entry.done), revision: int(entry.revision) })),
      })),
    links: list(value.links)
      .filter(isObject)
      .map((item) => (item.visible === true ? { visible: true as const, title: str(item.title) || str(item.url), url: safeUrl(item.url, origin) } : { visible: false as const })),
    createdBy: parsePerson(value.createdBy),
    createdAt: str(value.createdAt),
    permissions: { canEdit: bool(permissions.canEdit), canMove: bool(permissions.canMove), canAssign: bool(permissions.canAssign), canTrackTime: bool(permissions.canTrackTime) },
    webUrl: webUrl(value.webUrl, origin),
  };
}

/** "Open in Beacon": a page of the server itself (same origin), never another site. */
function webUrl(raw: unknown, origin: string): string | null {
  const url = safeUrl(raw, origin);
  return url !== null && url.startsWith(`${origin}/`) ? url : null;
}

export function parseTaskPage(raw: unknown): MyTasksPage {
  const value = isObject(raw) ? raw : {};
  const counts = isObject(value.counts) ? { overdue: int(value.counts.overdue), today: int(value.counts.today), upcoming: int(value.counts.upcoming), review: int(value.counts.review) } : null;
  return { tasks: list(value.tasks).map(parseCard).filter((item): item is TaskCard => item !== null), nextCursor: strOrNull(value.nextCursor), counts };
}

export function parseChanges(raw: unknown): Changes {
  const value = isObject(raw) ? raw : {};
  return {
    changes: list(value.changes)
      .filter(isObject)
      .filter((item) => isId(item.taskId) && isId(item.boardId))
      .map((item) => ({ taskId: item.taskId as string, boardId: item.boardId as string, revision: int(item.revision) })),
    nextCursor: strOrNull(value.nextCursor),
    reset: bool(value.reset),
  };
}

export function parseComments(raw: unknown, origin: string, imageLabel: string): Comment[] {
  const value = isObject(raw) ? raw : {};
  return list(value.comments)
    .filter(isObject)
    .filter((item) => typeof item.id === 'string')
    .map((item) => ({ id: item.id as string, author: parsePerson(item.author), body: parseText(item.body, origin, imageLabel).blocks, createdAt: str(item.createdAt) }));
}
