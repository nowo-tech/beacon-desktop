// @vitest-environment happy-dom
// Chat writes (BD-3b, ChatKit 2.5): the client's send / reply / react routes against the mock ChatKit (Idempotency-Key
// replays and mismatches, refusals, the read-only fallback of the device flow), the outbox (one key per write, retries,
// refusals, the catch-up that settles a sent message, optimistic reactions) with a fake clock, the parsers and the
// composer.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TimeTrackApi } from '../../src/api/client';
import { ChatApi, IDEMPOTENCY_KEY, newIdempotencyKey, retryable } from '../../src/chat/api';
import { Composer, insertListItem, wrapSelection } from '../../src/chat/composer';
import { inlineTokens, markdownBlocks, safeLinkUrl } from '../../src/chat/markdown';
import { placeActions } from '../../src/chat/module';
import { chatText } from '../../src/chat/i18n';
import { AUTO_RETRIES, ChatOutbox, type OutboxEvents, QUEUE_PROBE_MIN_MS, refusalOf, toggled, unreachable, waitFor } from '../../src/chat/outbox';
import { ChatSync, RateLimited, type SyncClock, type SyncEvents } from '../../src/chat/sync';
import { DEFAULT_QUICK, isEmoji, type Message, parseConversation, parseMe, parseReactions, parseWritten, writeAccess } from '../../src/chat/types';
import { runDeviceFlow } from '../../src/lib/deviceFlow';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ENVELOPE = '0c000000-0000-4000-8000-000000000001';
const INCIDENTS = '0c000000-0000-4000-8000-000000000002';
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const t = chatText('en');

async function timeToken(): Promise<string> {
  const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', fetchImpl: nodeFetch });
  return (await runDeviceFlow(api, { clientName: 'test', sleep, onCode: async (code) => void (await env.control('device/approve', { userCode: code.userCode })) })).token;
}

async function chatToken(): Promise<{ token: string; scopes: string[] }> {
  const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: await timeToken(), fetchImpl: nodeFetch });
  const result = await runDeviceFlow(
    { deviceCode: (name) => api.chatDeviceCode(name), deviceToken: (code) => api.deviceToken(code) },
    { clientName: 'Beacon Desktop', sleep, onCode: async (code) => void (await env.control('device/approve', { userCode: code.userCode })) },
  );
  const state = (await env.control('state')) as { requests: { path: string; body: string }[] };
  const request = state.requests.filter((item) => item.path.endsWith('device/code')).at(-1);
  return { token: result.token, scopes: JSON.parse(request?.body ?? '{}').scopes };
}

describe('chat writes against the mock ChatKit (2.5)', () => {
  let api: ChatApi;
  beforeAll(async () => {
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
    const connected = await chatToken();
    expect(connected.scopes).toEqual(['chat:read', 'chat:write']);
    api = new ChatApi({ baseUrl: env.url, token: connected.token, context: ORG, fetchImpl: nodeFetch });
  });

  it('feature-detects writes: scope, features, limits and the reactions the server accepts', async () => {
    const me = await api.me();
    expect(me.scopes).toContain('chat:write');
    expect(me.features).toMatchObject({ send: true, threadReply: true, reactions: true });
    expect(me.limits.textMaxLength).toBe(4000);
    expect(me.reactions.quick).toEqual(['👍', '👀', '✅', '🎉', '🙏']);
    expect(writeAccess(me)).toEqual({ needsApproval: false, send: true, threadReply: true, reactions: true });
    const incidents = await api.conversation(INCIDENTS);
    expect(incidents?.canSend).toBe(false);
  });

  it('sends once per Idempotency-Key: a retry replays, another text under the same key is refused', async () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(IDEMPOTENCY_KEY);
    const first = await api.send(ENVELOPE, 'Shipping the **fix**\nnow', key);
    expect(first.replayed).toBe(false);
    expect(first.message.mine).toBe(true);
    // The server answers the per-reader rendered form (tokens/1), never the raw Markdown.
    expect(first.message.blocks).toEqual([
      { type: 'paragraph', tokens: [{ type: 'text', text: 'Shipping the ', marks: [] }, { type: 'text', text: 'fix', marks: ['bold'] }, { type: 'break' }, { type: 'text', text: 'now', marks: [] }] },
    ]);
    expect(first.root).toBeNull();
    const again = await api.send(ENVELOPE, 'Shipping the **fix**\nnow', key);
    expect(again.replayed).toBe(true);
    expect(again.message.uuid).toBe(first.message.uuid);
    await expect(api.send(ENVELOPE, 'Something else', key)).rejects.toMatchObject({ status: 422, code: 'idempotency_mismatch' });
    // Refusals of the request itself (nothing written, never retried with the same key).
    await expect(api.send(INCIDENTS, 'Hello', newIdempotencyKey())).rejects.toMatchObject({ status: 403, code: 'read_only' });
    await expect(api.send(ENVELOPE, '   ', newIdempotencyKey())).rejects.toMatchObject({ status: 422, code: 'empty_text' });
    await expect(api.send(ENVELOPE, 'x'.repeat(4001), newIdempotencyKey())).rejects.toMatchObject({ status: 422, code: 'text_too_long' });
    // A malformed key never leaves the app.
    await expect(api.send(ENVELOPE, 'x', 'not a key!')).rejects.toMatchObject({ code: 'idempotency_key_invalid' });
    const writes = ((await env.control('chat/state')) as { writes: { replayed: boolean }[] }).writes;
    expect(writes.filter((item) => !item.replayed)).toHaveLength(1);
  });

  it('replies in a thread (the answer carries the updated root) and toggles reactions', async () => {
    const page = await api.messages(ENVELOPE, { limit: 100 });
    const root = page.messages.find((message) => message.thread !== null) as Message;
    const reply = await api.reply(ENVELOPE, root.uuid, 'On it', newIdempotencyKey());
    expect(reply.message.threadRootUuid).toBe(root.uuid);
    expect(reply.root?.thread?.count).toBe((root.thread?.count ?? 0) + 1);
    const on = await api.react(ENVELOPE, root.uuid, '🎉', true, newIdempotencyKey());
    expect(on).toContainEqual({ emoji: '🎉', count: 1, mine: true });
    const off = await api.react(ENVELOPE, root.uuid, '🎉', false, newIdempotencyKey());
    expect(off.some((reaction) => reaction.emoji === '🎉')).toBe(false);
    await expect(api.react(ENVELOPE, root.uuid, '🦄', true, newIdempotencyKey())).rejects.toMatchObject({ status: 422, code: 'invalid_reaction' });
    // ZDG-I2: never a dots-only path segment (refused before anything is sent).
    await expect(api.react(ENVELOPE, root.uuid, '..', true, newIdempotencyKey())).rejects.toMatchObject({ status: 0, code: 'invalid_reaction' });
    const state = (await env.control('state')) as { requests: { method: string; path: string }[] };
    expect(state.requests.filter((item) => item.method === 'PUT' || item.method === 'DELETE').map((item) => decodeURIComponent(item.path.split('/').at(-1) ?? ''))).toEqual(['🎉', '🎉', '🦄']);
  });

  it('stays read-only with a read-only token, and when the server has writes off', async () => {
    await env.control('config', { chatReadOnlyFamily: true });
    const readOnly = await chatToken();
    // The server's chat family does not know chat:write: the app asks again for reading only.
    expect(readOnly.scopes).toEqual(['chat:read']);
    const reader = new ChatApi({ baseUrl: env.url, token: readOnly.token, context: ORG, fetchImpl: nodeFetch });
    const me = await reader.me();
    expect(writeAccess(me)).toEqual({ needsApproval: true, send: false, threadReply: false, reactions: false });
    await expect(reader.send(ENVELOPE, 'Hi', newIdempotencyKey())).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
    await env.control('config', { chatReadOnlyFamily: false, chatWritesOff: true });
    const off = await api.me();
    expect(writeAccess(off)).toEqual({ needsApproval: false, send: false, threadReply: false, reactions: false });
    await expect(api.send(ENVELOPE, 'Hi', newIdempotencyKey())).rejects.toMatchObject({ status: 404 });
    await env.control('config', { chatWritesOff: false });
    expect(writeAccess(null)).toEqual({ needsApproval: false, send: false, threadReply: false, reactions: false });
  });

  it('keeps any other device-code error', async () => {
    const time = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: 'unknown-token', fetchImpl: nodeFetch });
    await expect(time.chatDeviceCode('Beacon Desktop')).rejects.toMatchObject({ status: 401 });
  });
});

