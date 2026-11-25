// The chat client API v1 against the mock ChatKit (mock-server/chat.mjs), the chained "Connect chat" device flow
// against the mock TimeTrack (contract v0.5), and the sync layer's budget, hints and polling with a fake clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TimeTrackApi } from '../../src/api/client';
import { ChatApi } from '../../src/chat/api';
import { BUDGET, ChatSync, HINT_DELAY, POLL_HIDDEN_MS, POLL_VISIBLE_MS, RateLimited, type SyncClock, type SyncEvents } from '../../src/chat/sync';
import type { ConversationsPage, Message, MessagesPage } from '../../src/chat/types';
import { runDeviceFlow } from '../../src/lib/deviceFlow';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ENVELOPE = '0c000000-0000-4000-8000-000000000001';
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function timeToken(): Promise<string> {
  const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', fetchImpl: nodeFetch });
  return (await runDeviceFlow(api, { clientName: 'test', sleep, onCode: async (code) => void (await env.control('device/approve', { userCode: code.userCode })) })).token;
}

async function chatToken(time: string): Promise<{ token: string; family: unknown }> {
  const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: time, fetchImpl: nodeFetch });
  const result = await runDeviceFlow(
    { deviceCode: (name) => api.chatDeviceCode(name), deviceToken: (code) => api.deviceToken(code) },
    { clientName: 'Beacon Desktop', sleep, onCode: async (code) => void (await env.control('device/approve', { userCode: code.userCode })) },
  );
  const state = (await env.control('state')) as { requests: { path: string; body: string }[] };
  const request = state.requests.filter((item) => item.path.endsWith('device/code')).at(-1);
  return { token: result.token, family: JSON.parse(request?.body ?? '{}').family };
}

