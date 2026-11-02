/**
 * TimeTrackBundle client API (contract v0.2). Single module that talks to the server:
 * when the contract changes, only this file and `types.ts` should need edits.
 *
 * Privacy rules enforced here:
 * - requests never carry cookies (`credentials: 'omit'`), only the Bearer token;
 * - `timer/start` sends the closed `source` enum, never free metadata (no URLs, no window titles);
 * - idle state is never sent; only the user's decision via `timer/discard-idle`.
 */
import type {
  ClientSource,
  DeviceCode,
  DeviceTokenResult,
  EntriesPage,
  Entry,
  EntryQuery,
  ExportFormat,
  ExportResult,
  IdleAction,
  LoginResult,
  Me,
  Scope,
  Task,
  TaskQuery,
  Timer,
  TimerChange,
} from './types';
import { ALL_SCOPES } from './types';

export const API_PREFIX = '/api/time-track';
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

function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
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

  constructor(config: ApiClientConfig) {
    this.baseUrl = normalizeServerUrl(config.baseUrl);
    this.prefix = config.prefix ?? API_PREFIX;
    this.source = config.source;
    this.token = config.token ?? null;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
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
    };
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
    const data = await this.json<{ timer: Timer }>('timer/start', {
      method: 'POST',
      body: { taskId, note: blankToUndefined(note), source: this.source },
    });
    return data.timer;
  }

  /** Stops the running timer. Resolves to `null` when no timer was running (`404 no_active_timer`). */
  async stop(note?: string): Promise<Entry | null> {
    try {
      const data = await this.json<{ entry: Entry }>('timer/stop', {
        method: 'POST',
        body: { note: blankToUndefined(note) },
      });
      return data.entry;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no_active_timer') {
        return null;
      }
      throw error;
    }
  }

  /** Stops the running timer (if any) and starts `taskId` atomically. `note` goes to the stopped entry. */
  async switchTask(taskId: string, note?: string): Promise<TimerChange> {
    const data = await this.json<Partial<TimerChange>>('timer/switch', {
      method: 'POST',
      body: { taskId, note: blankToUndefined(note), source: this.source },
    });
    return { entry: data.entry ?? null, timer: data.timer ?? null };
  }

  /** Sends the user's decision about an idle period detected locally. Idle state itself is never sent. */
  async discardIdle(from: Date, to: Date, action: IdleAction): Promise<TimerChange> {
    const data = await this.json<Partial<TimerChange>>('timer/discard-idle', {
      method: 'POST',
      body: { from: from.toISOString(), to: to.toISOString(), action },
    });
    return { entry: data.entry ?? null, timer: data.timer ?? null };
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
    const data = await this.json<Partial<DeviceCode>>('device/code', {
      method: 'POST',
      auth: false,
      body: { clientType: this.source, clientName, scopes },
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
    const url = new URL(`${this.baseUrl}${this.prefix}/${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
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
