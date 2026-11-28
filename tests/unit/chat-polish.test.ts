// @vitest-environment happy-dom
// UX batch 5, chat polish, through the DOM against the in-process mock Beacon: the offline send queue (UXA-6: queued,
// in order, Try now / Cancel, survives a module switch), the home view (unread, mentions, recent; keyboard), keyed
// timeline rendering and a selection that survives a poll (UXA-26), "(edited)" inline (UXA-33), the reaction picker in
// the toolbar's place in the top layer (UXA-34, UXA-46), person-based DM avatars (UXA-12), the composer's scroll shadow
// (UXA-39) and the connect card copy (UXA-5).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcile } from '../../src/chat/module';
import { ChatStore } from '../../src/chat/store';
import { type Message, parseConversation } from '../../src/chat/types';
import { browserPlatform } from '../../src/platform';
import { Shell } from '../../src/shell/shell';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

async function until(ready: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ENVELOPE = '0c000000-0000-4000-8000-000000000001';

type Writes = { writes: { key: string; replayed: boolean; kind?: string; method?: string }[] };
const writes = async () => ((await env.control('chat/state')) as Writes).writes;

function mount(locale: 'en' | 'es' = 'en') {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.1.0', nodeFetch);
  const shell = new Shell(root, platform, { locale, storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, {
    storage: localStorage,
    locale,
    onRender: () => shell.onAppRender(),
    beforeSignOut: () => shell.chat.revokeOnServer(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
  });
  shell.attach(app);
  shell.freshSignIn = true;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  return { root, platform, shell, app, $, key };
}

/** The fake window's size (happy-dom): media queries follow it. Each test starts at the compact 400 × 640. */
function windowSize(width: number, height: number): void {
  (window as unknown as { happyDOM: { setWindowSize(size: { width: number; height: number }): void } }).happyDOM.setWindowSize({ width, height });
}

async function connected(locale: 'en' | 'es' = 'en') {
  const ui = mount(locale);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
  await done;
  ui.$<HTMLButtonElement>('#tab-chat').click();
  ui.$<HTMLButtonElement>('#chat-connect').click();
  await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
  await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
  await until(() => ui.$('.side .conv') !== null, 'the conversations');
  ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
  await until(() => ui.$(`[data-conv="${ENVELOPE}"]`) !== null, 'the organization list');
  ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
  await until(() => document.querySelector('#msg-list li.msg') !== null, 'the messages');
  return ui;
}

function type(field: HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

function enter(field: HTMLElement): void {
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

const MAYA = '0c000000-0000-4000-8000-000000000006';
const STUDIO = '0c000000-0000-4000-8000-000000000009';
const ORG2 = 'org:7b1f2a9f-2c3d-4e4f-9a01-b2c3d4e5f6a7';

const texts = () => [...document.querySelectorAll('#msg-list li.msg .m-body')].map((node) => node.textContent ?? '');

describe('chat polish (UX batch 5)', () => {
  beforeEach(async () => {
    windowSize(400, 640);
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('queues sends the server could not take, keeps their order across a module switch, Try now sends them once each', async () => {
    const ui = await connected();
    await env.control('config', { chatFailNext: { status: 503, error: 'server_error', writesOnly: true, times: 1000 } });
    type(ui.$<HTMLTextAreaElement>('#composer'), 'First while down');
    enter(ui.$<HTMLTextAreaElement>('#composer'));
    await until(() => document.querySelector('#msg-list li.msg.pending.queued .m-status.offline') !== null, 'the queued message');
    // The sync now says offline: the next message waits without a request of its own.
    await until(() => ui.shell.chat.netState === 'offline', 'offline');
    type(ui.$<HTMLTextAreaElement>('#composer'), 'Second while down');
    enter(ui.$<HTMLTextAreaElement>('#composer'));
    expect(document.querySelectorAll('#msg-list li.msg.pending.queued')).toHaveLength(2);
    expect(ui.$('#chat-banner').textContent).toMatch(/You are offline\. 2 messages will send when the connection is back\.|2 messages are waiting to send\./);
    expect((await writes()).length).toBe(0);
    // Switching to Time and back keeps the queue (it lives in the chat module, in memory).
    ui.$<HTMLButtonElement>('#tab-time').click();
    ui.$<HTMLButtonElement>('#tab-chat').click();
    expect(document.querySelectorAll('#msg-list li.msg.pending.queued')).toHaveLength(2);
    // The server takes writes again; Try now sends the first, and the second follows in order.
    await env.control('config', { chatFailNext: null });
    const first = ui.$('#msg-list li.msg.pending.queued');
    ([...first.querySelectorAll('button')].find((button) => button.textContent === 'Try now') as HTMLButtonElement).click();
    await until(async () => (await writes()).length === 2, 'both writes');
    await until(() => document.querySelector('#msg-list li.msg.pending') === null, 'both sent');
    expect(texts().slice(-2)).toEqual(['First while down', 'Second while down']);
    // One write each: a reconnect never sends a message twice.
    const keys = (await writes()).map((item) => item.key);
    expect(new Set(keys).size).toBe(2);
    expect((await writes()).every((item) => !item.replayed)).toBe(true);
  });

  it('Cancel takes a queued message back into an empty message box', async () => {
    const ui = await connected();
    await env.control('config', { chatFailNext: { status: 503, error: 'server_error', writesOnly: true, times: 1000 } });
    type(ui.$<HTMLTextAreaElement>('#composer'), 'Never mind');
    enter(ui.$<HTMLTextAreaElement>('#composer'));
    await until(() => document.querySelector('#msg-list li.msg.pending.queued') !== null, 'the queued message');
    const row = ui.$('#msg-list li.msg.pending.queued');
    ([...row.querySelectorAll('button')].find((button) => button.textContent === 'Cancel') as HTMLButtonElement).click();
    expect(document.querySelector('#msg-list li.msg.pending')).toBeNull();
    expect(ui.$<HTMLTextAreaElement>('#composer').value).toBe('Never mind');
    expect(document.activeElement).toBe(ui.$('#composer'));
  });

  it('home view: unread first, mentions with their words, recent; the sidebar Home entry; Enter opens a mention at it', async () => {
    // The full home view is the wide window's (the compact one has its reduced home, below).
    windowSize(1280, 800);
    const ui = await connected();
    ui.$<HTMLButtonElement>('#chat-home-link').click();
    await until(() => ui.shell.chat.openUuid() === null && !ui.$('#chat-home').hidden, 'home');
    expect(ui.$('#chat-home-link').getAttribute('aria-current')).toBe('page');
    expect(ui.$('.hm-sub').textContent).toMatch(/^Lumen Works · \d conversations? with unread messages$/);
    // Unread: muted ones stay out (random is muted), the DM with Maya is in.
    const unread = [...document.querySelectorAll<HTMLElement>('#chat-home [aria-labelledby="hm-unread"] .hm-row')].map((row) => row.querySelector('.hm-name')?.textContent);
    expect(unread).toContain('Maya Okafor');
    expect(unread).not.toContain('random');
    // The home view loads the newest page of a few unread conversations (once), so their mentions can show.
    await until(() => ui.shell.chat.sync?.store.timeline(MAYA) !== null, 'the peeked DM');
    // Mentions: Maya mentioned the reader in envelope-v2 (loaded when it was opened).
    const mention = ui.$<HTMLButtonElement>('#chat-home .hm-row.mention');
    expect(mention.textContent).toContain('Maya Okafor in envelope-v2');
    expect(mention.textContent).toContain('can you look at the 4-byte case');
    // DM avatars use the person's initials and colour, the same as their messages (UXA-12).
    const dm = ui.$(`[data-conv="${MAYA}"] .av`);
    const author = mention.querySelector('.av') as HTMLElement;
    expect(dm.textContent).toBe('MO');
    expect([...dm.classList].find((name) => name.startsWith('hue-'))).toBe([...author.classList].find((name) => name.startsWith('hue-')));
    // Recent: the conversation opened before.
    expect([...document.querySelectorAll('#chat-home [aria-labelledby="hm-recent"] .hm-name')].map((node) => node.textContent)).toContain('envelope-v2');
    mention.click();
    await until(() => document.activeElement instanceof HTMLElement && document.activeElement.matches('li.msg.mentioned'), 'the mentioned message');
    expect(ui.shell.chat.openUuid()).toBe(ENVELOPE);
    // Esc leaves to the home view again.
    ui.key({ key: 'Escape' });
    await until(() => !ui.$('#chat-home').hidden, 'home again');
  });

  it('home view: an organization with no unread says so calmly, in Spanish too', async () => {
    windowSize(1280, 800);
    const ui = await connected('es');
    ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG2}"]`).click();
    await until(() => ui.$(`[data-conv="${STUDIO}"]`) !== null, 'Harbor Studio');
    expect(ui.$('#chat-home h1').textContent).toBe('Inicio');
    ui.$<HTMLButtonElement>(`[data-conv="${STUDIO}"]`).click();
    await until(() => document.querySelector('#msg-list li.msg') !== null, 'the studio messages');
    ui.key({ key: 'Escape' });
    await until(() => !ui.$('#chat-home').hidden && ui.$('.hm-calm') !== null, 'caught up');
    expect(ui.$('.hm-calm').textContent).toContain('Todo al día');
    expect(ui.$('.hm-calm img.mascot')?.getAttribute('alt')).toBe('');
    expect(ui.$('.hm-none').textContent).toBe('Cuando alguien te mencione, aparecerá aquí.');
  });

  it('compact window: a reduced home (unread, recent, then mentions), All conversations opens the list, Back returns where it came from (0.14.1)', async () => {
    const ui = await connected();
    // Picked from the home (not the list): Back goes home, the reduced one.
    ui.key({ key: 'Escape' });
    await until(() => !ui.$('#chat-home').hidden && ui.$('#chat-home .hm-row') !== null, 'the compact home');
    expect(ui.$('#chat-home').dataset.compact).toBe('true');
    expect(ui.shell.chat.root.classList.contains('list-open')).toBe(false);
    expect(document.activeElement?.classList.contains('hm-row')).toBe(true);
    const sections = () => [...document.querySelectorAll('#chat-home .hm-sec > h2')].map((node) => node.id);
    await until(() => sections().includes('hm-mentions'), 'the mentions');
    expect(sections()).toEqual(['hm-unread', 'hm-recent', 'hm-mentions']);
    expect(document.querySelectorAll('#chat-home [aria-labelledby="hm-recent"] .hm-row').length).toBeLessThanOrEqual(4);
    expect([...document.querySelectorAll('#chat-home [aria-labelledby="hm-recent"] .hm-name')].map((node) => node.textContent)).toContain('envelope-v2');
    // One tab stop for the rows; ↓ moves.
    expect(document.querySelectorAll('#chat-home .hm-row[tabindex="0"]')).toHaveLength(1);
    // All conversations: the list, its first row focused; a conversation picked there goes back to the list.
    ui.$<HTMLButtonElement>('#chat-home-all').click();
    expect(ui.$('#chat-home-all').textContent).toBe('All conversations');
    expect(ui.shell.chat.root.classList.contains('list-open')).toBe(true);
    expect(document.activeElement?.matches('.side .conv, #chat-home-link')).toBe(true);
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => ui.shell.chat.openUuid() === ENVELOPE, 'opened from the list');
    expect(ui.shell.chat.root.classList.contains('list-open')).toBe(false);
    ui.key({ key: 'Escape' });
    await until(() => ui.shell.chat.root.classList.contains('list-open'), 'back to the list');
    expect(document.activeElement).toBe(ui.$(`[data-conv="${ENVELOPE}"]`));
    // The list's Home entry: the reduced home again.
    ui.$<HTMLButtonElement>('#chat-home-link').click();
    await until(() => !ui.shell.chat.root.classList.contains('list-open') && !ui.$('#chat-home').hidden, 'home from the list');
    // Wider again: the full home (mentions before recent, no "All conversations").
    windowSize(1280, 800);
    await until(() => ui.$('#chat-home').dataset.compact === 'false', 'the full home');
    expect(document.querySelector('#chat-home-all')).toBeNull();
  });

  it('keeps unchanged rows on a re-render and waits while text is selected (UXA-26)', async () => {
    const ui = await connected();
    const before = [...document.querySelectorAll('#msg-list li.msg')];
    ui.shell.chat.renderMessages();
    const after = [...document.querySelectorAll('#msg-list li.msg')];
    expect(after).toHaveLength(before.length);
    after.forEach((node, index) => expect(node).toBe(before[index]));
    // Select words in a message, then a new message arrives: the list waits.
    const body = after[after.length - 2].querySelector('.m-body') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    await env.control('chat/post', { conversation: ENVELOPE, author: 'leo', text: 'While you were selecting' });
    await ui.shell.chat.sync?.catchUp(ENVELOPE);
    expect(texts()).not.toContain('While you were selecting');
    expect(window.getSelection()?.isCollapsed).toBe(false);
    selection.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(texts()).toContain('While you were selecting');
    // The rows that did not change are the same nodes; only the new one was built.
    expect(document.querySelector('#msg-list li.msg')).toBe(before[0]);
  });

  it('puts "(edited)" after the last words, and the reaction picker in the toolbar\'s place in the top layer', async () => {
    const ui = await connected();
    const root = [...document.querySelectorAll<HTMLElement>('#msg-list li.msg')].find((item) => item.querySelector('.thread-link') !== null) as HTMLElement;
    ui.shell.chat.openThread(root.dataset.uuid as string);
    await until(() => document.querySelector('.thread .edited') !== null, 'the edited reply');
    expect(ui.$('.thread .edited').parentElement?.tagName).toBe('P');
    ui.shell.chat.closeThread();
    const item = [...document.querySelectorAll<HTMLElement>('#msg-list li.msg')].at(-1) as HTMLElement;
    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
    const menu = ui.$('.emoji-menu');
    expect(menu).not.toBeNull();
    expect(item.classList.contains('picking')).toBe(true);
    expect(menu.getAttribute('popover')).toBe(typeof menu.showPopover === 'function' && Object.hasOwn(HTMLElement.prototype, 'popover') ? 'auto' : null);
    // A light dismiss from the browser (toggle to closed) closes it and gives the toolbar back.
    menu.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }));
    expect(document.querySelector('.emoji-menu')).toBeNull();
    expect(item.classList.contains('picking')).toBe(false);
    // The context menu goes to the top layer too, and Esc returns focus to the message.
    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    const context = ui.$('.ctx-menu');
    expect(context).not.toBeNull();
    context.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'closed' }));
    expect(document.querySelector('.ctx-menu')).toBeNull();
  });

  it('shows a shadow when the message box scrolls under its toolbar (UXA-39)', async () => {
    const ui = await connected();
    const field = ui.$<HTMLTextAreaElement>('#composer');
    const form = field.closest('form') as HTMLFormElement;
    expect(form.classList.contains('scrolled')).toBe(false);
    field.scrollTop = 24;
    field.dispatchEvent(new Event('scroll'));
    expect(form.classList.contains('scrolled')).toBe(field.scrollTop > 0);
  });

  it('the connect card no longer says read-only or no notifications (UXA-5)', async () => {
    for (const locale of ['en', 'es'] as const) {
      const ui = mount(locale);
      await ui.app.init();
      const done = ui.app.connect(env.url);
      await until(() => ui.$('#user-code') !== null, 'the device code');
      await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
      await done;
      ui.$<HTMLButtonElement>('#tab-chat').click();
      await until(() => ui.$('#chat-connect-card') !== null, 'the connect card');
      const text = ui.$('#chat-connect-card').textContent ?? '';
      expect(text).not.toMatch(/read-only|solo lectura|no notifications|sin notificaciones/i);
      expect(text).toContain(locale === 'en' ? 'Send and read messages next to your timer.' : 'Envía y lee mensajes junto a tu temporizador.');
      localStorage.clear();
    }
  });
});