describe('the composer\'s Markdown subset (pending rows and the mock)', () => {
  it('renders inline marks, code and safe links as data, leaving anything unclosed as typed', () => {
    expect(inlineTokens('a **b _c_** ~~d~~ `e*f` [g](https://x.example/p) [h](javascript:alert(1)) snake_case_name *i* ** j **')).toEqual([
      { type: 'text', text: 'a ', marks: [] },
      { type: 'text', text: 'b ', marks: ['bold'] },
      { type: 'text', text: 'c', marks: ['bold', 'italic'] },
      { type: 'text', text: ' ', marks: [] },
      { type: 'text', text: 'd', marks: ['strike'] },
      { type: 'text', text: ' ', marks: [] },
      { type: 'code', text: 'e*f' },
      { type: 'text', text: ' ', marks: [] },
      { type: 'link', url: 'https://x.example/p', text: 'g', card: false },
      { type: 'text', text: ' [h](javascript:alert(1)) snake_case_name ', marks: [] },
      { type: 'text', text: 'i', marks: ['italic'] },
      { type: 'text', text: ' ** j **', marks: [] },
    ]);
    expect(inlineTokens('[x](https://u:p@x.example) [y](not a url) `` **unclosed')).toEqual([{ type: 'text', text: '[x](https://u:p@x.example) [y](not a url) `` **unclosed', marks: [] }]);
    // ZDG-I1: the same rule as the server's copy: balanced parentheses in a URL, mailto without extras.
    expect(inlineTokens('[w](https://x.example/Foo_(bar)) [m](mailto:a@b.example?attach=/etc/passwd&subject=hi)')).toEqual([
      { type: 'link', url: 'https://x.example/Foo_(bar)', text: 'w', card: false },
      { type: 'text', text: ' ', marks: [] },
      { type: 'link', url: 'mailto:a@b.example?subject=hi', text: 'm', card: false },
    ]);
    expect(safeLinkUrl('/relative')).toBeNull();
    expect(safeLinkUrl('/relative', 'https://beacon.example')).toBe('https://beacon.example/relative');
    expect(safeLinkUrl(3)).toBeNull();
  });

  it('renders blocks: paragraphs, breaks, lists, quotes, fenced code', () => {
    expect(markdownBlocks('one\r\ntwo\n\n- a\n* b\n1. c\n2) d\n> q1\n>\n\n```\nx **y**\n```\n```\nopen')).toEqual([
      { type: 'paragraph', tokens: [{ type: 'text', text: 'one', marks: [] }, { type: 'break' }, { type: 'text', text: 'two', marks: [] }] },
      { type: 'list', ordered: false, items: [[{ type: 'text', text: 'a', marks: [] }], [{ type: 'text', text: 'b', marks: [] }]] },
      { type: 'list', ordered: true, items: [[{ type: 'text', text: 'c', marks: [] }], [{ type: 'text', text: 'd', marks: [] }]] },
      { type: 'quote', tokens: [{ type: 'text', text: 'q1', marks: [] }, { type: 'break' }] },
      { type: 'code', text: 'x **y**' },
      { type: 'paragraph', tokens: [{ type: 'text', text: '```', marks: [] }, { type: 'break' }, { type: 'text', text: 'open', marks: [] }] },
    ]);
    expect(markdownBlocks('')).toEqual([]);
    expect(markdownBlocks('> q\npara')).toEqual([
      { type: 'quote', tokens: [{ type: 'text', text: 'q', marks: [] }] },
      { type: 'paragraph', tokens: [{ type: 'text', text: 'para', marks: [] }] },
    ]);
  });

  it('moves a message toolbar inside its row when there is no room above', () => {
    const box = document.createElement('div');
    box.className = 'msgs';
    const item = document.createElement('li');
    item.className = 'msg';
    const bar = document.createElement('div');
    bar.className = 'm-actions';
    item.append(bar);
    box.append(item);
    document.body.replaceChildren(box);
    placeActions(bar);
    expect(item.classList.contains('actions-in')).toBe(true);
    item.getBoundingClientRect = () => ({ top: 200 }) as DOMRect;
    placeActions(item);
    expect(item.classList.contains('actions-in')).toBe(false);
    placeActions(box);
    placeActions(null);
    bar.remove();
    placeActions(item);
  });
});

