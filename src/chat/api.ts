/**
 * ChatKit client API v1 (`/api/chat/v1`): read routes (ChatKitBundle 2.4.0, BD-2) and writes (2.5.0, BD-3b: send, thread
 * reply, reactions, each with an `Idempotency-Key`). Bearer only, no cookies, no
 * redirects; the tenant goes in `X-Beacon-Context` on every request (design §4.4). In the Tauri app the token is
 * `SESSION_HANDLE`: Rust adds the real chat token to chat routes only (src-tauri/src/secret.rs).
 *
 * Budget: 60 requests per minute per token (ChatKit's audited default). The sync layer (sync.ts) polls and batches;
 * this client turns `429` into `ApiError.retryAfter` (seconds) for it.
 */
import { ApiError, normalizeServerUrl, parseRetryAfter } from '../api/client';
import {
  type ChatMe,
  CONTEXT_KEY,
  type Conversation,
  type ConversationsPage,
  isUuid,
  type Message,
  type MessagesPage,
  parseConversation,
  parseConversationsPage,
  parseMe,
  parseMessage,
  parseMessagesPage,
  parseReactions,
  parseThreadPage,
  parseWritten,
  type Reaction,
  type ThreadPage,
  type Written,
} from './types';

export const CHAT_PREFIX = '/api/chat/v1';
export const CONTEXT_HEADER = 'X-Beacon-Context';
/** Largest page the API serves (`limit` 1–100). */
export const MAX_LIMIT = 100;

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
/** ChatKit's key grammar (1–80 characters of `[A-Za-z0-9_.:-]`). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,80}$/;

/** A fresh key for one write (a UUID v4). Reused only to retry that same write. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** Whether a failed write may be sent again with the same key (ChatKit: timeout, lost answer, `5xx`, `409`, `429`). */
export function retryable(error: unknown): boolean {
  return error instanceof ApiError && (error.isNetwork || error.status === 409 || error.status === 429 || error.status >= 500);
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ChatApiConfig {
  baseUrl: string;
  token: string | null;
  context: string | null;
  fetchImpl?: typeof fetch;
}

type Query = Record<string, string | number | undefined>;

export class ChatApi {
  readonly server: string;
  /** Origin that relative reference URLs are resolved against. */
  readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | null;
  private context: string | null;

  constructor(config: ChatApiConfig) {
    this.server = normalizeServerUrl(config.baseUrl);
    this.origin = new URL(this.server).origin;
    this.token = config.token;
    this.context = config.context !== null && CONTEXT_KEY.test(config.context) ? config.context : null;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  setContext(context: string | null): void {
    this.context = context !== null && CONTEXT_KEY.test(context) ? context : null;
  }

  get currentContext(): string | null {
    return this.context;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  async me(): Promise<ChatMe> {
    return parseMe(await this.get('me'));
  }

  async conversations(cursor: string | null = null, limit = 50): Promise<ConversationsPage> {
    return parseConversationsPage(await this.get('conversations', { cursor: cursor ?? undefined, limit: clamp(limit) }));
  }

  async conversation(uuid: string): Promise<Conversation | null> {
    const data = (await this.get(`conversations/${uuidPath(uuid)}`)) as { conversation?: unknown } | null;
    return parseConversation(data?.conversation);
  }

  /** Oldest first. `before` (older page) and `after` (catch-up) are exclusive: never both. */
  async messages(uuid: string, options: { before?: number; after?: number; limit?: number } = {}): Promise<MessagesPage> {
    if (options.before !== undefined && options.after !== undefined) throw new ApiError(0, 'invalid_cursor', 'before and after are exclusive.');
    const data = await this.get(`conversations/${uuidPath(uuid)}/messages`, { before: options.before, after: options.after, limit: clamp(options.limit ?? 30) });
    return parseMessagesPage(data, this.origin);
  }

  async message(uuid: string, messageUuid: string): Promise<Message | null> {
    const data = (await this.get(`conversations/${uuidPath(uuid)}/messages/${uuidPath(messageUuid)}`)) as { message?: unknown } | null;
    return parseMessage(data?.message, this.origin);
  }

  async thread(uuid: string, messageUuid: string, options: { before?: number; after?: number } = {}): Promise<ThreadPage | null> {
    if (options.before !== undefined && options.after !== undefined) throw new ApiError(0, 'invalid_cursor', 'before and after are exclusive.');
    const data = await this.get(`conversations/${uuidPath(uuid)}/messages/${uuidPath(messageUuid)}/thread`, { before: options.before, after: options.after });
    return parseThreadPage(data, this.origin);
  }

  /**
   * Revokes the presented chat token on the server (ChatKit 2.4.1 `POST logout`, idempotent, always 204; audit
   * ZBZ-L4). Best effort with a short timeout: an older server (404), a network error or a slow answer never blocks
   * the local disconnect or sign-out. Resolves whether the server confirmed it.
   */
  async logout(timeoutMs = 3000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const request = this.request('POST', 'logout', {}, {}).then(
      () => true,
      () => false,
    );
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Moves the read cursor (server caps it, never moves it back). Returns the new `readUpTo`. */
  async read(uuid: string, messageId: number): Promise<number | null> {
    const data = (await this.request('POST', `conversations/${uuidPath(uuid)}/read`, {}, { messageId })) as { readUpTo?: unknown } | null;
    return typeof data?.readUpTo === 'number' ? data.readUpTo : null;
  }

  /** Sends a message (`POST …/messages {text}`, `chat:write`). `201`, or `200` for a replay of the same key. */
  async send(uuid: string, text: string, key: string): Promise<Written> {
    return this.written(await this.write('POST', `conversations/${uuidPath(uuid)}/messages`, key, { text }));
  }

  /** Replies in the thread of `root` (`POST …/messages/{root}/thread {text}`); the answer carries the updated root. */
  async reply(uuid: string, root: string, text: string, key: string): Promise<Written> {
    return this.written(await this.write('POST', `conversations/${uuidPath(uuid)}/messages/${uuidPath(root)}/thread`, key, { text }));
  }

  /** Sets (`on`) or removes the reader's reaction; idempotent on the server. Answers the message's reactions after it. */
  async react(uuid: string, messageUuid: string, emoji: string, on: boolean, key: string): Promise<Reaction[]> {
    const reactions = parseReactions(await this.write(on ? 'PUT' : 'DELETE', `conversations/${uuidPath(uuid)}/messages/${uuidPath(messageUuid)}/reactions/${encodeURIComponent(emoji)}`, key));
    if (reactions === null) throw new ApiError(200, 'invalid_response', 'The server returned an invalid response.');
    return reactions;
  }

  private written(data: unknown): Written {
    const written = parseWritten(data, this.origin);
    if (written === null) throw new ApiError(200, 'invalid_response', 'The server returned an invalid response.');
    return written;
  }

  private write(method: Method, path: string, key: string, body?: unknown): Promise<unknown> {
    if (!IDEMPOTENCY_KEY.test(key)) throw new ApiError(0, 'idempotency_key_invalid', 'Invalid idempotency key.');
    return this.request(method, path, {}, body, { 'Idempotency-Key': key });
  }

  private get(path: string, query: Query = {}): Promise<unknown> {
    return this.request('GET', path, query);
  }

  private async request(method: Method, path: string, query: Query, body?: unknown, extra: Record<string, string> = {}): Promise<unknown> {
    if (this.token === null) throw new ApiError(401, 'invalid_token', 'Chat is not connected.');
    const url = new URL(`${this.server}${CHAT_PREFIX}/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.token}`, ...extra };
    if (this.context !== null) headers[CONTEXT_HEADER] = this.context;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      throw new ApiError(0, 'network_error', error instanceof Error ? error.message : 'Network error.');
    }
    const text = response.status === 204 ? '' : await response.text();
    let data: unknown = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
        if (response.ok) throw new ApiError(response.status, 'invalid_response', 'The server returned an invalid response.');
      }
    }
    if (!response.ok) {
      const raw = typeof (data as { error?: unknown } | null)?.error === 'string' ? (data as { error: string }).error : '';
      const code = CODE_PATTERN.test(raw) ? raw : response.status === 401 ? 'invalid_token' : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'not_found' : 'server_error';
      throw new ApiError(response.status, code, code, parseRetryAfter(response.headers.get('Retry-After')));
    }
    return data;
  }
}

function clamp(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/** Only uuids go into paths (no path traversal from a server value). */
function uuidPath(value: string): string {
  if (!isUuid(value)) throw new ApiError(0, 'invalid_uuid', 'Invalid id.');
  return value.toLowerCase();
}
