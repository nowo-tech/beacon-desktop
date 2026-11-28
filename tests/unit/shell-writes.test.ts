// @vitest-environment happy-dom
// The chat module's writes through the DOM (BD-3b) against the in-process mock Beacon: the composer in a conversation,
// sending and the pending row, a failed send with Retry under the same key, a refusal with Edit, reactions (chips,
// the picker on E), replying in a thread (R), the read-only notes and "Allow sending".
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const INCIDENTS = '0c000000-0000-4000-8000-000000000002';

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

describe('chat writes in the module', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('sends from the composer: pending row, then the server copy, then the catch-up; the draft stays per conversation', async () => {
    const ui = await connected();
    const field = ui.$<HTMLTextAreaElement>('#composer');
    expect(field.placeholder).toBe('Message #envelope-v2');
    expect(ui.$('#chat-foot .readonly-note')).toBeNull();
    // C focuses the message box.
    ui.key({ key: 'c' });
    expect(document.activeElement).toBe(field);
    // A draft survives switching conversations (memory only).
    type(field, 'half a thought');
    ui.key({ key: 'ArrowDown', altKey: true });
    await until(() => ui.shell.chat.openUuid() !== ENVELOPE, 'the next conversation');
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => ui.$<HTMLTextAreaElement>('#composer')?.value === 'half a thought', 'the draft');
    const again = ui.$<HTMLTextAreaElement>('#composer');
    type(again, 'Ship it **today**');
    const count = document.querySelectorAll('#msg-list li.msg').length;
    enter(again);
    expect(again.value).toBe('');
    expect(document.querySelectorAll('#msg-list li.msg').length).toBe(count + 1);
    await until(async () => (await writes()).length === 1, 'the write');
    await until(() => document.querySelector('#msg-list li.msg.pending') === null, 'the sent message');
    expect(document.querySelectorAll('#msg-list li.msg').length).toBe(count + 1);
    const last = [...document.querySelectorAll('#msg-list li.msg')].at(-1) as HTMLElement;
    // Rendered as the server renders it: bold, never the raw markers.
    expect(last.textContent).toContain('Ship it today');
    expect(last.querySelector('.m-body strong')?.textContent).toBe('today');
    // ↑ in the empty box goes to the last message.
    ui.$<HTMLTextAreaElement>('#composer').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(document.activeElement?.classList.contains('msg')).toBe(true);
  });

  it('a context switch forgets the drafts of the previous organization (PRIVACY.md, ZDG-L2)', async () => {
    const ui = await connected();
    type(ui.$<HTMLTextAreaElement>('#composer'), 'not for the next organization');
    ui.$<HTMLButtonElement>('.ctx-tile[data-context="personal"]').click();
    await until(() => ui.shell.context === 'personal', 'Personal');
    ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
    await until(() => ui.shell.context === ORG && ui.$(`[data-conv="${ENVELOPE}"]`) !== null, 'back in the organization');
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => ui.$<HTMLTextAreaElement>('#composer') !== null, 'the message box');
    expect(ui.$<HTMLTextAreaElement>('#composer').value).toBe('');
  });

  it('a send the server could not take waits in the queue (Try now, same key); a refusal offers Edit and Discard', async () => {
    const ui = await connected();
    await env.control('config', { chatFailNext: { status: 503, error: 'server_error', writesOnly: true, times: 1000 } });
    const field = ui.$<HTMLTextAreaElement>('#composer');
    type(field, 'First try');
    enter(field);
    // UXA-6: a 5xx (or no network) is not "Not sent": the message waits, with Try now and Cancel.
    await until(() => document.querySelector('#msg-list li.msg.pending.queued .m-status.offline') !== null, 'the queued message');
    const queued = ui.$('#msg-list li.msg.pending.queued');
    expect(queued.querySelector('[role="status"]')?.textContent).toContain('Waiting for connection. It sends when you are back online.');
    expect(queued.querySelector('[role="alert"]')).toBeNull();
    expect([...queued.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Try now', 'Cancel']);
    await env.control('config', { chatFailNext: null });
    const retry = [...queued.querySelectorAll('button')].find((button) => button.textContent === 'Try now') as HTMLButtonElement;
    retry.click();
    await until(async () => (await writes()).length === 1, 'the retried write');
    await until(() => document.querySelector('#msg-list li.msg.pending') === null, 'the sent message');
    // The refusal: the server says the text is too long (the mock limit is the same as the app's, so force it).
    await env.control('config', { chatFailNext: { status: 422, error: 'text_too_long' } });
    type(ui.$<HTMLTextAreaElement>('#composer'), 'Second');
    enter(ui.$<HTMLTextAreaElement>('#composer'));
    await until(() => document.querySelector('#msg-list li.msg.pending.failed') !== null, 'the refusal');
    const refused = ui.$('#msg-list li.msg.pending.failed');
    expect(refused.textContent).toContain('Not sent: the message is too long.');
    const edit = [...refused.querySelectorAll('button')].find((button) => button.textContent === 'Edit') as HTMLButtonElement;
    edit.click();
    expect(ui.$<HTMLTextAreaElement>('#composer').value).toBe('Second');
    expect(document.querySelector('#msg-list li.msg.pending')).toBeNull();
    // Discard.
    await env.control('config', { chatFailNext: { status: 403, error: 'read_only' } });
    enter(ui.$<HTMLTextAreaElement>('#composer'));
    await until(() => document.querySelector('#msg-list li.msg.pending.failed') !== null, 'the read-only refusal');
    expect(ui.$('#msg-list li.msg.pending.failed').textContent).toContain('you can no longer post here');
    ([...ui.$('#msg-list li.msg.pending.failed').querySelectorAll('button')].find((button) => button.textContent === 'Discard') as HTMLButtonElement).click();
    expect(document.querySelector('#msg-list li.msg.pending')).toBeNull();
  });

  it('reacts with the chips, the hover toolbar and the picker on E; menus are keyboard only', async () => {
    await connected();
    const item = document.querySelector<HTMLElement>('#msg-list li.msg:has(.reacts)') as HTMLElement;
    const chip = item.querySelector<HTMLButtonElement>('.react.mine') as HTMLButtonElement;
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.tabIndex).toBe(-1);
    chip.click();
    await until(() => !(document.querySelector<HTMLElement>(`li.msg[data-uuid="${item.dataset.uuid}"] .react[aria-label^="👀"]`)?.classList.contains('mine') ?? false), 'the removed reaction');
    await until(async () => (await writes()).some((write) => write.method === 'DELETE'), 'the DELETE');
    // E on a focused message opens the picker; arrows move, Enter picks.
    const again = document.querySelector<HTMLElement>(`li.msg[data-uuid="${item.dataset.uuid}"]`) as HTMLElement;
    again.focus();
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
    const menu = document.querySelector('.emoji-menu') as HTMLElement;
    expect(menu.getAttribute('role')).toBe('menu');
    const options = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')];
    expect(options.map((option) => option.textContent)).toEqual(['👍', '👀', '✅', '🎉', '🙏']);
    expect(document.activeElement).toBe(options[0]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    (document.activeElement as HTMLButtonElement).click();
    expect(document.querySelector('.emoji-menu')).toBeNull();
    await until(async () => (await writes()).some((write) => write.method === 'PUT'), 'the PUT');
    // The hover toolbar: quick reactions, the picker, reply, more.
    const fresh = document.querySelector<HTMLElement>(`li.msg[data-uuid="${item.dataset.uuid}"]`) as HTMLElement;
    const toolbar = fresh.querySelector('.m-actions') as HTMLElement;
    expect([...toolbar.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['React with 👍', 'React with 👀', 'Add reaction', 'Reply in thread', 'More actions']);
    expect([...toolbar.querySelectorAll('button')].every((button) => button.tabIndex === -1)).toBe(true);
    (toolbar.querySelector('button') as HTMLButtonElement).click();
    (toolbar.querySelectorAll('button')[2] as HTMLButtonElement).click();
    (document.querySelector('.emoji-menu') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.emoji-menu')).toBeNull();
    (toolbar.querySelectorAll('button')[4] as HTMLButtonElement).click();
    expect([...document.querySelectorAll('.ctx-menu [role="menuitem"]')].map((entry) => entry.textContent)).toEqual(['Copy text', 'Copy link', '3 replies, open thread', 'Add reaction']);
    (document.querySelector('.ctx-menu') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Shift+F10 opens the same menu from the keyboard (the list was drawn again: take the current item).
    const current = document.querySelector<HTMLElement>(`li.msg[data-uuid="${item.dataset.uuid}"]`) as HTMLElement;
    current.focus();
    current.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.querySelector('.ctx-menu')).not.toBeNull();
    ([...document.querySelectorAll<HTMLElement>('.ctx-menu [role="menuitem"]')].at(-1) as HTMLElement).click();
    expect(document.querySelector('.emoji-menu')).not.toBeNull();
    (document.querySelector('.emoji-menu') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  });

  it('replies in a thread with R: the thread opens with its message box focused; Esc there closes it', async () => {
    const ui = await connected();
    const root = document.querySelector<HTMLElement>('#msg-list li.msg:has(.thread-link)') as HTMLElement;
    root.focus();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
    await until(() => document.querySelector('#thread .th-root') !== null && document.activeElement?.id === 'thread-composer', 'the thread box');
    const box = ui.$<HTMLTextAreaElement>('#thread-composer');
    expect(box.placeholder).toBe('Reply in thread…');
    const replies = document.querySelectorAll('#thread .msgs li.msg').length;
    type(box, 'Looking now');
    enter(box);
    await until(async () => (await writes()).some((write) => write.kind === 'reply'), 'the reply');
    await until(() => document.querySelectorAll('#thread .msgs li.msg:not(.pending)').length === replies + 1, 'the reply in the thread');
    await until(() => (document.querySelector(`#msg-list li.msg[data-uuid="${root.dataset.uuid}"] .thread-link`)?.textContent ?? '').includes('4 replies'), 'the root count');
    ui.$<HTMLTextAreaElement>('#thread-composer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('#thread')).toBeNull();
  });

  it('says why there is no message box: read-only conversation, writes off, read-only token (Allow sending)', async () => {
    const ui = await connected('es');
    ui.$<HTMLButtonElement>(`[data-conv="${INCIDENTS}"]`).click();
    await until(() => ui.shell.chat.openUuid() === INCIDENTS && ui.$('#chat-foot .readonly-note') !== null, 'the note');
    expect(ui.$('#chat-foot').textContent).toBe('No puedes escribir en esta conversación.');
    expect(document.querySelector('#composer')).toBeNull();
    // A message there has read-only reactions and no toolbar.
    expect(document.querySelector('#msg-list .m-actions')).toBeNull();
    ui.shell.chat.me = { ...(ui.shell.chat.me as NonNullable<typeof ui.shell.chat.me>), features: { ...(ui.shell.chat.me as NonNullable<typeof ui.shell.chat.me>).features, send: false } };
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => ui.shell.chat.openUuid() === ENVELOPE, 'envelope');
    expect(ui.$('#chat-foot').textContent).toContain('Este servidor aún no acepta mensajes');
    const me = ui.shell.chat.me as NonNullable<typeof ui.shell.chat.me>;
    ui.shell.chat.me = { ...me, scopes: ['chat:read'], features: { ...me.features, send: true } };
    ui.shell.chat.renderMessages();
    const allow = ui.$<HTMLButtonElement>('#chat-allow-sending');
    expect(allow.textContent).toBe('Permitir enviar');
    allow.click();
    await until(() => ui.$('#chat-user-code') !== null, 'a new approval');
    const state = (await env.control('state')) as { requests: { path: string; body: string }[] };
    const request = state.requests.filter((item) => item.path.endsWith('device/code')).at(-1);
    expect(JSON.parse(request?.body ?? '{}').scopes).toEqual(['chat:read', 'chat:write']);
    expect(((await env.control('chat/state')) as { logouts: number }).logouts).toBe(1);
  });
});
