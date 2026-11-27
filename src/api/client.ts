/**
 * TimeTrackBundle client API (contract v0.3, compatible with v0.2 servers). Single module that talks to the server:
 * when the contract changes, only this file and `types.ts` should need edits.
 *
 * Privacy rules enforced here:
 * - requests never carry cookies (`credentials: 'omit'`), only the Bearer token;
 * - `timer/start` sends the closed `source` enum, never free metadata (no URLs, no window titles);
 * - idle state is never sent; only the user's decision via `timer/discard-idle`;
 * - `startedAt` / `endedAt` are the times the user acted (offline replay, idle check), never activity data.
 */
import type {
  ActivityType,
  Allocation,
  ClampedTime,
  ClientSource,
  DeviceCode,
  DeviceTokenResult,
  EntriesPage,
  Entry,
  EntryQuery,
  IdleOptions,
  ExportFormat,
  ExportResult,
  IdleAction,
  LoginResult,
  Me,
  MeetingsQuery,
  Scope,
  StartResult,
  StopResult,
  Subject,
  Task,
  TaskQuery,
  Timer,
  TimerChange,
} from './types';
import { ALL_SCOPES } from './types';

export const API_PREFIX = '/api/time-track';
/** Tenant header of Beacon's client APIs (TimeTrackBundle 2.2 `client_api.context`, ChatKit 2.4): `personal`, `org:<uuid>`. */
export const CONTEXT_HEADER = 'X-Beacon-Context';
/** A context key as Beacon's APIs accept it (the same pattern as ChatKit's `CONTEXT_KEY`). */
export const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIVITY_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SUBJECT_TYPE = /^[a-z][a-z0-9_]{0,31}$/;
/** Largest `subjects/search` page (`limit` 1–50) and query (≤ 100 characters). */
export const MAX_SUBJECT_LIMIT = 50;
export const MAX_SUBJECT_QUERY = 100;
export const MAX_TASK_LIMIT = 50;
export const MAX_ENTRY_LIMIT = 100;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

const STATUS_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'invalid_token',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server could not be reached (offline, DNS, CORS, TLS…). */
  get isNetwork(): boolean {
    return this.status === 0 && this.code === 'network_error';
  }

  /** 401: the token is missing, expired or revoked. Clients ask the user to sign in again; it is not an error. */
  get isUnauthorized(): boolean {
    return this.status === 401 && this.code !== 'invalid_credentials';
  }
}

