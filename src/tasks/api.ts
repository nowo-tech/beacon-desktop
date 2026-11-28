/**
 * TaskBoard client API v1 (`/api/task-board/v1`, TaskBoardBundle 3.4.1): Bearer only, no cookies, no redirects; the
 * tenant goes in `X-Beacon-Context` on every request. In the Tauri app the token is `SESSION_HANDLE`: Rust adds the
 * real tasks token to `/api/task-board/v1/` routes only (src-tauri/src/secret.rs).
 *
 * Writes follow the contract (`docs/CLIENT-API.md` → Writes): every change of an existing task sends
 * `If-Match: "<revision>"` (`409 conflict {currentRevision}` when someone else changed it, nothing written; `428` when
 * missing); creates and checklist items send an `Idempotency-Key` (a retry answers the first write). A reorder inside
 * one column may send `If-Match: *`.
 */
import { ApiError, normalizeServerUrl, parseRetryAfter } from '../api/client';
import { newIdempotencyKey } from '../chat/api';
import { CONTEXT_KEY } from '../chat/types';
import {
  type Board,
  type Bucket,
  type Changes,
  type Comment,
  isId,
  type MyTasksPage,
  parseBoard,
  parseChanges,
  parseComments,
  parseDetail,
  parseMe,
  parseTaskPage,
  type Person,
  parsePerson,
  type Priority,
  type TaskDetail,
  type TaskPage,
  type TasksMe,
} from './types';

export const TASKS_PREFIX = '/api/task-board/v1';

/** What a server logout came to ({@link TasksApi.logout}). */
export type LogoutResult = 'revoked' | 'gone' | 'retry' | 'refused';
export const CONTEXT_HEADER = 'X-Beacon-Context';

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A refusal with the contract's extra fields (`currentRevision`, `policyCode`, `message`, `field`, `reason`). */
export class TasksApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    public readonly details: { currentRevision?: number; policyCode?: string; policyMessage?: string; field?: string; reason?: string },
    retryAfter: number | null = null,
  ) {
    super(status, code, code, retryAfter);
    this.name = 'TasksApiError';
  }
}

/**
 * `403 module_forbidden` (TaskBoard 3.5, an explicit signal): the person may not use the Tasks module now. The module is
 * hidden, the token is kept (owner decision 2026-11-27).
 */
export const isModuleForbidden = (error: unknown): boolean => error instanceof ApiError && error.status === 403 && error.code === 'module_forbidden';

export interface TaskFields {
  title?: string;
  description?: string | null;
  priority?: Priority;
  tags?: string[];
  dueAt?: string | null;
  startAt?: string | null;
  allDay?: boolean;
  estimateMinutes?: number | null;
  archived?: boolean;
}

export interface NewTask {
  boardId: string;
  title: string;
  columnId?: string;
  priority?: Priority;
  dueAt?: string | null;
  allDay?: boolean;
  estimateMinutes?: number | null;
  tags?: string[];
  assignees?: string[];
}

export interface BoardTasksQuery {
  column?: string;
  sort?: 'position' | 'due' | 'priority' | 'updated' | 'number';
  cursor?: string | null;
  limit?: number;
  assignee?: 'me';
  q?: string;
}

export interface TasksApiConfig {
  baseUrl: string;
  token: string | null;
  context: string | null;
  fetchImpl?: typeof fetch;
  imageLabel?: string;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Query = Record<string, string | number | undefined>;

export class TasksApi {
  readonly server: string;
  readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | null;
  private context: string | null;
  private readonly imageLabel: string;

  constructor(config: TasksApiConfig) {
    this.server = normalizeServerUrl(config.baseUrl);
    this.origin = new URL(this.server).origin;
    this.token = config.token;
    this.context = config.context !== null && CONTEXT_KEY.test(config.context) ? config.context : null;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.imageLabel = config.imageLabel ?? 'Image';
  }

  setContext(context: string | null): void {
    this.context = context !== null && CONTEXT_KEY.test(context) ? context : null;
  }

