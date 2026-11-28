// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { hostOf, plainText, renderBlocks, renderToken } from '../../src/chat/body';
import { dayLabel, fuzzyScore, History, rankConversations, rows, step } from '../../src/chat/format';
import { chatText } from '../../src/chat/i18n';
import { chatIcon } from '../../src/chat/icons';
import { ChatStore, isMuted, MAX_CACHED, MAX_MESSAGES, mergeMessages, sectionOf } from '../../src/chat/store';
import {
  type Conversation,
  type Message,
  parseBlocks,
  parseConversation,
  parseConversationsPage,
  parseHint,
  parseMe,
  parseMessage,
  parseMessagesPage,
  parseThreadPage,
  parseToken,
  safeUrl,
} from '../../src/chat/types';

const t = chatText('en');
const ORIGIN = 'https://beacon.example';
const uuid = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function message(id: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    uuid: uuid(id),
    kind: 'user',
    author: { uuid: uuid(900), name: 'Ana Ruiz', initials: 'AR', bot: false },
    mine: false,
    createdAt: new Date(Date.UTC(2026, 10, 25, 10, id)).toISOString(),
    edited: false,
    deleted: false,
    mentionsMe: false,
    threadRootUuid: null,
    thread: null,
    reactions: [],
    blocks: [],
    ...extra,
  };
}

function conversation(n: number, extra: Partial<Conversation> = {}): Conversation {
  return {
    uuid: uuid(n),
    kind: 'channel',
    title: `room-${n}`,
    subtitle: '',
    initials: 'RO',
    channelKey: `room:${n}`,
    peerStatus: null,
    unread: 0,
    archived: false,
    mutedUntil: null,
    lastMessageAt: '',
    lastMessageId: null,
    preview: null,
    lastMine: false,
    ticketStatus: null,
    canSend: true,
    ...extra,
  };
}