describe('write parsers', () => {
  it('reads write answers, reactions and features defensively', () => {
    const origin = 'https://beacon.example';
    const message = { id: 5, uuid: '0c000000-0000-4000-8000-0000000000aa', author: { name: 'Ada' }, body: { format: 'tokens/1', blocks: [] }, reactions: [{ emoji: '👍', count: 2, mine: true }, { emoji: '', count: 1 }] };
    expect(parseWritten({ message, replayed: true }, origin)).toMatchObject({ replayed: true, root: null, message: { id: 5 } });
    expect(parseWritten({ message: { id: 'x' } }, origin)).toBeNull();
    expect(parseWritten(null, origin)).toBeNull();
    expect(parseReactions({ reactions: message.reactions })).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect(parseReactions({ reactions: 'no' })).toBeNull();
    expect(parseReactions([])).toBeNull();
    const me = parseMe({ scopes: ['chat:read', 'chat:write'], features: { send: true, reactions: true }, limits: { textMaxLength: 9000 }, reactions: { quick: ['👍', 'bad\u0000', ' x', 7, '🎉'], accepted: ['👍', '🎉', '✅'] } });
    expect(me.limits.textMaxLength).toBe(4000);
    expect(me.reactions.quick).toEqual(['👍', '🎉']);
    expect(me.features.threadReply).toBe(false);
    expect(writeAccess(me)).toEqual({ needsApproval: false, send: true, threadReply: false, reactions: true });
    expect(parseMe({ reactions: { accepted: ['👍', '✅'] } }).reactions.quick).toEqual(['👍', '✅']);
    expect(parseMe({}).reactions).toEqual({ quick: DEFAULT_QUICK, accepted: [] });
    expect(parseMe({ limits: { textMaxLength: 0 } }).limits.textMaxLength).toBe(4000);
    expect(isEmoji('👍')).toBe(true);
    expect(isEmoji('a\u007f')).toBe(false);
    expect(isEmoji('x'.repeat(65))).toBe(false);
    // ZDG-I2: dots only would be a path segment of their own.
    expect(isEmoji('.')).toBe(false);
    expect(isEmoji('..')).toBe(false);
    expect(parseReactions({ reactions: [{ emoji: '..', count: 1 }, { emoji: '👍', count: 1 }] })).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    expect(isEmoji(3)).toBe(false);
    const row = { uuid: '0c000000-0000-4000-8000-0000000000ab', kind: 'support', title: 'T' };
    expect(parseConversation(row)?.canSend).toBe(true);
    expect(parseConversation({ ...row, canSend: false })?.canSend).toBe(false);
    expect(parseConversation({ ...row, ticket: { statusLabel: 'Closed', readOnly: true } })?.canSend).toBe(false);
  });

  it('decides which failures may be retried with the same key', () => {
    expect(retryable(new ApiError(0, 'network_error', 'x'))).toBe(true);
    expect(retryable(new ApiError(503, 'server_error', 'x'))).toBe(true);
    expect(retryable(new ApiError(409, 'conflict', 'x'))).toBe(true);
    expect(retryable(new ApiError(429, 'rate_limited', 'x'))).toBe(true);
    expect(retryable(new ApiError(422, 'text_too_long', 'x'))).toBe(false);
    expect(retryable(new ApiError(0, 'invalid_uuid', 'x'))).toBe(false);
    expect(retryable(new Error('x'))).toBe(false);
    expect(refusalOf(new ApiError(403, 'read_only', 'x'))).toBe('read_only');
    expect(refusalOf(new ApiError(401, 'invalid_token', 'x'))).toBeNull();
    expect(refusalOf(new RateLimited(1))).toBeNull();
    expect(waitFor(new RateLimited(5000), 1000)).toBe(4000);
    expect(waitFor(new RateLimited(1100), 1000)).toBe(1000);
    expect(waitFor(new ApiError(429, 'rate_limited', 'x', 7), 0)).toBe(7000);
    expect(waitFor(new ApiError(429, 'rate_limited', 'x'), 0)).toBe(60_000);
    expect(waitFor(new ApiError(409, 'conflict', 'x'), 0)).toBe(1000);
    expect(waitFor(new ApiError(500, 'server_error', 'x'), 0)).toBeNull();
  });

  it('toggles reactions optimistically', () => {
    const base = [{ emoji: '👍', count: 2, mine: false }, { emoji: '👀', count: 1, mine: true }];
    expect(toggled(base, '👍', true)).toEqual([{ emoji: '👍', count: 3, mine: true }, base[1]]);
    expect(toggled(base, '🎉', true)).toEqual([...base, { emoji: '🎉', count: 1, mine: true }]);
    expect(toggled(base, '👀', true)).toBe(base);
    expect(toggled(base, '👀', false)).toEqual([base[0]]);
    expect(toggled([{ emoji: '👀', count: 3, mine: true }], '👀', false)).toEqual([{ emoji: '👀', count: 2, mine: false }]);
    expect(toggled(base, '👍', false)).toBe(base);
    expect(toggled(base, '🎉', false)).toBe(base);
  });
});