  get currentContext(): string | null {
    return this.context;
  }

  /**
   * Revokes the presented tasks token on the server (TaskBoard 3.7.0 `POST logout`, as ChatKit 2.4.1's; idempotent: an
   * already revoked, expired or unknown token gets `204` too; audit BDA13-L2). Best effort with a short timeout, never
   * throws: `revoked` (2xx), `gone` (`404`, a server before 3.7.0: nothing to revoke there), `retry` (a network error,
   * no answer in time, `5xx` or `409 unavailable`: the token is still valid, worth one more try later) or `refused`
   * (anything else, e.g. `401` without a Bearer).
   */
  async logout(timeoutMs = 3000): Promise<LogoutResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<LogoutResult>((resolve) => {
      timer = setTimeout(() => resolve('retry'), timeoutMs);
    });
    const request = this.request('POST', 'logout').then(
      (): LogoutResult => 'revoked',
      (error: unknown): LogoutResult => {
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 404) return 'gone';
        if (status === 0 || status === 409 || status >= 500) return 'retry';
        return 'refused';
      },
    );
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async me(): Promise<TasksMe> {
    return parseMe((await this.request('GET', 'me')).data);
  }

  /** `today`: the client's local date (`YYYY-MM-DD`), the server checks it is within a day of its own. */
  async myTasks(bucket: Bucket, today: string, cursor: string | null = null, limit = 100): Promise<MyTasksPage> {
    return parseTaskPage((await this.request('GET', 'my-tasks', { bucket, today, cursor: cursor ?? undefined, limit })).data);
  }

  async boards(cursor: string | null = null, q?: string): Promise<{ boards: Board[]; nextCursor: string | null }> {
    const data = (await this.request('GET', 'boards', { cursor: cursor ?? undefined, limit: 100, q })).data as { boards?: unknown; nextCursor?: unknown } | null;
    return {
      boards: (Array.isArray(data?.boards) ? data.boards : []).map(parseBoard).filter((item): item is Board => item !== null),
      nextCursor: typeof data?.nextCursor === 'string' && data.nextCursor !== '' ? data.nextCursor : null,
    };
  }

  async board(id: string): Promise<Board | null> {
    const data = (await this.request('GET', `boards/${idPath(id)}`)).data as { board?: unknown } | null;
    return parseBoard(data?.board);
  }

  async boardTasks(id: string, query: BoardTasksQuery = {}): Promise<TaskPage> {
    const { cursor, ...rest } = query;
    return parseTaskPage((await this.request('GET', `boards/${idPath(id)}/tasks`, { ...rest, cursor: cursor ?? undefined })).data);
  }

  async task(id: string): Promise<TaskDetail | null> {
    return parseDetail((await this.request('GET', `tasks/${idPath(id)}`)).data, this.origin, this.imageLabel);
  }

  async comments(id: string): Promise<Comment[]> {
    return parseComments((await this.request('GET', `tasks/${idPath(id)}/comments`, { limit: 20 })).data, this.origin, this.imageLabel);
  }

  async people(board: string, q = ''): Promise<Person[]> {
    const data = (await this.request('GET', 'people', { board, q })).data as { people?: unknown } | null;
    return (Array.isArray(data?.people) ? data.people : []).map(parsePerson).filter((item): item is Person => item !== null);
  }

  async changes(since: string | null, limit = 200): Promise<Changes> {
    return parseChanges((await this.request('GET', 'changes', { since: since ?? undefined, limit })).data);
  }

  /** Quick create (`Idempotency-Key` required: a retry with the same key creates one task). */
  async create(task: NewTask, key = newIdempotencyKey()): Promise<TaskDetail> {
    return this.detail(await this.request('POST', 'tasks', {}, task, { 'Idempotency-Key': key }));
  }

  /** Field changes with the task's revision (`If-Match`). */
  async patch(id: string, fields: TaskFields, revision: number): Promise<TaskDetail> {
    return this.detail(await this.request('PATCH', `tasks/${idPath(id)}`, {}, fields, { 'If-Match': `"${revision}"` }));
  }

