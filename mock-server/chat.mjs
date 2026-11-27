/**
 * Mock of ChatKit's client API v1 (`/api/chat/v1`, ChatKitBundle 2.4.0 reads, 2.5.0 writes) for development and e2e:
 * `X-Beacon-Context` required, `tokens/1` bodies, reactions `{emoji, count, mine}`, threads, read marks, an opaque
 * cursor and `realtime` (disabled here: the app polls); writes (send, thread reply, reactions) need `chat:write`, an
 * `Idempotency-Key` (replays answer the first write with `replayed: true`), and are off with `chatWritesOff`.
 * Sample data only; every person and company is fictional.
 *
 * Control (through the main server's /__mock/*): `chat/post` adds a message (`{conversation, author, text}`),
 * `chat/react` changes a reaction; both bump an `events` counter the tests read.
 */
import { randomUUID } from 'node:crypto';
// The composer's Markdown subset rendered as ChatKit does (tokens/1, per reader): the app's own module, loaded by Node's
// type stripping, so the mock and the pending row agree.
import { markdownBlocks } from '../src/chat/markdown.ts';

export const CHAT_PREFIX = '/api/chat/v1';
export const CHAT_SCOPES = ['chat:read', 'chat:write'];
const QUICK = ['👍', '👀', '✅', '🎉', '🙏'];
const ACCEPTED = [...QUICK, '💚', '🚀', '❤️', '😂'];
const KEY = /^[A-Za-z0-9_.:-]{1,80}$/;

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ORG2 = 'org:7b1f2a9f-2c3d-4e4f-9a01-b2c3d4e5f6a7';
const CONTEXTS = [
  { key: 'personal', label: 'Personal' },
  { key: ORG, label: 'Lumen Works' },
  { key: ORG2, label: 'Harbor Studio' },
];

const PEOPLE = {
  me: { uuid: '0f000000-0000-4000-8000-000000000001', name: 'Ada Lovelace', initials: 'AL' },
  maya: { uuid: '0f000000-0000-4000-8000-000000000002', name: 'Maya Okafor', initials: 'MO' },
  leo: { uuid: '0f000000-0000-4000-8000-000000000003', name: 'Leo Brandt', initials: 'LB' },
  sofia: { uuid: '0f000000-0000-4000-8000-000000000004', name: 'Sofía Marín', initials: 'SM' },
  tomas: { uuid: '0f000000-0000-4000-8000-000000000005', name: 'Tomás Vidal', initials: 'TV' },
  bot: { uuid: null, name: 'Beacon', initials: 'B', bot: true },
};