// ---- the outbox, with a stub API and a fake clock -------------------------------------------------------------------

class FakeClock implements SyncClock {
  time = 1_000_000;
  timers: { at: number; handler: () => void; id: number }[] = [];
  private next = 1;
  now = () => this.time;
  random = () => 0.5;
  setTimeout = (handler: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ at: this.time + ms, handler, id });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  advance(ms: number): void {
    this.time += ms;
    const due = this.timers.filter((timer) => timer.at <= this.time);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) timer.handler();
  }
}

const UUID = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = { uuid: UUID(900), name: 'Ada Lovelace', initials: 'AL', bot: false };
function msg(id: number, extra: Partial<Message> = {}): Message {
  return { id, uuid: UUID(id), kind: 'user', author: person, mine: false, createdAt: '2026-11-27T09:00:00Z', edited: false, deleted: false, mentionsMe: false, threadRootUuid: null, thread: null, reactions: [], blocks: [], ...extra };
}

function stub() {
  const calls: { kind: string; key: string; text?: string; on?: boolean }[] = [];
  const failures: unknown[] = [];
  const server: Message[] = [msg(1), msg(2, { thread: { count: 1, lastReplyAt: null } })];
  const replies: Message[] = [msg(50, { threadRootUuid: UUID(2) })];
  let nextId = 100;
  const fail = () => {
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
  };
  const api = {
    conversations: async () => ({ conversations: [], nextCursor: null, unreadTotal: 0, unreadTotalCapped: false }),
    messages: async (_uuid: string, options: { after?: number } = {}) => ({ messages: server.filter((item) => options.after === undefined || item.id > options.after), hasMore: false, readUpTo: null }),
    message: async () => null,
    thread: async (_uuid: string, root: string, options: { after?: number } = {}) => ({ root: { ...msg(2), uuid: root }, replies: replies.filter((item) => options.after === undefined || item.id > options.after), hasMore: false, replyCount: replies.length }),
    read: async () => null,
    send: async (_uuid: string, text: string, key: string) => {
      calls.push({ kind: 'send', key, text });
      fail();
      const message = msg(++nextId, { mine: true, author: person });
      server.push(message);
      return { message, root: null, replayed: false };
    },
    reply: async (_uuid: string, root: string, text: string, key: string) => {
      calls.push({ kind: 'reply', key, text });
      fail();
      const message = msg(++nextId, { mine: true, threadRootUuid: root });
      replies.push(message);
      return { message, root: msg(2, { thread: { count: replies.length, lastReplyAt: null } }), replayed: false };
    },
    react: async (_uuid: string, _message: string, emoji: string, on: boolean, key: string) => {
      calls.push({ kind: 'react', key, on });
      fail();
      return on ? [{ emoji, count: 5, mine: true }] : [];
    },
  };
  return { api, calls, failures, server };
}