describe('chat polish helpers', () => {
  const person = { uuid: '0f000000-0000-4000-8000-000000000002', name: 'Maya Okafor', initials: 'MO', bot: false };
  const message = (id: number, extra: Partial<Message> = {}): Message => ({ id, uuid: `0c000000-0000-4000-8000-${String(id).padStart(12, '0')}`, kind: 'user', author: person, mine: false, createdAt: `2026-11-27T09:${String(id % 60).padStart(2, '0')}:00Z`, edited: false, deleted: false, mentionsMe: false, threadRootUuid: null, thread: null, reactions: [], blocks: [], ...extra });

  it('reconcile keeps, moves, builds and removes keyed rows', () => {
    const parent = document.createElement('ul');
    let built = 0;
    const row = (key: string, sig = '') => ({ key, sig, build: () => (built++, Object.assign(document.createElement('li'), { textContent: `${key}${sig}` })) });
    reconcile(parent, [row('a'), row('b'), row('c')]);
    const [a, b, c] = [...parent.children];
    expect(built).toBe(3);
    reconcile(parent, [row('c'), row('a'), row('b', '!'), row('d')]);
    expect([...parent.children].map((node) => node.textContent)).toEqual(['c', 'a', 'b!', 'd']);
    expect(parent.children[0]).toBe(c);
    expect(parent.children[1]).toBe(a);
    expect(parent.children[2]).not.toBe(b);
    expect(built).toBe(5);
    reconcile(parent, [row('a')]);
    expect([...parent.children]).toEqual([a]);
  });

  it('lists recent mentions of loaded timelines, newest first, never the reader\'s own or deleted ones', () => {
    const store = new ChatStore();
    const conv = parseConversation({ uuid: '0c000000-0000-4000-8000-000000000001', kind: 'channel', title: 'a', unread: 1 });
    if (conv === null) throw new Error('conversation');
    store.applyPage({ conversations: [conv], nextCursor: null, unreadTotal: 1, unreadTotalCapped: false }, false);
    store.applyMessages(conv.uuid, { messages: [message(1, { mentionsMe: true }), message(2, { mentionsMe: true, mine: true }), message(3, { mentionsMe: true, deleted: true, blocks: null }), message(4, { mentionsMe: true }), message(5)], hasMore: false, readUpTo: 1 }, 'newest');
    const found = store.mentions();
    expect(found.map((item) => item.message.id)).toEqual([4, 1]);
    expect(found.map((item) => item.unread)).toEqual([true, false]);
    expect(store.mentions(1)).toHaveLength(1);
  });

  it('reads a direct message\'s peer id (and only for a direct message)', () => {
    expect(parseConversation({ uuid: '0c000000-0000-4000-8000-000000000006', kind: 'direct', title: 'Maya', peerUuid: '0F000000-0000-4000-8000-000000000002' })?.peerUuid).toBe('0f000000-0000-4000-8000-000000000002');
    expect(parseConversation({ uuid: '0c000000-0000-4000-8000-000000000006', kind: 'direct', title: 'Maya', peerUuid: 'nope' })?.peerUuid).toBeNull();
    expect(parseConversation({ uuid: '0c000000-0000-4000-8000-000000000001', kind: 'channel', title: 'x', peerUuid: '0f000000-0000-4000-8000-000000000002' })?.peerUuid).toBeNull();
  });
});