describe('chat client API v1 (mock ChatKit)', () => {
  let time = '';
  let chat = '';
  beforeAll(async () => {
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
    time = await timeToken();
    const connected = await chatToken(time);
    chat = connected.token;
    expect(connected.family).toBe('chat');
  });

  it('chains the chat device code with the time token and keeps the tokens apart (R3)', async () => {
    // A chat token cannot open the time API.
    const timeApi = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: chat, fetchImpl: nodeFetch });
    await expect(timeApi.me()).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
    // A time token cannot open the chat API.
    const wrong = new ChatApi({ baseUrl: env.url, token: time, context: 'personal', fetchImpl: nodeFetch });
    await expect(wrong.me()).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
    // Without a token nothing is sent.
    await expect(new ChatApi({ baseUrl: env.url, token: null, context: null, fetchImpl: nodeFetch }).me()).rejects.toMatchObject({ status: 401 });
  });

  it('reads me, conversations, messages, a message, a thread and moves the read cursor', async () => {
    const api = new ChatApi({ baseUrl: env.url, token: chat, context: ORG, fetchImpl: nodeFetch });
    expect(api.currentContext).toBe(ORG);
    const me = await api.me();
    expect(me.contexts.map((item) => item.label)).toEqual(['Personal', 'Lumen Works', 'Harbor Studio']);
    const page = await api.conversations(null, 5);
    expect(page.conversations).toHaveLength(5);
    expect(page.nextCursor).not.toBeNull();
    expect(page.unreadTotal).toBeGreaterThan(0);
    const next = await api.conversations(page.nextCursor, 5);
    expect(next.unreadTotal).toBeNull();
    expect((await api.conversation(ENVELOPE))?.membersCount).toBe(6);
    const newest = await api.messages(ENVELOPE, { limit: 10 });
    expect(newest.messages).toHaveLength(10);
    expect(newest.hasMore).toBe(true);
    const older = await api.messages(ENVELOPE, { before: newest.messages[0].id, limit: 100 });
    expect(older.messages.at(-1)?.id).toBeLessThan(newest.messages[0].id);
    const after = await api.messages(ENVELOPE, { after: newest.messages[5].id });
    expect(after.messages).toHaveLength(4);
    await expect(api.messages(ENVELOPE, { before: 1, after: 2 })).rejects.toMatchObject({ code: 'invalid_cursor' });
    const root = newest.messages.find((item) => item.thread !== null) as Message;
    expect((await api.message(ENVELOPE, root.uuid))?.uuid).toBe(root.uuid);
    const thread = await api.thread(ENVELOPE, root.uuid);
    expect(thread?.replies).toHaveLength(3);
    await expect(api.thread(ENVELOPE, root.uuid, { before: 1, after: 2 })).rejects.toBeInstanceOf(ApiError);
    const last = newest.messages.at(-1) as Message;
    expect(await api.read(ENVELOPE, last.id)).toBe(last.id);
    const state = (await env.control('chat/state')) as { reads: { context: string }[] };
    expect(state.reads.at(-1)?.context).toBe(ORG);
    await expect(api.messages('../../me')).rejects.toMatchObject({ code: 'invalid_uuid' });
  });

  it('sends the context on every request; another context hides the conversation (404)', async () => {
    const api = new ChatApi({ baseUrl: env.url, token: chat, context: 'personal', fetchImpl: nodeFetch });
    await expect(api.messages(ENVELOPE)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    api.setContext('org:unknown');
    await expect(api.me()).rejects.toMatchObject({ status: 403, code: 'context_forbidden' });
    api.setContext('bad key!');
    expect(api.currentContext).toBeNull();
    await expect(api.me()).rejects.toMatchObject({ status: 400, code: 'context_required' });
    api.setToken(null);
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
  });

  it('maps 429 to retryAfter and network failures to network_error', async () => {
    const api = new ChatApi({ baseUrl: env.url, token: chat, context: ORG, fetchImpl: nodeFetch });
    await env.control('config', { chatFailNext: { status: 429, error: 'rate_limited', retryAfter: 7 } });
    await expect(api.me()).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 7 });
    await env.control('config', { chatFailNext: { status: 500, error: 'Bad Thing' } });
    await expect(api.me()).rejects.toMatchObject({ status: 500, code: 'server_error' });
    const offline = new ChatApi({ baseUrl: env.url, token: chat, context: ORG, fetchImpl: (async () => Promise.reject(new Error('down'))) as unknown as typeof fetch });
    await expect(offline.me()).rejects.toMatchObject({ code: 'network_error' });
    const junk = new ChatApi({ baseUrl: env.url, token: chat, context: ORG, fetchImpl: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch });
    await expect(junk.me()).rejects.toMatchObject({ code: 'invalid_response' });
    const empty = new ChatApi({ baseUrl: env.url, token: chat, context: ORG, fetchImpl: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
    expect((await empty.me()).user.name).toBe('?');
    expect(await empty.conversation(ENVELOPE)).toBeNull();
    expect(await empty.message(ENVELOPE, ENVELOPE)).toBeNull();
    expect(await empty.read(ENVELOPE, 1)).toBeNull();
    const unauthorized = new ChatApi({ baseUrl: env.url, token: chat, context: ORG, fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch });
    await expect(unauthorized.me()).rejects.toMatchObject({ code: 'invalid_token' });
    const notFound = new ChatApi({ baseUrl: env.url, token: chat, context: ORG, fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch });
    await expect(notFound.me()).rejects.toMatchObject({ code: 'not_found' });
    const limited = new ChatApi({ baseUrl: env.url, token: chat, context: ORG, fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch });
    await expect(limited.me()).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('revokes the chat token on logout, best effort (ZBZ-L4)', async () => {
    const token = (await chatToken(time)).token;
    const api = new ChatApi({ baseUrl: env.url, token, context: null, fetchImpl: nodeFetch });
    expect(await api.logout()).toBe(true);
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    // Idempotent: again 204.
    expect(await api.logout()).toBe(true);
    await env.control('config', { chatLogoutMissing: true });
    expect(await api.logout()).toBe(false);
    await env.control('config', { chatLogoutMissing: false });
    const offline = new ChatApi({ baseUrl: env.url, token, context: null, fetchImpl: (async () => Promise.reject(new Error('down'))) as unknown as typeof fetch });
    expect(await offline.logout()).toBe(false);
    const slow = new ChatApi({ baseUrl: env.url, token, context: null, fetchImpl: (() => new Promise(() => undefined)) as unknown as typeof fetch });
    expect(await slow.logout(10)).toBe(false);
  });

  it('denies a chained request approved by another person', async () => {
    const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: time, fetchImpl: nodeFetch });
    await expect(
      runDeviceFlow(
        { deviceCode: (name) => api.chatDeviceCode(name), deviceToken: (code) => api.deviceToken(code) },
        { clientName: 'x', sleep, onCode: async (code) => void (await env.control('device/approve', { userCode: code.userCode, userId: 2 })) },
      ),
    ).rejects.toMatchObject({ reason: 'denied' });
  });
});

