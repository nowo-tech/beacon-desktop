/**
 * ChatKit client API v1 (`/api/chat/v1`, ChatKitBundle 2.4.0): read routes only (BD-2). Bearer only, no cookies, no
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
  parseThreadPage,
  type ThreadPage,
} from './types';

export const CHAT_PREFIX = '/api/chat/v1';
export const CONTEXT_HEADER = 'X-Beacon-Context';
/** Largest page the API serves (`limit` 1–100). */
export const MAX_LIMIT = 100;

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

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

  /** Moves the read cursor (server caps it, never moves it back). Returns the new `readUpTo`. */
  async read(uuid: string, messageId: number): Promise<number | null> {
    const data = (await this.request('POST', `conversations/${uuidPath(uuid)}/read`, {}, { messageId })) as { readUpTo?: unknown } | null;
    return typeof data?.readUpTo === 'number' ? data.readUpTo : null;
  }

  private get(path: string, query: Query = {}): Promise<unknown> {
    return this.request('GET', path, query);
  }

  private async request(method: 'GET' | 'POST', path: string, query: Query, body?: unknown): Promise<unknown> {
    if (this.token === null) throw new ApiError(401, 'invalid_token', 'Chat is not connected.');
    const url = new URL(`${this.server}${CHAT_PREFIX}/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.token}` };
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