describe('chat API parsers', () => {
  it('keeps only http(s) and mailto links, resolves relative ones against the API origin', () => {
    expect(safeUrl('https://example.com/a', ORIGIN)).toBe('https://example.com/a');
    expect(safeUrl('mailto:ana@example.com', ORIGIN)).toBe('mailto:ana@example.com');
    // ZBZ-L3: to / cc / bcc / subject / body only.
    expect(safeUrl('mailto:x@example.com?subject=Hi&attach=~/.ssh/id_rsa&ATTACHMENT=/etc/passwd&Body=b', ORIGIN)).toBe('mailto:x@example.com?subject=Hi&Body=b');
    expect(safeUrl('mailto:x@example.com?attach=a', ORIGIN)).toBe('mailto:x@example.com');
    // ZBZ-v-I2: spaces are `%20` (RFC 6068), a literal plus stays `%2B`.
    expect(safeUrl('mailto:x@example.com?subject=Hello%20world&body=a%2Bb', ORIGIN)).toBe('mailto:x@example.com?subject=Hello%20world&body=a%2Bb');
    // ZCD-I1: a raw `+` stays a plus; an encoded name is still filtered.
    expect(safeUrl('mailto:x@example.com?subject=C++&%61ttach=x&body=hi there', ORIGIN)).toBe('mailto:x@example.com?subject=C++&body=hi%20there');
    expect(safeUrl('/dashboard/task/1', ORIGIN)).toBe('https://beacon.example/dashboard/task/1');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://u:p@example.com', '', '   ', 42, null, 'http://[bad']) expect(safeUrl(bad, ORIGIN)).toBeNull();
  });

  it('parses every token type and refuses unknown ones', () => {
    expect(parseToken({ type: 'text', text: 'hi', marks: ['bold', 'evil'] }, ORIGIN)).toEqual({ type: 'text', text: 'hi', marks: ['bold'] });
    expect(parseToken({ type: 'break' }, ORIGIN)).toEqual({ type: 'break' });
    expect(parseToken({ type: 'code', text: 'x' }, ORIGIN)).toEqual({ type: 'code', text: 'x' });
    expect(parseToken({ type: 'mention', userUuid: 'nope', name: 'Ana' }, ORIGIN)).toEqual({ type: 'mention', userUuid: null, name: 'Ana' });
    expect(parseToken({ type: 'link', url: 'javascript:x', text: 'click' }, ORIGIN)).toEqual({ type: 'link', url: null, text: 'click', card: false });
    expect(parseToken({ type: 'link', url: 'https://e.example' }, ORIGIN)).toMatchObject({ text: 'https://e.example/' });
    expect(parseToken({ type: 'reference', visible: false, text: 'Content not visible', title: 'secret' }, ORIGIN)).toEqual({ type: 'reference', visible: false, text: 'Content not visible' });
    expect(parseToken({ type: 'reference', visible: true, refType: 'task', id: 'EV-1', title: 'T', tone: 'evil', url: '/x' }, ORIGIN)).toMatchObject({ tone: 'neutral', url: 'https://beacon.example/x' });
    expect(parseToken({ type: 'html', html: '<b>' }, ORIGIN)).toBeNull();
    expect(parseToken('text', ORIGIN)).toBeNull();
  });

  it('parses blocks of tokens/1 only', () => {
    expect(parseBlocks({ format: 'html', blocks: [] }, ORIGIN)).toBeNull();
    const blocks = parseBlocks(
      {
        format: 'tokens/1',
        blocks: [
          { type: 'paragraph', tokens: [{ type: 'text', text: 'a' }] },
          { type: 'quote', tokens: [] },
          { type: 'list', ordered: true, items: [[{ type: 'text', text: 'i' }]] },
          { type: 'code', text: 'c' },
          { type: 'table' },
          'x',
        ],
      },
      ORIGIN,
    );
    expect(blocks?.map((block) => block.type)).toEqual(['paragraph', 'quote', 'list', 'code']);
  });

  it('parses me, conversations, messages and threads defensively', () => {
    const me = parseMe({ user: { uuid: uuid(1), name: 'Ada Lovelace' }, contexts: [{ key: 'personal', label: 'Personal' }, { key: 'bad key!', label: 'x' }, { key: 'org:1' }], context: 'personal', features: { realtime: true, realtimeEvents: 'ids' }, limits: { messagesPageMax: 500 } });
    expect(me.user.initials).toBe('AL');
    expect(me.contexts).toEqual([{ key: 'personal', label: 'Personal' }, { key: 'org:1', label: 'org:1' }]);
    expect(me.features.realtimeEvents).toBe('ids');
    expect(me.limits.messagesPageMax).toBe(100);
    expect(parseMe(null).user.name).toBe('?');
    expect(parseConversation({ uuid: 'x' })).toBeNull();
    const row = parseConversation({ uuid: uuid(2).toUpperCase(), kind: 'weird', title: '', unread: -3, lastMessage: { preview: 'hi', deleted: false }, ticket: { statusLabel: 'Open' } });
    expect(row).toMatchObject({ uuid: uuid(2), kind: 'channel', title: '…', unread: 0, preview: 'hi', ticketStatus: 'Open' });
    const page = parseConversationsPage({ conversations: [{ uuid: uuid(3), kind: 'direct', title: 'Maya' }, 'x'], nextCursor: 'abc', unreadTotal: 4, unreadTotalCapped: true });
    expect(page).toMatchObject({ nextCursor: 'abc', unreadTotal: 4, unreadTotalCapped: true });
    expect(page.conversations).toHaveLength(1);
    expect(parseConversationsPage({}).unreadTotal).toBeNull();
    const raw = { id: 5, uuid: uuid(5), author: { name: 'Bot', bot: true }, deleted: false, mentionAll: 'here', reactions: [{ emoji: '👍', count: 2, mine: true }, { emoji: '', count: 1 }, { emoji: 'x', count: 0 }], thread: { count: 2, lastReplyAt: 'now' }, threadRootUuid: uuid(4), body: { format: 'tokens/1', blocks: [] } };
    const parsed = parseMessage(raw, ORIGIN);
    expect(parsed).toMatchObject({ id: 5, mentionsMe: true, thread: { count: 2 }, threadRootUuid: uuid(4) });
    expect(parsed?.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    expect(parseMessage({ ...raw, deleted: true }, ORIGIN)?.blocks).toBeNull();
    expect(parseMessage({ ...raw, id: -1 }, ORIGIN)).toBeNull();
    expect(parseMessagesPage({ messages: [raw, {}], hasMore: true, readUpTo: 3 }, ORIGIN)).toMatchObject({ hasMore: true, readUpTo: 3 });
    expect(parseThreadPage({ root: raw, replies: [raw], hasMore: false }, ORIGIN)?.replyCount).toBe(1);
    expect(parseThreadPage({}, ORIGIN)).toBeNull();
  });

  it('accepts ids-only hints and nothing else', () => {
    expect(parseHint({ kind: 'message', conversationUuid: uuid(1).toUpperCase(), messageUuid: uuid(2), messageId: 9, rootUuid: uuid(3), deleted: false, body: 'x' })).toEqual({ kind: 'message', conversationUuid: uuid(1), messageUuid: uuid(2), messageId: 9, rootUuid: uuid(3), deleted: false });
    expect(parseHint({ kind: 'typing' })).toBeNull();
    expect(parseHint(null)).toBeNull();
    expect(parseHint({ kind: 'read', conversationUuid: '../x', messageId: 'x' })).toEqual({ kind: 'read' });
  });
});

describe('message bodies', () => {
  const open = vi.fn();
  const options = { t, me: uuid(1), open };

  it('renders every string as text and opens links through the host only', () => {
    const blocks = parseBlocks(
      {
        format: 'tokens/1',
        blocks: [
          { type: 'paragraph', tokens: [{ type: 'text', text: '<img src=x onerror=alert(1)>', marks: ['bold', 'italic', 'strike'] }, { type: 'break' }, { type: 'mention', userUuid: uuid(1), name: 'Ada' }, { type: 'mention', name: '@Leo' }, { type: 'link', url: 'https://example.com', text: 'site' }, { type: 'link', url: 'javascript:x', text: 'bad' }, { type: 'code', text: 'x' }] },
          { type: 'quote', tokens: [{ type: 'text', text: 'q' }] },
          { type: 'list', ordered: false, items: [[{ type: 'text', text: 'one' }]] },
          { type: 'list', ordered: true, items: [[{ type: 'text', text: 'two' }]] },
          { type: 'code', text: 'let a = 1;' },
        ],
      },
      ORIGIN,
    );
    const body = renderBlocks(blocks ?? [], options);
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('strong em s, s em strong, strong, em, s')).not.toBeNull();
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(body.querySelector('.mention.me')?.textContent).toBe('@Ada');
    expect([...body.querySelectorAll('.mention')].map((node) => node.textContent)).toEqual(['@Ada', '@Leo']);
    expect(body.querySelectorAll('a')).toHaveLength(1);
    const link = body.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    link.click();
    expect(open).toHaveBeenCalledWith('https://example.com/');
    expect(body.querySelector('blockquote')?.textContent).toBe('q');
    expect(body.querySelector('ul li')?.textContent).toBe('one');
    expect(body.querySelector('ol li')?.textContent).toBe('two');
    expect(body.querySelector('pre code')?.textContent).toBe('let a = 1;');
  });

  it('shows references for the reader: visible chips with a safe class, hidden ones neutral', () => {
    const visible = renderToken({ type: 'reference', visible: true, refType: 'task', id: 'EV-1', typeLabel: 'Task', title: 'Parser', subtitle: '', badge: 'Open', tone: 'info', url: 'https://beacon.example/t/1' }, options) as HTMLElement;
    expect(visible.className).toBe('ref ref-task');
    expect(visible.getAttribute('title')).toBe('Open Task EV-1 Parser in Beacon');
    expect(visible.querySelector('.r-s.tone-info')?.textContent).toBe('Open');
    const odd = renderToken({ type: 'reference', visible: true, refType: 'evil" onclick', id: '', typeLabel: 'X', title: '', subtitle: '', badge: '', tone: 'neutral', url: null }, options) as HTMLElement;
    expect(odd.className).toBe('ref ref-other');
    expect(odd.tagName).toBe('SPAN');
    expect(odd.textContent).toBe('X');
    const hidden = renderToken({ type: 'reference', visible: false, text: '' }, options) as HTMLElement;
    expect(hidden.className).toBe('ref ref-hidden');
    expect(hidden.textContent).toBe('Content not visible');
    expect(renderToken({ type: 'link', url: null, text: 'plain', card: false }, options)).toBeInstanceOf(HTMLSpanElement);
  });

  it('shows the real host when a link text names another site (ZBZ-I1)', () => {
    expect(hostOf('https://bank.example/login')).toBe('bank.example');
    expect(hostOf('www.Bank.example')).toBe('bank.example');
    expect(hostOf('the benchmark run')).toBeNull();
    expect(hostOf('mailto:x@example.com')).toBeNull();
    const fake = renderToken({ type: 'link', url: 'https://evil.example/x', text: 'https://bank.example', card: false }, options) as HTMLElement;
    expect(fake.className).toBe('m-link-wrap');
    expect(fake.querySelector('.m-host')?.textContent).toBe(' (evil.example)');
    const same = renderToken({ type: 'link', url: 'https://bank.example/x', text: 'bank.example', card: false }, options) as HTMLElement;
    expect(same.tagName).toBe('A');
  });

  it('builds a short plain text', () => {
    const blocks = parseBlocks({ format: 'tokens/1', blocks: [{ type: 'paragraph', tokens: [{ type: 'text', text: 'Hi' }, { type: 'mention', name: 'Ada' }, { type: 'link', url: 'https://x.example', text: 'x' }, { type: 'reference', visible: false, text: 'hidden' }, { type: 'reference', visible: true, title: 'T' }, { type: 'break' }] }, { type: 'list', items: [[{ type: 'code', text: 'c' }]] }, { type: 'code', text: 'block' }] }, ORIGIN);
    expect(plainText(blocks)).toBe('Hi@AdaxhiddenT c block');
    expect(plainText(blocks, 5)).toBe('Hi@A…');
    expect(plainText(null)).toBe('');
  });

  it('builds decorative icons without markup', () => {
    const icon = chatIcon('lock', 'sm');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('class')).toBe('i sm');
    expect(icon.querySelector('rect')?.getAttribute('rx')).toBe('2');
    expect(chatIcon('stop').querySelector('rect')?.getAttribute('rx')).toBe('2');
    expect(chatIcon('clock').querySelectorAll('circle')).toHaveLength(1);
  });
});