// ---- sync (fake API, fake clock) ---------------------------------------------------------------------------------------

const uuid = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function msg(id: number, extra: Partial<Message> = {}): Message {
  return { id, uuid: uuid(id), kind: 'user', author: { uuid: null, name: 'Maya', initials: 'MO', bot: false }, mine: false, createdAt: '2026-11-25T10:00:00Z', edited: false, deleted: false, mentionsMe: false, threadRootUuid: null, thread: null, reactions: [], blocks: [] , ...extra };
}
const row = (n: number, unread = 0) => ({ uuid: uuid(n), kind: 'channel' as const, title: `r${n}`, subtitle: '', initials: 'R', channelKey: null, peerStatus: null, unread, archived: false, mutedUntil: null, lastMessageAt: '', lastMessageId: null, preview: null, ticketStatus: null });

function fakeClock(): SyncClock & { timers: { at: number; run: () => void }[]; advance(ms: number): void; t: number } {
  const clock = {
    t: 1_000_000,
    timers: [] as { at: number; run: () => void }[],
    now: () => clock.t,
    random: () => 0.5,
    setTimeout: (run: () => void, ms: number) => {
      const timer = { at: clock.t + ms, run };
      clock.timers.push(timer);
      return timer;
    },
    clearTimeout: (handle: unknown) => {
      clock.timers = clock.timers.filter((timer) => timer !== handle);
    },
    advance(ms: number) {
      clock.t += ms;
      const due = clock.timers.filter((timer) => timer.at <= clock.t);
      clock.timers = clock.timers.filter((timer) => timer.at > clock.t);
      for (const timer of due) timer.run();
    },
  };
  return clock;
}

function fakeApi() {
  const calls: string[] = [];
  let timeline: Message[] = Array.from({ length: 80 }, (_, i) => msg(i + 1));
  const api = {
    calls,
    fail: null as ApiError | null,
    page: { conversations: [row(1, 2), row(2)], nextCursor: null, unreadTotal: 2, unreadTotalCapped: false } as ConversationsPage,
    set timeline(list: Message[]) {
      timeline = list;
    },
    async conversations(cursor: string | null) {
      calls.push(`list:${cursor ?? ''}`);
      if (api.fail) throw api.fail;
      return cursor === null ? api.page : { conversations: [row(3)], nextCursor: null, unreadTotal: null, unreadTotalCapped: false };
    },
    async messages(uuidValue: string, options: { before?: number; after?: number; limit?: number } = {}): Promise<MessagesPage> {
      calls.push(`messages:${options.before !== undefined ? `before=${options.before}` : options.after !== undefined ? `after=${options.after}` : 'newest'}`);
      if (api.fail) throw api.fail;
      const limit = options.limit ?? 30;
      if (options.after !== undefined) {
        const newer = timeline.filter((item) => item.id > (options.after as number));
        return { messages: newer.slice(0, limit), hasMore: newer.length > limit, readUpTo: 10 };
      }
      const older = options.before !== undefined ? timeline.filter((item) => item.id < (options.before as number)) : timeline;
      return { messages: older.slice(-limit), hasMore: older.length > limit, readUpTo: 70 };
    },
    async message(_: string, messageUuid: string) {
      calls.push(`message:${messageUuid.slice(-2)}`);
      return msg(Number(messageUuid.slice(-12)), { edited: true });
    },
    async thread(_: string, root: string, options: { before?: number; after?: number } = {}) {
      calls.push(`thread:${options.before ?? ''}:${options.after ?? ''}`);
      return { root: msg(Number(root.slice(-12))), replies: [msg(500), msg(501)], hasMore: options.before === undefined, replyCount: 2 };
    },
    async read(_: string, id: number) {
      calls.push(`read:${id}`);
      return id;
    },
  };
  return api;
}