/**
 * Validates and normalises the server URL typed by the user.
 * HTTPS is required except for loopback hosts (local development).
 */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ApiError(0, 'invalid_url', 'Invalid server URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new ApiError(0, 'insecure_url', 'The server URL must use HTTPS.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ApiError(0, 'invalid_url', 'The server URL must not contain credentials.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Match pattern for the runtime host permission of a server URL (origin only). */
export function originPattern(serverUrl: string): string {
  return `${new URL(serverUrl).origin}/*`;
}

/** Longest `Retry-After` honoured, in seconds (30 minutes): a larger value or a far date is capped (audit GO-I1). */
export const MAX_RETRY_AFTER_SECONDS = 1800;

/** `Retry-After` in seconds: an integer of seconds or an HTTP date (RFC 9110 §10.2.3), else `null`; at most 30 min. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, Math.ceil((at - now) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

/** RFC 3339 in UTC without fractions (`2026-11-05T08:00:00Z`), as `GET me/meetings` wants it. */
function utcSeconds(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function isoOrUndefined(value: Date | undefined): string | undefined {
  return value === undefined ? undefined : value.toISOString();
}

/** A well-formed `startedAtResult` / `endedAtResult`, else `null` (absent on 1.9 servers). */
export function clampedTime(value: unknown): ClampedTime | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<ClampedTime>;
  if (typeof raw.requested !== 'string' || typeof raw.applied !== 'string' || typeof raw.clamped !== 'boolean') return null;
  return { requested: raw.requested, applied: raw.applied, clamped: raw.clamped, reason: typeof raw.reason === 'string' ? raw.reason : null };
}

/** The allocation fields of a write body (contract v0.4); malformed values are left out (never sent). */
function allocationBody(allocation: Allocation | undefined): { subject?: { type: string; id: string } | null; activityTypeKey?: string } {
  if (allocation === undefined) return {};
  const body: { subject?: { type: string; id: string } | null; activityTypeKey?: string } = {};
  if (allocation.activityTypeKey !== undefined && ACTIVITY_KEY.test(allocation.activityTypeKey)) body.activityTypeKey = allocation.activityTypeKey;
  if (allocation.subject === null) body.subject = null;
  else if (allocation.subject !== undefined && SUBJECT_TYPE.test(allocation.subject.type) && allocation.subject.id !== '' && new TextEncoder().encode(allocation.subject.id).length <= 64) {
    body.subject = { type: allocation.subject.type, id: allocation.subject.id };
  }
  return body;
}

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition !== null ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  return match !== null ? match[1] : fallback;
}

export interface ApiClientConfig {
  baseUrl: string;
  source: ClientSource;
  token?: string | null;
  prefix?: string;
  fetchImpl?: typeof fetch;
  /**
   * Tenant sent as `X-Beacon-Context` on every request (BD-3a; TimeTrackBundle 2.2 ignores it without a host context
   * policy). `null`: no header.
   */
  context?: string | null;
  /**
   * The server answered `403 context_forbidden` for `context`. A read (GET) was then retried once with `personal`
   * (always the person's own); a write is never retried in another context (its time would land in another
   * organization). The caller stops using `context` in this run.
   */
  onContextRefused?: (context: string) => void;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  auth?: boolean;
}

export class TimeTrackApi {
  private token: string | null;
  private readonly baseUrl: string;
  private readonly prefix: string;
  private readonly source: ClientSource;
  private readonly fetchImpl: typeof fetch;
  private context: string | null;
  private readonly onContextRefused: ((context: string) => void) | undefined;

  constructor(config: ApiClientConfig) {
    this.baseUrl = normalizeServerUrl(config.baseUrl);
    this.prefix = config.prefix ?? API_PREFIX;
    this.source = config.source;
    this.token = config.token ?? null;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.context = config.context !== undefined && config.context !== null && CONTEXT_PATTERN.test(config.context) ? config.context : null;
    this.onContextRefused = config.onContextRefused;
  }

  /** The context this client sends (`null`: none). */
  get currentContext(): string | null {
    return this.context;
  }

  get server(): string {
    return this.baseUrl;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const data = await this.json<Partial<LoginResult>>('login', {
      method: 'POST',
      auth: false,
      body: { username: email, password, clientType: this.source },
    });
    return this.loginResult(data);
  }

  /** Revokes the token on the server (always 204). Local sign-out must not depend on it succeeding. */
  async logout(): Promise<void> {
    try {
      await this.raw('logout', { method: 'POST', body: {} });
    } finally {
      this.token = null;
    }
  }

  async me(): Promise<Me> {
    const data = await this.json<Me>('me');
    return {
      ...data,
      scopes: data.scopes ?? [],
      workingHours: data.workingHours ?? null,
      minSupportedVersion: typeof data.minSupportedVersion === 'string' ? data.minSupportedVersion : null,
      features: typeof data.features === 'object' && data.features !== null ? data.features : null,
      limits: typeof data.limits === 'object' && data.limits !== null ? data.limits : null,
      meetings: typeof data.meetings === 'object' && data.meetings !== null ? data.meetings : null,
      links: typeof data.links === 'object' && data.links !== null ? data.links : null,
    };
  }

  /**
   * The caller's own meetings overlapping `[from, to)` (TimeTrackBundle 1.14, scope `meetings:read`). The body is
   * returned as received: `lib/meetingReminders.ts` (`parseMeetingsPage`) checks every field. 404 = feature off.
   */
  async meetings(query: MeetingsQuery): Promise<unknown> {
    return this.json<unknown>('me/meetings', {
      query: { from: utcSeconds(query.from), to: utcSeconds(query.to), tz: blankToUndefined(query.tz ?? undefined), limit: query.limit },
    });
  }

  async tasks(query: TaskQuery = {}): Promise<Task[]> {
    const limit = Math.min(Math.max(query.limit ?? MAX_TASK_LIMIT, 1), MAX_TASK_LIMIT);
    const data = await this.json<{ tasks?: Task[] }>('tasks', {
      query: { search: blankToUndefined(query.search), limit, offset: query.offset },
    });
    return data.tasks ?? [];
  }

  async timer(): Promise<Timer | null> {
    const data = await this.json<{ timer?: Timer } | null>('timer');
    return data?.timer ?? null;
  }

  async start(taskId: string, note?: string): Promise<Timer> {
    return (await this.startAt(taskId, { note })).timer;
  }

  /**
   * `timer/start`, optionally backdated (`startedAt`, 1.10+). The server clamps an out-of-range time and reports it in
   * `startedAtResult`; a 1.9 server ignores `startedAt` and sends no result, so `startedAtResult` is then `null`.
   */
  async startAt(taskId: string, options: { note?: string; startedAt?: Date; allocation?: Allocation } = {}): Promise<StartResult> {
    const data = await this.json<{ timer: Timer; startedAtResult?: unknown }>('timer/start', {
      method: 'POST',
      body: { taskId, note: blankToUndefined(options.note), source: this.source, startedAt: isoOrUndefined(options.startedAt), ...allocationBody(options.allocation) },
    });
    return { timer: data.timer, startedAtResult: clampedTime(data.startedAtResult) };
  }

  /** Stops the running timer. Resolves to `null` when no timer was running (`404 no_active_timer`). */
  async stop(note?: string): Promise<Entry | null> {
    return (await this.stopAt({ note })).entry;
  }

  /**
   * `timer/stop`, optionally at an earlier time (`endedAt`, 1.10+), with the same clamp-and-report rule as `startAt`.
   * `entry` is `null` when no timer was running (`404 no_active_timer`).
   */
  async stopAt(options: { note?: string; endedAt?: Date; allocation?: Allocation } = {}): Promise<StopResult> {
    try {
      const data = await this.json<{ entry: Entry; endedAtResult?: unknown }>('timer/stop', {
        method: 'POST',
        body: { note: blankToUndefined(options.note), endedAt: isoOrUndefined(options.endedAt), ...allocationBody(options.allocation) },
      });
      return { entry: data.entry, endedAtResult: clampedTime(data.endedAtResult) };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no_active_timer') {
        return { entry: null, endedAtResult: null };
      }
      throw error;
    }
  }

  /**
   * Stops the running timer (if any) and starts `taskId` atomically. `note` goes to the stopped entry; `meeting` marks
   * the new timer as "Track the meeting" (send it only to a 1.14 server: `features.meetings`).
   */
  async switchTask(taskId: string, note?: string, options: { meeting?: boolean; allocation?: Allocation } = {}): Promise<TimerChange> {
    const data = await this.json<Partial<TimerChange>>('timer/switch', {
      method: 'POST',
      // "Track the meeting" (TimeTrackBundle 1.14, Q-B22): the only metadata the server accepts on a switch. The
      // allocation (2.1) is the next timer's.
      body: { taskId, note: blankToUndefined(note), source: this.source, metadata: options.meeting === true ? { origin: 'meeting' } : undefined, ...allocationBody(options.allocation) },
    });
    return { entry: data.entry ?? null, timer: data.timer ?? null };
  }

  /**
   * `timer/allocate` (TimeTrackBundle 2.1): sets the subject and / or activity type of the running timer (before a
   * stop or a switch, so the closed entry carries them). `null` when no timer runs (`404 no_active_timer`).
   */
  async allocate(allocation: Allocation): Promise<Timer | null> {
    try {
      const data = await this.json<{ timer?: Timer }>('timer/allocate', { method: 'POST', body: allocationBody(allocation) });
      return data?.timer ?? null;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no_active_timer') return null;
      throw error;
    }
  }

  /** Active activity types of the current scope (TimeTrackBundle 2.1, `tasks:read`, rate-limited per token). */
  async activityTypes(): Promise<ActivityType[]> {
    const data = await this.json<{ activityTypes?: unknown }>('activity-types');
    const list = Array.isArray(data?.activityTypes) ? data.activityTypes : [];
    return list.flatMap((raw): ActivityType[] => {
      const item = raw as Partial<ActivityType> | null;
      if (typeof item?.key !== 'string' || !ACTIVITY_KEY.test(item.key) || typeof item.label !== 'string') return [];
      return [{ key: item.key, label: item.label.slice(0, 200), group: typeof item.group === 'string' ? item.group.slice(0, 200) : null }];
    });
  }

  /** `subjects/search` (TimeTrackBundle 2.1): a hint list, every write is checked again. `429` carries `retryAfter`. */
  async searchSubjects(type: string, query: string, limit = 20): Promise<Subject[]> {
    if (!SUBJECT_TYPE.test(type)) throw new ApiError(0, 'invalid_request', 'Invalid subject type.');
    const data = await this.json<{ subjects?: unknown }>('subjects/search', {
      query: { type, q: query.trim().slice(0, MAX_SUBJECT_QUERY), limit: Math.min(Math.max(Math.trunc(limit), 1), MAX_SUBJECT_LIMIT) },
    });
    const list = Array.isArray(data?.subjects) ? data.subjects : [];
    return list.flatMap((raw): Subject[] => {
      const item = raw as Partial<Subject> | null;
      if (item?.type !== type || typeof item.id !== 'string' || item.id === '' || item.id.length > 64 || typeof item.label !== 'string') return [];
      return [{ type, id: item.id, label: item.label.slice(0, 200), hint: typeof item.hint === 'string' ? item.hint.slice(0, 200) : null }];
    });
  }

  /**
   * Sends the user's decision about an idle period detected locally. Idle state itself is never sent: the body is the
   * span, the action and, for `reassign` (1.10+), the other task, what runs next and an optional note; for `keep`, an
   * optional note (only send it when the server has `features.idle_keep_note`).
   */
  async discardIdle(from: Date, to: Date, action: IdleAction, options: IdleOptions = {}): Promise<TimerChange> {
    const extra =
      action === 'reassign' && options.taskId !== undefined
        ? { taskId: options.taskId, then: options.then ?? 'continue', note: blankToUndefined(options.note), source: this.source }
        : action === 'keep'
          ? { note: blankToUndefined(options.note) }
          : {};
    const data = await this.json<Partial<TimerChange>>('timer/discard-idle', {
      method: 'POST',
      body: { from: from.toISOString(), to: to.toISOString(), action, ...extra },
    });
    return { entry: data.entry ?? null, timer: data.timer ?? null, reassigned: data.reassigned ?? null };
  }

  /** Own entries, newest first (defaults on the server: the last 7 days). */
  async entries(query: EntryQuery = {}): Promise<EntriesPage> {
    const limit = Math.min(Math.max(query.limit ?? MAX_ENTRY_LIMIT, 1), MAX_ENTRY_LIMIT);
    const data = await this.json<Partial<EntriesPage>>('entries', {
      query: { from: query.from?.toISOString(), to: query.to?.toISOString(), limit, offset: query.offset },
    });
    return { entries: data.entries ?? [], limit: data.limit ?? limit, offset: data.offset ?? query.offset ?? 0 };
  }

  /** Own data export (RGPD art. 15 / 20). */
  async exportEntries(from: Date, to: Date, format: ExportFormat): Promise<ExportResult> {
    const response = await this.raw('export', {
      query: { from: from.toISOString(), to: to.toISOString(), format },
    });
    const fallback = `time-entries-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.${format}`;
    return {
      blob: await response.blob(),
      filename: filenameFrom(response.headers.get('Content-Disposition'), fallback),
    };
  }

  /** Device flow step 1. Throws `ApiError` with code `invalid_scope` when the server refuses a scope. */
  async deviceCode(clientName: string, scopes: readonly Scope[] = ALL_SCOPES): Promise<DeviceCode> {
    return this.requestDeviceCode({ clientType: this.source, clientName, scopes }, false);
  }

  /**
   * Device flow step 1 for the `chat` scope family (TimeTrackBundle 2.2, contract v0.5, BD-2): chained to this device
   * with the time token as `Authorization` (only the same user can approve it). The answer of `device/token` then
   * carries `scopeFamily: "chat"`, and the host keeps that token apart from the time token.
   *
   * BD-3b asks for reading and sending (`chat:read chat:write`, ChatKit 2.5 writes); a server whose chat family does
   * not know `chat:write` (`invalid_scope`) is asked again for reading only, and the app stays read-only there.
   */
  async chatDeviceCode(clientName: string): Promise<DeviceCode> {
    try {
      return await this.requestDeviceCode({ clientType: this.source, clientName, scopes: ['chat:read', 'chat:write'], family: 'chat' }, true);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'invalid_scope')) throw error;
      return this.requestDeviceCode({ clientType: this.source, clientName, scopes: ['chat:read'], family: 'chat' }, true);
    }
  }

  /**
   * Device flow step 1 for the `tasks` scope family (BD-3b, `BEACON_DESKTOP_TASKS.md` §3.1): chained like chat, scopes
   * `task-board:read task-board:write`; the answer of `device/token` carries `scopeFamily: "tasks"`.
   */
  async tasksDeviceCode(clientName: string): Promise<DeviceCode> {
    return this.requestDeviceCode({ clientType: this.source, clientName, scopes: ['task-board:read', 'task-board:write'], family: 'tasks' }, true);
  }

  private async requestDeviceCode(body: Record<string, unknown>, chained: boolean): Promise<DeviceCode> {
    const data = await this.json<Partial<DeviceCode>>('device/code', {
      method: 'POST',
      auth: chained,
      body,
    });
    if (typeof data.deviceCode !== 'string' || typeof data.userCode !== 'string' || typeof data.verificationUri !== 'string') {
      throw new ApiError(200, 'invalid_response', 'The server returned an invalid device code.');
    }
    return {
      deviceCode: data.deviceCode,
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      expiresIn: data.expiresIn ?? 600,
      interval: Math.max(data.interval ?? 5, 1),
    };
  }

  async deviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    try {
      const data = await this.json<Partial<LoginResult>>('device/token', {
        method: 'POST',
        auth: false,
        body: { deviceCode },
      });
      return { status: 'approved', ...this.loginResult(data) };
    } catch (error) {
      if (error instanceof ApiError) {
        switch (error.code) {
          case 'authorization_pending':
            return { status: 'pending' };
          case 'slow_down':
            return { status: 'slow_down' };
          case 'expired_token':
            return { status: 'expired' };
          case 'access_denied':
            return { status: 'denied' };
          case 'invalid_scope':
            return { status: 'invalid_scope' };
        }
      }
      throw error;
    }
  }

  private loginResult(data: Partial<LoginResult>): LoginResult {
    if (typeof data.token !== 'string' || data.token === '') {
      throw new ApiError(200, 'invalid_response', 'The server did not return a token.');
    }
    return {
      token: data.token,
      expiresAt: data.expiresAt ?? '',
      scopes: (data.scopes ?? []) as Scope[],
    };
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(path, options);
    if (response.status === 204) {
      return null as T;
    }
    const text = await response.text();
    if (text === '') {
      return null as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(response.status, 'invalid_response', 'The server returned an invalid response.');
    }
  }

  private async raw(path: string, options: RequestOptions = {}): Promise<Response> {
    try {
      return await this.send(path, options);
    } catch (error) {
      const refused = this.context;
      if (!(error instanceof ApiError && error.status === 403 && error.code === 'context_forbidden' && refused !== null && refused !== 'personal')) throw error;
      // Beacon's rule (as the chat's): the refused context is never used again; Personal is always the person's own.
      this.onContextRefused?.(refused);
      // A write is not retried and does not move this client either (its time would be recorded in another
      // organization, and later writes keep the context they were made for, audit ZCD-M1).
      if ((options.method ?? 'GET') !== 'GET') throw error;
      // A read is retried once in Personal.
      this.context = 'personal';
      return this.send(path, options);
    }
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const url = new URL(`${this.baseUrl}${this.prefix}/${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.context !== null) headers[CONTEXT_HEADER] = this.context;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.auth !== false) {
      if (this.token === null) {
        throw new ApiError(401, 'invalid_token', 'Not connected.');
      }
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      throw new ApiError(0, 'network_error', error instanceof Error ? error.message : 'Network error.');
    }

    if (!response.ok) {
      throw await this.error(response);
    }
    return response;
  }

  private async error(response: Response): Promise<ApiError> {
    let body: { error?: unknown; message?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = {};
    }
    const rawCode = typeof body.error === 'string' ? body.error : '';
    const code = CODE_PATTERN.test(rawCode) ? rawCode : (STATUS_CODES[response.status] ?? 'server_error');
    const message =
      typeof body.message === 'string' && body.message !== ''
        ? body.message
        : rawCode !== ''
          ? rawCode
          : response.statusText || `HTTP ${response.status}`;
    return new ApiError(response.status, code, message, parseRetryAfter(response.headers.get('Retry-After')));
  }
}