function outboxFor() {
  const clock = new FakeClock();
  const fake = stub();
  const syncEvents: SyncEvents = { changed: vi.fn(), arrived: vi.fn(), unauthorized: vi.fn(), status: vi.fn() };
  const sync = new ChatSync(fake.api as unknown as ChatApi, syncEvents, clock);
  const events = { changed: vi.fn(), sent: vi.fn(), failed: vi.fn(), queued: vi.fn(), reactionFailed: vi.fn() } satisfies OutboxEvents;
  const outbox = new ChatOutbox(sync, events, clock);
  return { clock, sync, outbox, events, syncEvents, ...fake };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('outbox', () => {
  let ctx: ReturnType<typeof outboxFor>;
  beforeEach(async () => {
    ctx = outboxFor();
    await ctx.sync.start();
    await ctx.sync.open(ENVELOPE);
  });

  it('sends, shows the server copy until the catch-up brings it, then settles', async () => {
    const pending = ctx.outbox.send(ENVELOPE, null, 'Hello\nthere\n\nSecond paragraph');
    expect(pending.state).toBe('sending');
    const view = ChatOutbox.view(pending, person);
    expect(view.uuid).toBe(pending.key);
    expect(view.blocks).toEqual([
      { type: 'paragraph', tokens: [{ type: 'text', text: 'Hello', marks: [] }, { type: 'break' }, { type: 'text', text: 'there', marks: [] }] },
      { type: 'paragraph', tokens: [{ type: 'text', text: 'Second paragraph', marks: [] }] },
    ]);
    await settle();
    await settle();
    expect(ctx.events.sent).toHaveBeenCalledWith(pending);
    expect(ctx.sync.store.timeline(ENVELOPE)?.messages.at(-1)?.id).toBe(101);
    expect(ctx.outbox.pending(ENVELOPE, null)).toEqual([]);
    expect(ChatOutbox.view(pending, person).id).toBe(101);
  });

  it('queues a lost send (offline queue, UXA-6) and sends it once on reconnect with the same key', async () => {
    const offline = new ApiError(0, 'network_error', 'offline');
    ctx.failures.push(offline);
    const pending = ctx.outbox.send(ENVELOPE, null, 'Hi');
    await settle();
    expect(pending).toMatchObject({ state: 'queued', error: 'network_error' });
    expect(ctx.events.failed).not.toHaveBeenCalled();
    expect(ctx.events.queued).toHaveBeenCalledOnce();
    expect(ctx.outbox.queuedCount()).toBe(1);
    expect(ctx.outbox.discard('unknown')).toBeNull();
    // The sync says offline: nothing is attempted until the connection is back (or the probe, or Try now).
    ctx.outbox.setOnline(false);
    ctx.failures.push(offline);
    ctx.outbox.retry(pending.key);
    // A probe in flight keeps "Waiting for connection" and cannot be cancelled (it may be written).
    expect(pending.state).toBe('queued');
    expect(ctx.outbox.discard(pending.key)).toBeNull();
    await settle();
    expect(pending).toMatchObject({ state: 'queued', error: 'network_error' });
    ctx.outbox.setOnline(true);
    await settle();
    await settle();
    expect(ctx.calls.map((call) => call.key)).toEqual([pending.key, pending.key, pending.key]);
    expect(ctx.outbox.pending(ENVELOPE, null)).toEqual([]);
    expect(ctx.events.queued).toHaveBeenCalledOnce();
    // Retrying something that is not queued or failed does nothing.
    ctx.outbox.retry(pending.key);
    expect(ctx.calls).toHaveLength(3);
  });

  it('keeps the order: a message never overtakes an older one, offline or not, timeline and thread alike', async () => {
    ctx.outbox.setOnline(false);
    const first = ctx.outbox.send(ENVELOPE, null, 'One');
    const reply = ctx.outbox.send(ENVELOPE, UUID(2), 'Two in a thread');
    const third = ctx.outbox.send(ENVELOPE, null, 'Three');
    await settle();
    // Offline: queued at once, no request, one announcement each.
    expect(ctx.calls).toHaveLength(0);
    expect([first.state, reply.state, third.state]).toEqual(['queued', 'queued', 'queued']);
    expect(ctx.events.queued).toHaveBeenCalledTimes(3);
    ctx.outbox.setOnline(true);
    for (let i = 0; i < 8; i += 1) await settle();
    expect(ctx.calls.map((call) => call.text)).toEqual(['One', 'Two in a thread', 'Three']);
    expect(new Set(ctx.calls.map((call) => call.key)).size).toBe(3);
  });

  it('a lost message holds the next one back until it goes; the probe retries on its own with a growing wait', async () => {
    ctx.failures.push(new ApiError(0, 'network_error', 'offline'), new ApiError(503, 'server_error', 'down'));
    const first = ctx.outbox.send(ENVELOPE, null, 'One');
    await settle();
    // The sync reports the lost connection (its status event) before the person writes again.
    ctx.outbox.setOnline(false);
    const second = ctx.outbox.send(ENVELOPE, null, 'Two');
    await settle();
    expect(first.state).toBe('queued');
    // Written offline: waits for the connection behind the first one, no request of its own.
    expect(second).toMatchObject({ state: 'queued', error: 'network_error' });
    expect(ctx.outbox.waitingCount()).toBe(2);
    expect(ctx.calls.map((call) => call.text)).toEqual(['One']);
    ctx.clock.advance(QUEUE_PROBE_MIN_MS);
    await settle();
    // The probe tried again (a 503 this time): still queued, now as a server error, never "failed".
    expect(ctx.calls.map((call) => call.text)).toEqual(['One', 'One']);
    expect(first).toMatchObject({ state: 'queued', error: 'server_error' });
    ctx.clock.advance(QUEUE_PROBE_MIN_MS);
    await settle();
    expect(ctx.calls).toHaveLength(2);
    ctx.clock.advance(QUEUE_PROBE_MIN_MS);
    for (let i = 0; i < 8; i += 1) await settle();
    expect(ctx.calls.map((call) => call.text)).toEqual(['One', 'One', 'One', 'Two']);
    expect(ctx.calls[0].key).toBe(ctx.calls[2].key);
    expect(ctx.outbox.queuedCount()).toBe(0);
  });

  it('never has two attempts of one message in flight: a reconnect during a send does not send it again', async () => {
    let release: () => void = () => undefined;
    const send = ctx.api.send;
    ctx.api.send = async (uuid: string, text: string, key: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      return send(uuid, text, key);
    };
    const pending = ctx.outbox.send(ENVELOPE, null, 'Slow');
    expect(pending.state).toBe('sending');
    ctx.outbox.setOnline(false);
    ctx.outbox.setOnline(true);
    ctx.outbox.retry(pending.key);
    release();
    for (let i = 0; i < 6; i += 1) await settle();
    expect(ctx.calls).toHaveLength(1);
  });

  it('cancels a queued message (the next one goes), and a refusal at the head does not block the others', async () => {
    ctx.outbox.setOnline(false);
    const first = ctx.outbox.send(ENVELOPE, null, 'Cancel me');
    const second = ctx.outbox.send(ENVELOPE, null, 'Refused');
    const third = ctx.outbox.send(ENVELOPE, null, 'Fine');
    expect(ctx.outbox.discard(first.key)?.text).toBe('Cancel me');
    ctx.failures.push(new ApiError(422, 'text_too_long', 'long'));
    ctx.outbox.setOnline(true);
    for (let i = 0; i < 8; i += 1) await settle();
    expect(second).toMatchObject({ state: 'failed', canRetry: false, error: 'text_too_long' });
    expect(ctx.calls.map((call) => call.text)).toEqual(['Refused', 'Fine']);
    expect(third.state).not.toBe('queued');
    // A context switch (clear) forgets the queue: memory only, never on disk.
    ctx.outbox.setOnline(false);
    ctx.outbox.send(ENVELOPE, null, 'Gone');
    ctx.outbox.clear();
    expect(ctx.outbox.queuedCount()).toBe(0);
  });

  it('classifies what waits for the connection', () => {
    expect(unreachable(new ApiError(0, 'network_error', 'x'))).toBe('network_error');
    expect(unreachable(new ApiError(502, 'server_error', 'x'))).toBe('server_error');
    expect(unreachable(new ApiError(0, 'invalid_uuid', 'x'))).toBeNull();
    expect(unreachable(new ApiError(422, 'text_too_long', 'x'))).toBeNull();
    expect(unreachable(new RateLimited(1))).toBeNull();
    expect(unreachable(new Error('boom'))).toBeNull();
  });

  it('waits after a 429 or a 409 and retries on its own with the same key, then gives up', async () => {
    ctx.failures.push(new ApiError(429, 'rate_limited', 'slow', 3), new ApiError(409, 'conflict', 'busy'));
    const pending = ctx.outbox.send(ENVELOPE, null, 'Hi');
    await settle();
    expect(pending.state).toBe('waiting');
    ctx.clock.advance(60_000);
    await settle();
    expect(pending.state).toBe('waiting');
    ctx.clock.advance(1000);
    await settle();
    await settle();
    expect(ctx.calls.map((call) => call.key)).toEqual([pending.key, pending.key, pending.key]);
    expect(pending.state).not.toBe('failed');
    // Rate limited for good: after AUTO_RETRIES it stops and the person decides.
    for (let i = 0; i <= AUTO_RETRIES; i += 1) ctx.failures.push(new ApiError(429, 'rate_limited', 'slow', 1));
    const stuck = ctx.outbox.send(ENVELOPE, null, 'Again');
    for (let i = 0; i <= AUTO_RETRIES; i += 1) {
      await settle();
      ctx.clock.advance(61_000);
    }
    await settle();
    expect(stuck).toMatchObject({ state: 'failed', canRetry: true });
  });

  it('never retries a refusal: the text can be edited and sent again under a new key', async () => {
    ctx.failures.push(new ApiError(403, 'read_only', 'no'));
    const pending = ctx.outbox.send(ENVELOPE, null, 'Hi');
    await settle();
    expect(pending).toMatchObject({ state: 'failed', error: 'read_only', canRetry: false });
    ctx.outbox.retry(pending.key);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.outbox.discard(pending.key)?.text).toBe('Hi');
    expect(ctx.outbox.pending(ENVELOPE, null)).toEqual([]);
    const again = ctx.outbox.send(ENVELOPE, null, 'Hi');
    expect(again.key).not.toBe(pending.key);
  });

  it('a 401 ends the chat session without a retry; a context switch forgets everything', async () => {
    ctx.failures.push(new ApiError(401, 'invalid_token', 'gone'));
    const pending = ctx.outbox.send(ENVELOPE, null, 'Hi');
    await settle();
    expect(ctx.syncEvents.unauthorized).toHaveBeenCalled();
    // The sync was reset: the answer of a write of the old generation is dropped.
    expect(pending.state).toBe('sending');
    ctx.outbox.clear();
    expect(ctx.outbox.pending(ENVELOPE, null)).toEqual([]);
  });

  it('replies in a thread: the root is replaced where it is loaded, the reply settles after the thread refresh', async () => {
    await ctx.sync.openThread(ENVELOPE, UUID(2));
    const pending = ctx.outbox.send(ENVELOPE, UUID(2), 'Thread reply');
    await settle();
    await settle();
    expect(ctx.calls.at(-1)).toMatchObject({ kind: 'reply', text: 'Thread reply' });
    expect(ctx.sync.store.findMessage(ENVELOPE, UUID(2))?.thread?.count).toBe(2);
    expect(ctx.sync.store.has(ENVELOPE, pending.sent?.uuid ?? '', UUID(2))).toBe(true);
    expect(ctx.outbox.pending(ENVELOPE, UUID(2))).toEqual([]);
  });

  it('a client-side pause waits instead of sending', async () => {
    ctx.failures.push(new ApiError(429, 'rate_limited', 'slow', 30));
    await ctx.outbox.react(ENVELOPE, UUID(1), '👍');
    expect(ctx.events.reactionFailed).toHaveBeenCalled();
    const pending = ctx.outbox.send(ENVELOPE, null, 'Later');
    await settle();
    // Paused by the sync: no request went out, the write waits for the end of the pause.
    expect(ctx.calls.filter((call) => call.kind === 'send')).toHaveLength(0);
    expect(pending.state).toBe('waiting');
    ctx.clock.advance(30_000);
    await settle();
    await settle();
    expect(ctx.calls.filter((call) => call.kind === 'send')).toHaveLength(1);
  });

  it('reacts at once, keeps the server answer, puts it back on a refusal, ignores double clicks', async () => {
    const first = ctx.outbox.react(ENVELOPE, UUID(1), '👍');
    expect(ctx.sync.store.findMessage(ENVELOPE, UUID(1))?.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    await ctx.outbox.react(ENVELOPE, UUID(1), '👍');
    await first;
    expect(ctx.calls.filter((call) => call.kind === 'react')).toHaveLength(1);
    expect(ctx.sync.store.findMessage(ENVELOPE, UUID(1))?.reactions).toEqual([{ emoji: '👍', count: 5, mine: true }]);
    ctx.failures.push(new ApiError(422, 'not_reactable', 'no'));
    await ctx.outbox.react(ENVELOPE, UUID(1), '👍');
    expect(ctx.calls.at(-1)).toMatchObject({ on: false });
    expect(ctx.sync.store.findMessage(ENVELOPE, UUID(1))?.reactions).toEqual([{ emoji: '👍', count: 5, mine: true }]);
    expect(ctx.events.reactionFailed).toHaveBeenCalled();
    // Unknown messages are ignored.
    await ctx.outbox.react(ENVELOPE, UUID(77), '👍');
    expect(ctx.calls.filter((call) => call.kind === 'react')).toHaveLength(2);
    // Each reaction write has its own key.
    const keys = ctx.calls.filter((call) => call.kind === 'react').map((call) => call.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('reactions on a thread reply change the thread only, never the timeline', async () => {
    await ctx.sync.openThread(ENVELOPE, UUID(2));
    await ctx.outbox.react(ENVELOPE, UUID(50), '👍');
    expect(ctx.sync.store.thread(UUID(2))?.replies[0].reactions).toEqual([{ emoji: '👍', count: 5, mine: true }]);
    expect(ctx.sync.store.timeline(ENVELOPE)?.messages.some((message) => message.uuid === UUID(50))).toBe(false);
  });
});

// ---- the composer --------------------------------------------------------------------------------------------------

function composer(extra: Partial<ConstructorParameters<typeof Composer>[0]> = {}) {
  const sent: string[] = [];
  const drafts: string[] = [];
  const box = new Composer({ t, id: 'c1', placeholder: 'Message #envelope-v2', maxLength: 20, draft: '', onSend: (text) => (sent.push(text), true), onDraft: (text) => drafts.push(text), ...extra });
  document.body.replaceChildren(box.root);
  const type = (value: string) => {
    box.field.value = value;
    box.field.dispatchEvent(new Event('input'));
  };
  const key = (init: KeyboardEventInit, target: HTMLElement = box.field) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  return { box, sent, drafts, type, key };
}

describe('composer', () => {
  it('is a labelled form: Enter sends and clears, Shift+Enter does not, an IME keeps Enter', () => {
    const ui = composer();
    expect(ui.box.root.querySelector('label')?.getAttribute('for')).toBe('c1');
    expect(ui.box.field.getAttribute('aria-describedby')).toBe('c1-hint c1-count');
    const send = ui.box.root.querySelector<HTMLButtonElement>('.send') as HTMLButtonElement;
    expect(send.type).toBe('submit');
    expect(send.disabled).toBe(true);
    ui.type('  hi  ');
    expect(send.disabled).toBe(false);
    expect(ui.key({ key: 'Enter', shiftKey: true }).defaultPrevented).toBe(false);
    expect(ui.key({ key: 'Enter', isComposing: true }).defaultPrevented).toBe(false);
    expect(ui.key({ key: 'Enter', keyCode: 229 }).defaultPrevented).toBe(false);
    // ZDG-I5: Ctrl/Cmd+Enter waits for the IME too.
    expect(ui.key({ key: 'Enter', ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(ui.sent).toEqual([]);
    expect(ui.key({ key: 'Enter' }).defaultPrevented).toBe(true);
    expect(ui.sent).toEqual(['hi']);
    expect(ui.box.field.value).toBe('');
    expect(ui.drafts.at(-1)).toBe('');
    ui.type('again');
    ui.key({ key: 'Enter', ctrlKey: true });
    expect(ui.sent).toEqual(['hi', 'again']);
    ui.box.root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(ui.sent).toHaveLength(2);
  });

  it('counts near the limit, refuses over it and keeps a refused text', () => {
    const ui = composer({ onSend: () => false });
    ui.type('x'.repeat(5));
    expect(ui.box.root.querySelector('.count')?.textContent).toBe('Characters left: 15');
    ui.type('x'.repeat(21));
    expect(ui.box.root.querySelector('.count')?.textContent).toBe('Characters over the limit: 1');
    expect(ui.box.field.getAttribute('aria-invalid')).toBe('true');
    expect(ui.box.root.querySelector<HTMLButtonElement>('.send')?.disabled).toBe(true);
    ui.key({ key: 'Enter' });
    ui.type('ok');
    ui.box.submit();
    expect(ui.box.field.value).toBe('ok');
    ui.box.setText('back');
    expect(ui.box.field.value).toBe('back');
  });

  it('formats with the toolbar and the shortcuts; the toolbar is one tab stop', () => {
    const ui = composer({ maxLength: 4000 });
    ui.type('make it bold');
    ui.box.field.setSelectionRange(8, 12);
    ui.key({ key: 'b', ctrlKey: true });
    expect(ui.box.field.value).toBe('make it **bold**');
    ui.type('');
    ui.key({ key: 'i', metaKey: true });
    expect(ui.box.field.value).toBe('_text_');
    ui.type('');
    ui.key({ key: 'e', ctrlKey: true });
    expect(ui.box.field.value).toBe('`code`');
    ui.type('');
    ui.key({ key: 'C', ctrlKey: true, shiftKey: true });
    expect(ui.box.field.value).toBe('```\ncode\n```');
    ui.key({ key: 'x', ctrlKey: true });
    const buttons = [...ui.box.root.querySelectorAll<HTMLButtonElement>('.fmt button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Bold', 'Italic', 'Inline code', 'Code block', 'Bulleted list', 'Link']);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    buttons[0].focus();
    ui.key({ key: 'ArrowLeft' }, buttons[0]);
    expect(document.activeElement).toBe(buttons[5]);
    ui.key({ key: 'ArrowRight' }, buttons[5]);
    expect(document.activeElement).toBe(buttons[0]);
    ui.key({ key: 'End' }, buttons[0]);
    ui.key({ key: 'Home' }, buttons[5]);
    ui.key({ key: 'x' }, buttons[0]);
    expect(document.activeElement).toBe(buttons[0]);
    ui.type('');
    buttons[5].click();
    expect(ui.box.field.value).toBe('[text](https://)');
    ui.type('item');
    ui.box.field.setSelectionRange(4, 4);
    buttons[4].click();
    expect(ui.box.field.value).toBe('item\n- ');
  });

  it('↑ in an empty field and Esc go to the caller', () => {
    const up = vi.fn();
    const escape = vi.fn(() => true);
    const ui = composer({ onArrowUp: up, onEscape: escape });
    ui.key({ key: 'ArrowUp' });
    expect(up).toHaveBeenCalledOnce();
    ui.type('text');
    ui.key({ key: 'ArrowUp' });
    expect(up).toHaveBeenCalledOnce();
    expect(ui.key({ key: 'Escape' }).defaultPrevented).toBe(true);
    const plain = composer();
    expect(plain.key({ key: 'Escape' }).defaultPrevented).toBe(false);
  });

  it('wraps and lists from the helpers', () => {
    const field = document.createElement('textarea');
    field.value = 'a';
    field.setSelectionRange(0, 0);
    insertListItem(field);
    expect(field.value).toBe('- a');
    field.value = 'abc';
    field.setSelectionRange(1, 2);
    wrapSelection(field, '**', '**', 'x');
    expect(field.value).toBe('a**b**c');
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 4]);
  });
});

describe('outbox: undo of a discard (UX batch 4, UXA-8)', () => {
  let ctx: ReturnType<typeof outboxFor>;
  beforeEach(async () => {
    ctx = outboxFor();
    await ctx.sync.start();
    await ctx.sync.open(ENVELOPE);
  });

  it('a cancelled queued message comes back where it stood, with its key, and goes out once in order', async () => {
    ctx.outbox.setOnline(false);
    const first = ctx.outbox.send(ENVELOPE, null, 'One');
    const second = ctx.outbox.send(ENVELOPE, null, 'Two');
    const point = ctx.outbox.undoPoint(first);
    expect(ctx.outbox.discard(first.key)).toBe(first);
    expect(ctx.outbox.pending(ENVELOPE, null)).toEqual([second]);
    expect(ctx.outbox.restore(first, point)).toBe(true);
    expect(ctx.outbox.pending(ENVELOPE, null)).toEqual([first, second]);
    expect(first).toMatchObject({ state: 'queued', error: 'network_error' });
    // Restoring twice does nothing.
    expect(ctx.outbox.restore(first, point)).toBe(false);
    ctx.outbox.setOnline(true);
    for (let i = 0; i < 8; i += 1) await settle();
    expect(ctx.calls.map((call) => [call.text, call.key])).toEqual([
      ['One', first.key],
      ['Two', second.key],
    ]);
  });

  it('BDA14-L2: comes back before a newer message of its conversation even when an earlier item left meanwhile', async () => {
    ctx.outbox.setOnline(false);
    const other = ctx.outbox.send(INCIDENTS, null, 'Elsewhere');
    const first = ctx.outbox.send(ENVELOPE, null, 'One');
    const second = ctx.outbox.send(ENVELOPE, null, 'Two');
    const point = ctx.outbox.undoPoint(first);
    expect(ctx.outbox.discard(first.key)).toBe(first);
    // The item before it goes too: a position-based restore would now put it behind "Two".
    expect(ctx.outbox.discard(other.key)).toBe(other);
    expect(ctx.outbox.restore(first, point)).toBe(true);
    expect(ctx.outbox.pending(ENVELOPE, null)).toEqual([first, second]);
    expect(first.state).toBe('queued');
    ctx.outbox.setOnline(true);
    for (let i = 0; i < 8; i += 1) await settle();
    expect(ctx.calls.map((call) => [call.text, call.key])).toEqual([
      ['One', first.key],
      ['Two', second.key],
    ]);
  });

  it('never overtakes: a newer message sent meanwhile brings it back as not sent, with Retry', async () => {
    ctx.outbox.setOnline(false);
    const first = ctx.outbox.send(ENVELOPE, null, 'One');
    const second = ctx.outbox.send(ENVELOPE, null, 'Two');
    const point = ctx.outbox.undoPoint(first);
    ctx.outbox.discard(first.key);
    ctx.outbox.setOnline(true);
    for (let i = 0; i < 6; i += 1) await settle();
    expect(second.state).toBe('sent');
    expect(ctx.outbox.restore(first, point)).toBe(true);
    expect(first).toMatchObject({ state: 'failed', canRetry: true });
    await settle();
    expect(ctx.calls.map((call) => call.text)).toEqual(['Two']);
  });

  it('a failed message comes back failed (nothing sent); nothing comes back after a context switch', async () => {
    ctx.failures.push(new ApiError(422, 'text_too_long', 'too long'));
    const refused = ctx.outbox.send(ENVELOPE, null, 'Too long');
    await settle();
    await settle();
    expect(refused).toMatchObject({ state: 'failed', canRetry: false });
    const point = ctx.outbox.undoPoint(refused);
    ctx.outbox.discard(refused.key);
    expect(ctx.outbox.restore(refused, point)).toBe(true);
    expect(refused).toMatchObject({ state: 'failed', canRetry: false, error: 'text_too_long' });
    expect(ctx.calls).toHaveLength(1);
    const again = ctx.outbox.undoPoint(refused);
    ctx.outbox.discard(refused.key);
    ctx.outbox.clear();
    expect(ctx.outbox.restore(refused, again)).toBe(false);
    expect(ctx.outbox.pending(ENVELOPE, null)).toEqual([]);
  });
});