describe('timeline formatting', () => {
  const now = new Date(Date.UTC(2026, 10, 25, 12, 0));

  it('groups an author within 5 minutes, adds day and unread dividers', () => {
    const list = [
      message(1, { createdAt: '2026-11-23T09:00:00Z' }),
      message(2, { createdAt: '2026-11-24T09:00:00Z' }),
      message(3, { createdAt: '2026-11-25T09:00:00Z' }),
      message(4, { createdAt: '2026-11-25T09:03:00Z' }),
      message(5, { createdAt: '2026-11-25T09:20:00Z' }),
      message(6, { createdAt: '2026-11-25T09:21:00Z', mine: true }),
      message(7, { createdAt: '2026-11-25T09:22:00Z' }),
    ];
    const result = rows(list, 5, now, t, 'en');
    expect(result.map((row) => row.continued)).toEqual([false, false, false, true, false, true, false]);
    expect(result.filter((row) => row.day !== null)).toHaveLength(3);
    expect(result[2].day).toMatch(/^Today · /);
    expect(result[1].day).toMatch(/^Yesterday · /);
    expect(result.findIndex((row) => row.firstUnread)).toBe(6);
    expect(rows(list, null, now, t, 'en').some((row) => row.firstUnread)).toBe(false);
  });

  it('labels days: today, yesterday, weekday, full date', () => {
    expect(dayLabel('bad', now, t, 'en')).toBe('');
    expect(dayLabel('2026-11-22T10:00:00Z', now, t, 'en')).toMatch(/^Sunday/);
    expect(dayLabel('2026-01-02T10:00:00Z', now, t, 'en')).toContain('2026');
    expect(dayLabel('2026-11-25T10:00:00Z', now, chatText('es'), 'es')).toMatch(/^Hoy · /);
  });

  it('fuzzy-matches, ranks recent and unread conversations', () => {
    expect(fuzzyScore('', 'x')).toBe(0);
    expect(fuzzyScore('evp', 'envelope-v2')).not.toBeNull();
    expect(fuzzyScore('zz', 'envelope')).toBeNull();
    expect(fuzzyScore('#env', 'envelope') as number).toBeGreaterThan(fuzzyScore('nvl', 'envelope') as number);
    expect(fuzzyScore('sofia', 'Sofía Marín')).not.toBeNull();
    const rowsList = [conversation(1, { title: 'random' }), conversation(2, { title: 'envelope-v2', unread: 2 }), conversation(3, { title: 'Envelope v2' })];
    expect(rankConversations(rowsList, [uuid(3)], '').map((row) => row.title)).toEqual(['Envelope v2', 'envelope-v2', 'random']);
    expect(rankConversations(rowsList, [], 'env').map((row) => row.uuid)).toEqual([uuid(2), uuid(3)]);
  });

  it('steps through conversations and unread ones, wrapping', () => {
    const list = [conversation(1), conversation(2, { unread: 1 }), conversation(3)];
    expect(step(list, uuid(1), 1, false)).toBe(uuid(2));
    expect(step(list, uuid(1), -1, false)).toBe(uuid(3));
    expect(step(list, uuid(3), 1, true)).toBe(uuid(2));
    expect(step(list, uuid(2), 1, true)).toBeNull();
    expect(step([], null, 1, false)).toBeNull();
  });

  it('keeps a back / forward history', () => {
    const history = new History();
    expect(history.back()).toBeNull();
    history.push('a');
    history.push('a');
    history.push('b');
    history.push('c');
    expect(history.back()).toBe('b');
    expect(history.back()).toBe('a');
    expect(history.forward()).toBe('b');
    history.push('d');
    expect(history.forward()).toBeNull();
    expect(history.back()).toBe('b');
    history.clear();
    expect(history.forward()).toBeNull();
  });
});