  /** A move to another column needs the revision; a reorder inside the same column may pass `'*'`. */
  async move(id: string, target: { columnId: string; beforeTaskId?: string; afterTaskId?: string }, revision: number | '*'): Promise<TaskDetail> {
    if (!isId(target.columnId)) throw new ApiError(0, 'invalid_id', 'Invalid id.');
    return this.detail(await this.request('POST', `tasks/${idPath(id)}/move`, {}, target, { 'If-Match': revision === '*' ? '*' : `"${revision}"` }));
  }

  /** Adds or removes a person's role (`userId` may be `me`); `remove` drops every role of that person. */
  async member(id: string, userId: string, role: 'assignee' | 'reviewer', revision: number, remove = false): Promise<TaskDetail> {
    const path = `tasks/${idPath(id)}/members/${userId === 'me' ? 'me' : idPath(userId)}`;
    return this.detail(await this.request(remove ? 'DELETE' : 'PUT', path, {}, remove ? undefined : { role }, { 'If-Match': `"${revision}"` }));
  }

  async addChecklistItem(id: string, checklist: string, title: string, key = newIdempotencyKey()): Promise<TaskDetail> {
    return this.detail(await this.request('POST', `tasks/${idPath(id)}/checklist-items`, {}, { checklist, title }, { 'Idempotency-Key': key }));
  }

  /** Ticks or renames one item with the **item's** revision. */
  async patchChecklistItem(id: string, itemId: string, fields: { done?: boolean; title?: string }, itemRevision: number): Promise<TaskDetail> {
    return this.detail(await this.request('PATCH', `tasks/${idPath(id)}/checklist-items/${idPath(itemId)}`, {}, fields, { 'If-Match': `"${itemRevision}"` }));
  }

  private detail(answer: { data: unknown }): TaskDetail {
    const task = parseDetail(answer.data, this.origin, this.imageLabel);
    if (task === null) throw new ApiError(200, 'invalid_response', 'The server returned an invalid response.');
    return task;
  }

  private async request(method: Method, path: string, query: Query = {}, body?: unknown, extra: Record<string, string> = {}): Promise<{ data: unknown; etag: string | null }> {
    if (this.token === null) throw new ApiError(401, 'invalid_token', 'Tasks are not connected.');
    const url = new URL(`${this.server}${TASKS_PREFIX}/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.token}`, ...extra };
    if (this.context !== null) headers[CONTEXT_HEADER] = this.context;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error' });
    } catch (error) {
      throw new ApiError(0, 'network_error', error instanceof Error ? error.message : 'Network error.');
    }
    const text = response.status === 204 ? '' : await response.text();
    let data: unknown = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) throw new ApiError(response.status, 'invalid_response', 'The server returned an invalid response.');
      }
    }
    if (!response.ok) {
      const value = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
      const raw = typeof value.error === 'string' ? value.error : '';
      const code = CODE_PATTERN.test(raw) ? raw : response.status === 401 ? 'invalid_token' : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'not_found' : 'server_error';
      throw new TasksApiError(
        response.status,
        code,
        {
          currentRevision: typeof value.currentRevision === 'number' ? value.currentRevision : undefined,
          policyCode: typeof value.policyCode === 'string' ? value.policyCode : undefined,
          policyMessage: typeof value.message === 'string' && code === 'transition_refused' ? value.message.slice(0, 300) : undefined,
          field: typeof value.field === 'string' ? value.field : undefined,
          reason: typeof value.reason === 'string' ? value.reason : undefined,
        },
        parseRetryAfter(response.headers.get('Retry-After')),
      );
    }
    return { data, etag: response.headers.get('ETag') };
  }
}

/** Only ids go into paths (no path traversal from a server value). */
function idPath(value: string): string {
  if (!isId(value)) throw new ApiError(0, 'invalid_id', 'Invalid id.');
  return value;
}