describe('chat status and undo (UX batch 4)', () => {
  beforeEach(async () => {
    windowSize(400, 640);
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  const button = (row: Element, label: string) => [...row.querySelectorAll('button')].find((item) => item.textContent === label) as HTMLButtonElement;

  it('Cancel offers Undo (UXA-8): Ctrl+Z in the untouched message box puts the message back in line, sent once', async () => {
    const ui = await connected();
    await env.control('config', { chatFailNext: { status: 503, error: 'server_error', writesOnly: true, times: 1000 } });
    type(ui.$<HTMLTextAreaElement>('#composer'), 'Never mind');
    enter(ui.$<HTMLTextAreaElement>('#composer'));
    await until(() => document.querySelector('#msg-list li.msg.pending.queued') !== null, 'the queued message');
    const key = ui.shell.chat.outbox?.pending(ENVELOPE, null)[0]?.key;
    button(ui.$('#msg-list li.msg.pending.queued'), 'Cancel').click();
    expect(ui.$<HTMLTextAreaElement>('#composer').value).toBe('Never mind');
    expect(ui.$('#undo-toasts .ut-text').textContent).toBe('Message cancelled');
    // Focus stays in the message box (the toast never takes it); Ctrl+Z there, text untouched, is the toast's undo.
    expect(document.activeElement).toBe(ui.$('#composer'));
    ui.key({ key: 'z', ctrlKey: true }, ui.$('#composer'));
    expect(ui.$<HTMLTextAreaElement>('#composer').value).toBe('');
    expect(ui.shell.chat.outbox?.pending(ENVELOPE, null).map((item) => item.key)).toEqual([key]);
    expect(document.querySelector('#msg-list li.msg.pending.queued')).not.toBeNull();
    await env.control('config', { chatFailNext: null });
    button(ui.$('#msg-list li.msg.pending.queued'), 'Try now').click();
    await until(async () => (await writes()).length === 1, 'the write');
    expect((await writes())[0].key).toBe(key);
  });

  it('Discard offers Undo (UXA-8); a context switch drops it and a stale undo restores nothing', async () => {
    const ui = await connected();
    await env.control('config', { chatFailNext: { status: 422, error: 'text_too_long', writesOnly: true } });
    type(ui.$<HTMLTextAreaElement>('#composer'), 'Refused words');
    enter(ui.$<HTMLTextAreaElement>('#composer'));
    await until(() => document.querySelector('#msg-list li.msg.pending .m-status.failed') !== null, 'the failed message');
    button(ui.$('#msg-list li.msg.pending'), 'Discard').click();
    expect(document.querySelector('#msg-list li.msg.pending')).toBeNull();
    expect(ui.$('#undo-toasts .ut-text').textContent).toBe('Message discarded');
    ui.$<HTMLButtonElement>('#undo-toasts .ut-undo').click();
    await until(() => document.querySelector('#msg-list li.msg.pending .m-status.failed') !== null, 'back as failed');
    expect((await writes()).length).toBe(0);
    // Discard again, then switch organization: the toast goes, and its undo does nothing there.
    button(ui.$('#msg-list li.msg.pending'), 'Discard').click();
    const offer = ui.shell.toasts.offers.at(-1);
    expect(offer).toBeDefined();
    await until(() => document.querySelector('.ctx-tile[data-context="personal"]') !== null, 'the personal tile');
    ui.$<HTMLButtonElement>('.ctx-tile[data-context="personal"]').click();
    await until(() => ui.shell.context === 'personal', 'personal');
    expect(ui.shell.toasts.offers).toHaveLength(0);
    offer?.undo();
    expect(ui.shell.chat.outbox?.pending(ENVELOPE, null) ?? []).toEqual([]);
  });

  it('a 429 while a conversation loads says so in the pane after 1.5 s, Retry waits for the pause (UXA-13); the strip counts down (UXA-7)', async () => {
    const ui = await connected();
    // The read mark of the conversation left and the new conversation's first page both meet the 429.
    await env.control('config', { chatFailNext: { status: 429, error: 'rate_limited', retryAfter: 30, times: 2 } });
    // Leo Brandt's direct messages: no unread, so nothing of it is loaded yet (the home view peeks only unread ones).
    const leo = '0c000000-0000-4000-8000-000000000007';
    expect(ui.shell.chat.sync?.store.timeline(leo)).toBeNull();
    ui.$<HTMLButtonElement>(`[data-conv="${leo}"]`).click();
    await until(() => ui.shell.chat.netState === 'limited', 'the pause');
    expect(ui.$('#chat-pause-note')).toBeNull();
    await until(() => ui.$('#chat-pause-note') !== null, 'the pause note', 4000);
    expect(ui.$('#chat-pause-text').textContent).toMatch(/^Taking a short pause\. Loading again in 0:(29|30)\.$/);
    expect(ui.$<HTMLButtonElement>('#chat-pause-retry').disabled).toBe(true);
    expect(document.querySelectorAll('#msg-list .skel-msg').length).toBeGreaterThan(0);
    expect(ui.$('#chat-banner-text').textContent).toMatch(/^Paused for a moment\. Back in 0:(29|30)\.$/);
    expect(ui.$('#chat-banner').className).toBe('ss-box info');
  });

  it('the jump button says "new below" when the only unread messages are in the open conversation (UXA-11)', async () => {
    const ui = await connected();
    const store = ui.shell.chat.sync?.store;
    for (const row of store?.conversations() ?? []) (row as { unread: number }).unread = 0;
    const open = store?.conversation(ENVELOPE) as { unread: number };
    open.unread = 2;
    ui.shell.chat.render();
    // BDA14-I7: the short text on one line (the arrow says "below"); the button's name keeps the full sentence.
    expect(ui.$('#chat-jump span').textContent).toBe('2 new messages');
    expect(ui.$('#chat-jump').getAttribute('aria-label')).toBe('2 new messages below');
    expect(ui.$<HTMLButtonElement>('#chat-jump').disabled).toBe(false);
    open.unread = 1;
    ui.shell.chat.render();
    expect(ui.$('#chat-jump span').textContent).toBe('1 new message');
    expect(ui.$('#chat-jump').getAttribute('aria-label')).toBe('1 new message below');
    open.unread = 0;
    ui.shell.chat.render();
    expect(ui.$('#chat-jump').textContent).toContain('All caught up');
    expect(ui.$('#chat-jump').hasAttribute('aria-label')).toBe(false);
    expect(ui.$<HTMLButtonElement>('#chat-jump').disabled).toBe(true);
  });
});