describe('chat store (memory only)', () => {
  it('sorts rows into sections, project channels apart', () => {
    expect(sectionOf(conversation(1))).toBe('channels');
    expect(sectionOf(conversation(1, { channelKey: 'project:abc' }))).toBe('projects');
    expect(sectionOf(conversation(1, { kind: 'direct' }))).toBe('dms');
    expect(sectionOf(conversation(1, { kind: 'support' }))).toBe('support');
    expect(isMuted(conversation(1, { mutedUntil: '2099-01-01T00:00:00Z' }), Date.now())).toBe(true);
    expect(isMuted(conversation(1, { mutedUntil: '2000-01-01T00:00:00Z' }), Date.now())).toBe(false);
    expect(isMuted(conversation(1, { mutedUntil: 'garbage' }), Date.now())).toBe(true);
  });

  it('applies first and later pages, drops rows that left the head, counts the badge', () => {
    const store = new ChatStore();
    store.applyPage({ conversations: [conversation(1, { unread: 2 }), conversation(2)], nextCursor: 'c1', unreadTotal: null, unreadTotalCapped: false }, false);
    store.applyPage({ conversations: [conversation(3, { kind: 'direct', unread: 1, mutedUntil: '2099-01-01T00:00:00Z' })], nextCursor: null, unreadTotal: null, unreadTotalCapped: false }, true);
    expect(store.conversations().map((row) => row.uuid)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(store.sections().map((section) => section.id)).toEqual(['channels', 'dms']);
    expect(store.badgeCount(Date.now())).toBe(2);
    // A new first page without row 2: it left the head (archived or moved), row 3 (a later page) stays.
    store.applyPage({ conversations: [conversation(1, { unread: 0 }), conversation(4, { archived: true })], nextCursor: 'c2', unreadTotal: 5, unreadTotalCapped: true }, false);
    expect(store.conversations().map((row) => row.uuid)).toEqual([uuid(1), uuid(3)]);
    expect(store.conversation(uuid(2))).toBeNull();
    expect(store.badgeCount(Date.now())).toBe(5);
    expect(store.unreadTotalCapped).toBe(true);
    store.upsert(conversation(9, { unread: 3 }));
    expect(store.conversations()[0].uuid).toBe(uuid(9));
    store.markRead(uuid(9));
    expect(store.conversation(uuid(9))?.unread).toBe(0);
    expect(store.unreadTotal).toBe(2);
    store.markRead('missing');
    store.clear();
    expect(store.loaded).toBe(false);
    expect(store.conversations()).toEqual([]);
  });

  it('merges message pages without gaps or duplicates and stays bounded', () => {
    const store = new ChatStore();
    expect(mergeMessages([message(1), message(3)], [message(2), message(3, { edited: true })]).map((m) => [m.id, m.edited])).toEqual([[1, false], [2, false], [3, true]]);
    store.applyMessages('a', { messages: [message(10), message(11)], hasMore: true, readUpTo: 10 }, 'newest');
    store.applyMessages('a', { messages: [message(8), message(9)], hasMore: false, readUpTo: null }, 'older');
    store.applyMessages('a', { messages: [message(12)], hasMore: false, readUpTo: null }, 'newer');
    expect(store.timeline('a')).toMatchObject({ hasMore: false, readUpTo: 10 });
    expect(store.timeline('a')?.messages.map((m) => m.id)).toEqual([8, 9, 10, 11, 12]);
    // A newest page after a gap replaces the window.
    store.applyMessages('a', { messages: [message(50)], hasMore: true, readUpTo: 12 }, 'newest');
    expect(store.timeline('a')?.messages.map((m) => m.id)).toEqual([50]);
    store.setReadUpTo('a', 40);
    store.setReadUpTo('a', 60);
    expect(store.timeline('a')?.readUpTo).toBe(60);
    store.applyMessage('a', message(50, { edited: true }));
    expect(store.timeline('a')?.messages[0].edited).toBe(true);
    store.applyMessage('missing', message(1));
    const many = Array.from({ length: MAX_MESSAGES + 5 }, (_, i) => message(1000 + i));
    store.applyMessages('b', { messages: many, hasMore: false, readUpTo: null }, 'newest');
    expect(store.timeline('b')).toMatchObject({ hasMore: true });
    expect(store.timeline('b')?.messages).toHaveLength(MAX_MESSAGES);
    for (let i = 0; i < MAX_CACHED + 2; i += 1) store.applyMessages(`c${i}`, { messages: [message(1)], hasMore: false, readUpTo: null }, 'newest');
    expect(store.timeline('a')).toBeNull();
    expect(store.timeline(null)).toBeNull();
  });

  it('keeps only the open thread and refreshes its messages', () => {
    const store = new ChatStore();
    store.applyMessages('a', { messages: [message(1)], hasMore: false, readUpTo: null }, 'newest');
    store.applyThread('r1', { root: message(1), replies: [message(5)], hasMore: true, replyCount: 3 }, 'newest');
    store.applyThread('r1', { root: message(1), replies: [message(4)], hasMore: false, replyCount: 3 }, 'older');
    store.applyThread('r1', { root: message(1), replies: [message(6)], hasMore: false, replyCount: 4 }, 'newer');
    expect(store.thread('r1')?.replies.map((m) => m.id)).toEqual([4, 5, 6]);
    expect(store.thread('r1')?.hasMore).toBe(false);
    store.applyMessage('a', message(1, { edited: true }));
    store.applyMessage('a', message(5, { edited: true }));
    expect(store.thread('r1')?.root.edited).toBe(true);
    expect(store.thread('r1')?.replies[1].edited).toBe(true);
    store.applyThread('r2', { root: message(2), replies: [], hasMore: false, replyCount: 0 }, 'newest');
    expect(store.thread('r1')).toBeNull();
    store.dropThreads();
    expect(store.thread('r2')).toBeNull();
    expect(store.thread(null)).toBeNull();
  });
});

describe('chat strings', () => {
  it('has every key in Spanish', () => {
    const es = chatText('es');
    expect(es('connectButton')).toBe('Conectar chat');
    expect(es('replies', { count: 3 })).toBe('3 respuestas');
    expect(es('replies')).toBe('{count} respuestas');
  });
});