const uuid = (n) => `0c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const para = (...tokens) => ({ type: 'paragraph', tokens });
const body = (...blocks) => ({ format: 'tokens/1', blocks });
const mention = (who) => ({ type: 'mention', userUuid: PEOPLE[who].uuid, name: PEOPLE[who].name.split(' ')[0] });
const ref = (refType, id, title, badge = '', tone = 'neutral') => ({ type: 'reference', visible: true, refType, id, typeLabel: refType, icon: refType, title, subtitle: '', badge, tone, url: `/dashboard/${refType}/${id}` });
const hidden = () => ({ type: 'reference', visible: false, text: 'Content not visible' });

function seed() {
  // Fixed "now" relative stamps so screenshots are stable: today 10:00 local minus offsets.
  const base = new Date();
  base.setHours(10, 0, 0, 0);
  const at = (minutesAgo) => new Date(base.getTime() - minutesAgo * 60_000).toISOString();
  const conversations = [
    { uuid: uuid(1), context: ORG, kind: 'channel', title: 'envelope-v2', subtitle: 'Parser rewrite and benchmarks', channelKey: 'room:1', unread: 3 },
    { uuid: uuid(2), context: ORG, kind: 'channel', title: 'incidents', subtitle: 'Production incidents', channelKey: 'room:2', unread: 0, readOnly: true },
    { uuid: uuid(3), context: ORG, kind: 'channel', title: 'random', subtitle: 'Anything goes', channelKey: 'room:3', unread: 2, mutedUntil: '2099-01-01T00:00:00Z' },
    { uuid: uuid(4), context: ORG, kind: 'channel', title: 'Envelope v2', subtitle: 'Project channel', channelKey: 'project:aa000000-0000-4000-8000-000000000001', unread: 1 },
    { uuid: uuid(5), context: ORG, kind: 'channel', title: 'Website relaunch', subtitle: 'Project channel', channelKey: 'project:aa000000-0000-4000-8000-000000000002', unread: 0 },
    { uuid: uuid(6), context: ORG, kind: 'direct', title: 'Maya Okafor', subtitle: 'Product lead', peer: PEOPLE.maya, peerStatus: 'online', unread: 2 },
    { uuid: uuid(7), context: ORG, kind: 'direct', title: 'Leo Brandt', subtitle: 'Backend engineer', peer: PEOPLE.leo, peerStatus: 'away', unread: 0 },
    { uuid: uuid(8), context: ORG, kind: 'support', title: 'Orbita Ltd · invoice export', subtitle: 'Support', unread: 0, ticket: { statusLabel: 'Open' } },
    { uuid: uuid(9), context: ORG2, kind: 'channel', title: 'studio', subtitle: 'Harbor Studio team', channelKey: 'room:9', unread: 4 },
    { uuid: uuid(10), context: 'personal', kind: 'direct', title: 'Notes to self', subtitle: '', unread: 0 },
  ];
  let id = 1000;
  const messages = new Map(conversations.map((row) => [row.uuid, []]));
  const add = (conv, who, minutesAgo, bodyValue, extra = {}) => {
    id += 1;
    const message = {
      id,
      uuid: randomUUID(),
      kind: who === 'bot' ? 'system' : 'user',
      author: PEOPLE[who],
      mine: who === 'me',
      createdAt: at(minutesAgo),
      edited: false,
      deleted: false,
      moderated: false,
      pinned: false,
      mentionsMe: false,
      reactions: [],
      body: bodyValue,
      previews: [],
      ...extra,
    };
    messages.get(uuid(conv)).push(message);
    return message;
  };
  // envelope-v2: yesterday + today, grouping, code, a thread, reactions, references, a hidden reference, a mention.
  for (let i = 0; i < 40; i += 1) add(1, i % 3 === 0 ? 'leo' : 'sofia', 3000 - i * 20, body(para(text(`Earlier benchmark note ${i + 1}: throughput looked stable on the staging runner.`))));
  add(1, 'maya', 1500, body(para(text('Yesterday we agreed to ship the streaming parser behind a flag.'))));
  const root = add(1, 'leo', 95, body(para(text('The parser benchmark dipped after the last deploy. '), ref('task', 'EV-145', 'Streaming parser for envelopes', 'In progress', 'info'), text(' is the suspect.'))), { reactions: [{ emoji: '👀', count: 3, mine: true }, { emoji: '👍', count: 1, mine: false }] });
  add(1, 'leo', 93, body(para(text('Numbers from the runner:')), { type: 'code', text: 'envelope/parse   1.84 ms  (+22%)\nenvelope/stream  0.91 ms  (+3%)' }));
  add(1, 'sofia', 60, body(para(text('Could be the UTF-8 path. The related incident is '), hidden(), text('.'))));
  add(1, 'maya', 12, body(para(mention('me'), text(' can you look at the 4-byte case before the release? Details in '), { type: 'link', url: 'https://example.com/benchmarks/envelope-v2?run=482', text: 'the benchmark run', card: false }, text('.'))), { mentionsMe: true });
  add(1, 'maya', 11, body(para(text('Also '), text('please', ['bold']), text(' keep the old path for one release.'))), { reactions: [{ emoji: '✅', count: 2, mine: false }] });
  add(1, 'tomas', 4, body({ type: 'list', ordered: false, items: [[text('Rollback plan ready')], [text('Alert thresholds lowered for the day')]] }));
  root.thread = { count: 3, lastReplyAt: at(20) };
  const threadReplies = [
    { id: 5001, uuid: randomUUID(), kind: 'user', author: PEOPLE.sofia, mine: false, createdAt: at(80), edited: false, deleted: false, moderated: false, pinned: false, mentionsMe: false, reactions: [], body: body(para(text('I can reproduce it with the 4-byte emoji fixtures.'))), previews: [], threadRootUuid: root.uuid },
    { id: 5002, uuid: randomUUID(), kind: 'user', author: PEOPLE.me, mine: true, createdAt: at(70), edited: true, deleted: false, moderated: false, pinned: false, mentionsMe: false, reactions: [{ emoji: '🙏', count: 1, mine: false }], body: body(para(text('Taking it. Will report back before lunch.'))), previews: [], threadRootUuid: root.uuid },
    { id: 5003, uuid: randomUUID(), kind: 'user', author: PEOPLE.leo, mine: false, createdAt: at(20), edited: false, deleted: false, moderated: false, pinned: false, mentionsMe: false, reactions: [], body: body(para(text('Thanks! Linking the board: '), ref('task', 'EV-150', 'Benchmark guardrails'))), previews: [], threadRootUuid: root.uuid },
  ];
  add(2, 'bot', 300, body(para(text('Monitor api.example recovered after 4 minutes.'))));
  add(3, 'tomas', 40, body(para(text('Coffee machine is fixed ☕'))));
  add(3, 'sofia', 30, body(para(text('Finally.'))));
  add(4, 'maya', 25, body(para(text('Kick-off notes are in the wiki: '), ref('wiki', 'w-12', 'Envelope v2 kick-off'))));
  add(5, 'sofia', 600, body(para(text('New hero images are up for review.'))));
  add(6, 'maya', 50, body(para(text('Pairing at 11:30?'))));
  add(6, 'maya', 49, body(para(text('I booked the small room.'))));
  add(7, 'leo', 2000, body(para(text('Thanks for the review!'))));
  add(7, 'me', 1990, body(para(text('Any time.'))));
  add(8, 'bot', 200, body(para(text('Support thread opened by Orbita Ltd.'))));
  add(9, 'tomas', 30, body(para(text('Harbor standup moved to 9:30.'))));
  add(10, 'me', 4000, body(para(text('Remember the dentist on Friday.'))));
  const reads = new Map(conversations.map((row) => {
    const list = messages.get(row.uuid);
    return [row.uuid, list.length === 0 ? null : list[Math.max(0, list.length - 1 - row.unread)].id];
  }));
  return { conversations, messages, threads: new Map([[root.uuid, threadReplies]]), reads, nextId: Math.max(id, 5003), events: 0, reads_posted: [], logouts: 0, keys: new Map(), writes: [] };
}

export function createChatMock({ send, error }) {
  let data = seed();

  const tokenOf = (req, state) => {
    const header = req.headers.authorization ?? '';
    const session = header.startsWith('Bearer ') ? state.tokens.get(header.slice(7).trim()) : undefined;
    return session && session.expiresAt >= Date.now() ? session : null;
  };

  const row = (conversation) => {
    const list = data.messages.get(conversation.uuid);
    const last = list[list.length - 1];
    const read = data.reads.get(conversation.uuid) ?? 0;
    return {
      uuid: conversation.uuid,
      kind: conversation.kind,
      title: conversation.title,
      subtitle: conversation.subtitle,
      // ChatKit sends the peer's own initials and public id for a direct message (ChatPresenter).
      initials: conversation.peer?.initials ?? conversation.title.slice(0, 2).toUpperCase(),
      avatarUrl: null,
      peerUuid: conversation.peer?.uuid ?? null,
      peerStatus: conversation.peerStatus ?? 'offline',
      channelKey: conversation.channelKey ?? null,
      ticket: conversation.ticket ? { number: '1042', topicLabel: 'Billing', status: 'open', statusLabel: conversation.ticket.statusLabel, readOnly: false } : null,
      canSend: conversation.readOnly !== true,
      unread: list.filter((message) => message.id > read && !message.mine).length,
      archived: false,
      mutedUntil: conversation.mutedUntil ?? null,
      lastMessageAt: last?.createdAt ?? new Date(0).toISOString(),
      lastMessageId: last?.id ?? null,
      lastMessage: last ? { preview: 'Preview', buzz: false, pin: false, deleted: false, moderated: false, mine: last.mine, authorName: last.author.name } : null,
    };
  };

  /** ChatKit 2.5 writes: scope, writes switch, posting rights, key, then the write (or the replay of the first one). */
  function write(req, res, session, conversation, list, match, payload, headers, state) {
    const bearer = (req.headers.authorization ?? '').slice(7).trim();
    if (state.config.chatWritesOff) return error(res, 404, 'not_found', 'Not found.');
    if (!session.scopes.includes('chat:write')) return error(res, 403, 'insufficient_scope', 'Needs chat:read chat:write.', { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="chat:read chat:write"' });
    const key = req.headers['idempotency-key'];
    if (key === undefined || key === '') return error(res, 400, 'idempotency_key_required', 'Idempotency-Key required.');
    if (!KEY.test(key)) return error(res, 400, 'idempotency_key_invalid', 'Invalid Idempotency-Key.');
    if (conversation.readOnly) return error(res, 403, 'read_only', 'Read-only conversation.');
    const reaction = match[4]?.startsWith('/reactions/') ? match[4].slice('/reactions/'.length) : null;
    const fingerprint = JSON.stringify([req.method, match[3] ?? null, match[4] ?? null, payload]);
    const stored = data.keys.get(`${bearer}|${conversation.uuid}|${key}`);
    if (stored !== undefined) {
      if (stored.fingerprint !== fingerprint) return error(res, 422, 'idempotency_mismatch', 'Key used for another write.');
      data.writes.push({ key, replayed: true });
      return send(res, stored.status === 201 ? 200 : stored.status, { ...stored.body, replayed: true }, headers);
    }
    const remember = (status, answer) => {
      data.keys.set(`${bearer}|${conversation.uuid}|${key}`, { fingerprint, status, body: answer });
      data.writes.push({ key, replayed: false, method: req.method, kind: reaction !== null ? 'reaction' : match[4] === '/thread' ? 'reply' : 'send' });
      data.events += 1;
      return send(res, status, { ...answer, replayed: false }, headers);
    };
    if (reaction !== null) {
      if (req.method !== 'PUT' && req.method !== 'DELETE') return error(res, 405, 'method_not_allowed', 'Method not allowed.');
      let emoji;
      try {
        emoji = decodeURIComponent(reaction);
      } catch {
        return error(res, 422, 'invalid_reaction', 'Invalid reaction.');
      }
      if (!ACCEPTED.includes(emoji)) return error(res, 422, 'invalid_reaction', 'Invalid reaction.');
      const target = list.find((item) => item.uuid === match[3]) ?? [...data.threads.values()].flat().find((item) => item.uuid === match[3]);
      if (!target) return error(res, 404, 'not_found', 'Not found.');
      const current = target.reactions.find((item) => item.emoji === emoji);
      if (req.method === 'PUT' && !current?.mine) {
        if (current) Object.assign(current, { count: current.count + 1, mine: true });
        else target.reactions.push({ emoji, count: 1, mine: true });
      } else if (req.method === 'DELETE' && current?.mine) {
        if (current.count <= 1) target.reactions.splice(target.reactions.indexOf(current), 1);
        else Object.assign(current, { count: current.count - 1, mine: false });
      }
      return remember(200, { reactions: target.reactions.map((item) => ({ ...item })) });
    }
    if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'Method not allowed.');
    if (Object.keys(payload).some((field) => field !== 'text')) return error(res, 422, 'unsupported_field', 'Unsupported field.');
    if (typeof payload.text !== 'string') return error(res, 422, 'invalid_text', 'Invalid text.');
    const value = payload.text.trim();
    if (value === '') return error(res, 422, 'empty_text', 'Empty text.');
    if ([...value].length > 4000) return error(res, 422, 'text_too_long', 'Too long.');
    data.nextId += 1;
    const message = { id: data.nextId, uuid: randomUUID(), kind: 'user', author: PEOPLE.me, mine: true, createdAt: new Date().toISOString(), edited: false, deleted: false, moderated: false, pinned: false, mentionsMe: false, reactions: [], body: body(...markdownBlocks(value)), previews: [] };
    if (match[4] === '/thread') {
      const root = list.find((item) => item.uuid === match[3]);
      if (!root) return error(res, 404, 'not_found', 'Not found.');
      if (root.kind !== 'user') return error(res, 422, 'not_threadable', 'Not threadable.');
      const replies = data.threads.get(root.uuid) ?? [];
      data.threads.set(root.uuid, replies);
      replies.push({ ...message, threadRootUuid: root.uuid });
      return remember(201, { message: { ...message, threadRootUuid: root.uuid }, root: { ...root, thread: { count: replies.length, lastReplyAt: message.createdAt } } });
    }
    if (match[3] !== undefined) return error(res, 405, 'method_not_allowed', 'Method not allowed.');
    list.push(message);
    data.reads.set(conversation.uuid, message.id);
    return remember(201, { message });
  }

  return {
    reset() {
      data = seed();
    },
    state: () => ({ events: data.events, reads: data.reads_posted, logouts: data.logouts, writes: data.writes }),
    post({ conversation, author = 'maya', text: value = 'New message', thread = false }) {
      const conv = data.conversations.find((item) => item.uuid === conversation) ?? data.conversations[0];
      data.nextId += 1;
      const message = { id: data.nextId, uuid: randomUUID(), kind: 'user', author: PEOPLE[author], mine: author === 'me', createdAt: new Date().toISOString(), edited: false, deleted: false, moderated: false, pinned: false, mentionsMe: false, reactions: [], body: body(para(text(value))), previews: [] };
      if (thread) {
        const root = [...data.threads.keys()][0];
        data.threads.get(root).push({ ...message, threadRootUuid: root });
      } else data.messages.get(conv.uuid).push(message);
      data.events += 1;
      return message;
    },
    handle(req, res, url, body, state) {
      // ChatKit 2.4.1: revokes the presented token, with or without a context or a valid token; idempotent, always
      // 204 (audit ZBZ-L4). `chatLogoutMissing` mimics a 2.4.0 server (404).
      if (req.method === 'POST' && url.pathname === `${CHAT_PREFIX}/logout`) {
        if (state.config.chatLogoutMissing) return error(res, 404, 'not_found', 'Not found.');
        const presented = (req.headers.authorization ?? '').slice(7).trim();
        if (state.tokens.get(presented)?.family === 'chat') state.tokens.delete(presented);
        data.logouts += 1;
        res.writeHead(204).end();
        return;
      }
      const session = tokenOf(req, state);
      if (session === null) return error(res, 401, 'invalid_token', 'Missing or revoked token.', { 'WWW-Authenticate': 'Bearer' });
      if (session.family !== 'chat') return error(res, 403, 'insufficient_scope', 'A chat token is required.', { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' });
      // `writesOnly` fails only writes (reads keep working); `times` fails that many requests (default 1).
      if (state.config.chatFailNext && !(state.config.chatFailNext.writesOnly && req.method === 'GET')) {
        const { status, error: code, retryAfter, times = 1 } = state.config.chatFailNext;
        state.config.chatFailNext = times > 1 ? { ...state.config.chatFailNext, times: times - 1 } : null;
        return error(res, status, code, code, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
      }
      const context = req.headers['x-beacon-context'];
      if (context === undefined) return error(res, 400, 'context_required', 'Context required.');
      if (!CONTEXTS.some((item) => item.key === context)) return error(res, 403, 'context_forbidden', 'Context forbidden.');
      const route = url.pathname.slice(CHAT_PREFIX.length + 1);
      const headers = { 'Cache-Control': 'no-store, private' };
      const inContext = (uuidValue) => data.conversations.find((item) => item.uuid === uuidValue && item.context === context);
      if (req.method === 'GET' && route === 'me') {
        const writes = !state.config.chatWritesOff;
        return send(
          res,
          200,
          {
            apiVersion: 1,
            user: PEOPLE.me,
            scopes: session.scopes,
            context,
            contexts: CONTEXTS,
            features: { realtime: false, realtimeEvents: 'ids', send: writes, threadReply: writes, reactions: writes, editOwn: writes, deleteOwn: writes, cards: false, search: false, attachments: false, serverLogout: true },
            limits: { conversationsPageMax: 100, messagesPageMax: 100, textMaxLength: 4000, editWindowSeconds: 900, idempotencyKeyMaxLength: 80 },
            reactions: { quick: QUICK, accepted: ACCEPTED },
          },
          headers,
        );
      }
      if (req.method === 'GET' && route === 'realtime') return send(res, 200, { enabled: false, hubUrl: null, token: null, topic: null, expiresAt: null, events: 'ids' }, headers);
      if (req.method === 'GET' && route === 'conversations') {
        const rows = data.conversations.filter((item) => item.context === context).map(row).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 100);
        const offset = Number(url.searchParams.get('cursor') ? Buffer.from(url.searchParams.get('cursor'), 'base64url').toString() : 0) || 0;
        const page = rows.slice(offset, offset + limit);
        const next = offset + limit < rows.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
        const unreadTotal = rows.filter((item) => item.mutedUntil === null).reduce((sum, item) => sum + item.unread, 0);
        return send(res, 200, { conversations: page, nextCursor: next, unreadTotal: offset === 0 ? unreadTotal : null, unreadTotalCapped: offset === 0 ? false : null }, headers);
      }
      const match = /^conversations\/([0-9a-f-]{36})(?:\/(messages|read)(?:\/([0-9a-f-]{36})(\/thread|\/reactions\/[^/]+)?)?)?$/.exec(route);
      if (!match) return error(res, 404, 'not_found', 'Not found.');
      const conversation = inContext(match[1]);
      if (!conversation) return error(res, 404, 'not_found', 'Not found.');
      const list = data.messages.get(conversation.uuid);
      if (req.method !== 'GET' && match[2] === 'messages') return write(req, res, session, conversation, list, match, body, headers, state);
      if (req.method === 'GET' && match[2] === undefined) return send(res, 200, { conversation: { ...row(conversation), membersCount: 6, permissions: { send: true } } }, headers);
      if (req.method === 'POST' && match[2] === 'read') {
        const id = Number(body.messageId);
        if (!Number.isInteger(id) || id < 1) return error(res, 422, 'invalid_message_id', 'Invalid id.');
        const newest = list[list.length - 1]?.id ?? 0;
        const next = Math.max(data.reads.get(conversation.uuid) ?? 0, Math.min(id, newest));
        data.reads.set(conversation.uuid, next);
        data.reads_posted.push({ conversation: conversation.uuid, messageId: id, context });
        return send(res, 200, { ok: true, readUpTo: next }, headers);
      }
      if (req.method === 'GET' && match[2] === 'messages' && match[3] === undefined) {
        const before = url.searchParams.get('before');
        const after = url.searchParams.get('after');
        if (before !== null && after !== null) return error(res, 400, 'invalid_cursor', 'Invalid cursor.');
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30), 1), 100);
        let page;
        let hasMore;
        if (after !== null) {
          const newer = list.filter((message) => message.id > Number(after));
          page = newer.slice(0, limit);
          hasMore = newer.length > limit;
        } else {
          const older = before !== null ? list.filter((message) => message.id < Number(before)) : list;
          page = older.slice(Math.max(0, older.length - limit));
          hasMore = older.length > limit;
        }
        const threads = data.threads;
        const withThread = page.map((message) => (threads.has(message.uuid) ? { ...message, thread: { count: threads.get(message.uuid).length, lastReplyAt: threads.get(message.uuid).at(-1).createdAt } } : message));
        return send(res, 200, { messages: withThread, hasMore, readUpTo: data.reads.get(conversation.uuid) ?? null }, headers);
      }
      const message = list.find((item) => item.uuid === match[3]);
      if (!message) return error(res, 404, 'not_found', 'Not found.');
      if (req.method === 'GET' && match[4] === undefined) return send(res, 200, { message }, headers);
      if (req.method === 'GET' && match[4] === '/thread') {
        const replies = data.threads.get(message.uuid) ?? [];
        return send(res, 200, { root: { ...message, thread: { count: replies.length, lastReplyAt: replies.at(-1)?.createdAt ?? null } }, replies, hasMore: false, replyCount: replies.length, readUpTo: null, following: true }, headers);
      }
      return error(res, 404, 'not_found', 'Not found.');
    },
  };
}