function events(): SyncEvents & { log: string[] } {
  const log: string[] = [];
  return { log, changed: (scope) => log.push(`changed:${scope}`), arrived: (count, author) => log.push(`arrived:${count}:${author}`), unauthorized: () => log.push('unauthorized'), status: (state) => log.push(`status:${state}`) };
}

describe('chat sync', () => {
  let api: ReturnType<typeof fakeApi>;
  let clock: ReturnType<typeof fakeClock>;
  let ev: ReturnType<typeof events>;
  let sync: ChatSync;
  beforeEach(() => {
    api = fakeApi();
    clock = fakeClock();
    ev = events();
    sync = new ChatSync(api as unknown as ChatApi, ev, clock);
  });

  it('loads the list, opens a conversation from cache, loads older pages and catches up', async () => {
    api.page = { ...api.page, nextCursor: 'more' };
    await sync.start();
    expect(api.calls).toEqual(['list:', 'list:more']);
    expect(sync.store.conversations()).toHaveLength(3);
    await sync.open(uuid(1));
    expect(sync.store.timeline(uuid(1))?.messages).toHaveLength(50);
    expect(await sync.loadOlder(uuid(1))).toBe(true);
    expect(sync.store.timeline(uuid(1))?.messages).toHaveLength(80);
    expect(await sync.loadOlder(uuid(1))).toBe(false);
    api.timeline = [...Array.from({ length: 80 }, (_, i) => msg(i + 1)), msg(81), msg(82, { mine: true })];
    api.calls.length = 0;
    await sync.open(uuid(1));
    expect(api.calls).toEqual(['messages:after=80']);
    expect(ev.log).toContain('arrived:1:Maya');
    await sync.loadMoreConversations();
    expect(await sync.loadOlder('missing')).toBe(false);
  });

  it('marks read only when visible, beyond the cursor, once', async () => {
    await sync.start();
    await sync.open(uuid(1));
    await sync.markRead(uuid(1));
    expect(api.calls.filter((call) => call.startsWith('read'))).toEqual([]);
    sync.setVisible(true);
    await sync.markRead(uuid(1));
    await sync.markRead(uuid(1));
    expect(api.calls.filter((call) => call.startsWith('read'))).toEqual(['read:80']);
    expect(sync.store.conversation(uuid(1))?.unread).toBe(0);
  });

  it('batches hints: one list fetch, one catch-up, single messages, the open thread', async () => {
    await sync.start();
    await sync.open(uuid(1));
    await sync.openThread(uuid(1), uuid(5));
    api.calls.length = 0;
    sync.hint({ kind: 'message', conversationUuid: uuid(1), messageUuid: uuid(81) });
    sync.hint({ kind: 'message', conversationUuid: uuid(1), messageUuid: uuid(82) });
    sync.hint({ kind: 'message_updated', conversationUuid: uuid(1), messageUuid: uuid(40) });
    sync.hint({ kind: 'thread', conversationUuid: uuid(1), rootUuid: uuid(5) });
    sync.hint({ kind: 'message', conversationUuid: uuid(99) });
    expect(api.calls).toEqual([]);
    clock.advance(HINT_DELAY);
    await vi.waitFor(() => expect(api.calls).toContain('thread::501'));
    expect(api.calls.filter((call) => call === 'list:')).toHaveLength(1);
    expect(api.calls.filter((call) => call.startsWith('messages:after'))).toHaveLength(1);
    expect(api.calls).toContain('message:40');
    expect(api.calls).toContain('message:05');
    // Many updates at once: the newest page instead of one call each.
    api.calls.length = 0;
    for (let i = 60; i < 66; i += 1) sync.hint({ kind: 'message_updated', conversationUuid: uuid(1), messageUuid: uuid(i) });
    await sync.flush();
    expect(api.calls.filter((call) => call.startsWith('message:'))).toEqual([]);
    expect(api.calls).toContain('messages:newest');
    await sync.loadOlderReplies(uuid(1), uuid(5));
    sync.closeThread();
    expect(sync.threadRoot).toBeNull();
    await sync.flush();
  });

  it('polls 30 s while visible, 120 s in the background, never while live', async () => {
    await sync.start();
    expect(sync.nextPollDelay()).toBe(POLL_HIDDEN_MS);
    sync.setVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sync.nextPollDelay()).toBe(POLL_VISIBLE_MS);
    sync.setLive(true);
    expect(sync.nextPollDelay()).toBeNull();
    api.calls.length = 0;
    sync.setLive(false);
    await vi.waitFor(() => expect(api.calls).toContain('list:'));
    await vi.waitFor(() => expect(clock.timers.some((timer) => timer.at === clock.t + POLL_VISIBLE_MS)).toBe(true));
    clock.advance(POLL_VISIBLE_MS);
    await vi.waitFor(() => expect(api.calls.filter((call) => call === 'list:').length).toBeGreaterThanOrEqual(2));
    sync.stop();
    expect(sync.nextPollDelay()).toBeNull();
  });

  it('honours Retry-After, backs off on errors and disconnects on 401', async () => {
    await sync.start();
    api.fail = new ApiError(429, 'rate_limited', 'x', 30);
    await expect(sync.loadList()).rejects.toBeInstanceOf(ApiError);
    expect(ev.log).toContain('status:limited');
    await expect(sync.loadList()).rejects.toBeInstanceOf(RateLimited);
    expect(sync.nextPollDelay()).toBeGreaterThanOrEqual(30_000);
    clock.advance(31_000);
    api.fail = new ApiError(0, 'network_error', 'down');
    await expect(sync.loadList()).rejects.toBeInstanceOf(ApiError);
    await expect(sync.loadList()).rejects.toBeInstanceOf(ApiError);
    expect(ev.log).toContain('status:offline');
    expect(sync.nextPollDelay()).toBeGreaterThanOrEqual(POLL_HIDDEN_MS);
    api.fail = null;
    await sync.loadList();
    expect(ev.log.at(-2)).toBe('status:ok');
    api.fail = new ApiError(401, 'invalid_token', 'x');
    await expect(sync.loadList()).rejects.toBeInstanceOf(ApiError);
    expect(ev.log).toContain('unauthorized');
    expect(sync.store.loaded).toBe(false);
  });

  it(`never sends more than ${BUDGET} requests a minute`, async () => {
    await sync.start();
    let refused = 0;
    for (let i = 0; i < BUDGET + 5; i += 1) {
      try {
        await sync.loadList();
      } catch (error) {
        if (error instanceof RateLimited) refused += 1;
      }
    }
    expect(refused).toBe(6);
    clock.advance(60_001);
    await sync.loadList();
  });

  it('drops results of a previous context and ignores hints after stop', async () => {
    await sync.start();
    const opening = sync.open(uuid(1));
    sync.reset();
    await opening;
    expect(sync.store.timeline(uuid(1))).toBeNull();
    sync.hint({ kind: 'message' });
    expect(clock.timers).toHaveLength(0);
    await sync.poll();
  });
});
