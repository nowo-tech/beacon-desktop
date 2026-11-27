// @vitest-environment happy-dom
// The app shell and the Chat module driven through the DOM against the in-process mock Beacon (TimeTrack + ChatKit),
// with the browser platform's fake host (chat token, realtime modes and hints, badge, links).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { contextBadge, landingModule, loadShellPrefs, SHELL_KEY, Shell } from '../../src/shell/shell';
import { DesktopApp } from '../../src/ui/app';
import { avatarHue } from '../../src/chat/module';
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
const MAYA = '0c000000-0000-4000-8000-000000000006';

function mount(locale: 'en' | 'es' = 'en', freshSignIn = true, platform = browserPlatform('0.1.0', nodeFetch)) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
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
  shell.freshSignIn = freshSignIn;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  return { root, platform, shell, app, $, key };
}

async function signedIn(locale: 'en' | 'es' = 'en') {
  const ui = mount(locale);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
  await done;
  return ui;
}

async function connected(locale: 'en' | 'es' = 'en') {
  const ui = await signedIn(locale);
  ui.$<HTMLButtonElement>('#tab-chat').click();
  ui.$<HTMLButtonElement>('#chat-connect').click();
  await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
  await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
  await until(() => ui.$('.side .conv') !== null, 'the conversations');
  return ui;
}

async function inOrg(ui: Awaited<ReturnType<typeof connected>>) {
  ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
  await until(() => ui.$(`[data-conv="${ENVELOPE}"]`) !== null, 'the organization list');
}

describe('shell preferences', () => {
  it('parses stored preferences safely and picks the landing module (Q1)', () => {
    localStorage.setItem(SHELL_KEY, JSON.stringify({ module: 'time', density: 'compact', switcher: 'dropdown', timer: 'title-sidebar', context: 'bad key!' }));
    expect(loadShellPrefs(localStorage)).toEqual({ module: 'time', density: 'compact', switcher: 'dropdown', timer: 'title-sidebar', context: null, markers: 'emoji', setup: null, skipped: [] });
    localStorage.setItem(SHELL_KEY, '{');
    expect(loadShellPrefs(localStorage).module).toBeNull();
    localStorage.setItem(SHELL_KEY, '"x"');
    expect(loadShellPrefs(localStorage).density).toBe('comfortable');
    expect(loadShellPrefs(undefined).switcher).toBe('tiles');
    const prefs = loadShellPrefs(undefined);
    expect(landingModule(prefs, false)).toBe('chat');
    expect(landingModule({ ...prefs, module: 'time' }, false)).toBe('time');
    expect(landingModule({ ...prefs, module: 'chat' }, true)).toBe('time');
    expect(contextBadge({ key: 'personal', label: 'Personal' }, 0)).toEqual({ tile: 'P', color: '#4b5e56' });
    expect(contextBadge({ key: 'org:1', label: 'Lumen Works' }, 1).tile).toBe('LW');
    expect(contextBadge({ key: 'org:2', label: 'acme' }, 2).tile).toBe('AC');
    expect(avatarHue('x')).toMatch(/^hue-\d$/);
  });

  it('needs a host with chat', () => {
    const platform = { ...browserPlatform('0.1.0', nodeFetch), chat: undefined };
    expect(() => new Shell(document.createElement('div'), platform, { locale: 'en' })).toThrow();
  });
});

describe('shell and chat module', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('stays bare while signed out, then shows the rail and the guided setup after a first sign-in', async () => {
    const ui = mount();
    await ui.app.init();
    expect(ui.shell.root.dataset.bare).toBe('true');
    const done = ui.app.connect(env.url);
    await until(() => ui.$('#user-code') !== null, 'the device code');
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
    await done;
    await until(() => ui.shell.root.dataset.bare === 'false', 'the shell');
    // UX batch 6 (UXA-4): a first sign-in opens the setup card (Chat next), no longer Time.
    await until(() => ui.shell.setupShown, 'the setup');
    expect(ui.shell.module).toBe('chat');
    expect(ui.$('#mod-chat').hidden).toBe(true);
    expect(ui.$('#mod-time').hidden).toBe(true);
    expect(ui.$('#mod-setup').hidden).toBe(false);
    expect(ui.$('#tab-time').getAttribute('aria-selected')).toBe('false');
    expect(ui.$('#chat-connect')).not.toBeNull();
    // UX batch 3 (UXA-3): the global switcher is there before chat is connected (Time's timer actions and views).
    expect(ui.$('#tb-search').hidden).toBe(false);
    // Ctrl+2 / Ctrl+1 switch modules and remember the last one.
    ui.key({ key: '1', ctrlKey: true });
    expect(ui.shell.module).toBe('chat');
    expect(JSON.parse(localStorage.getItem(SHELL_KEY) ?? '{}').module).toBe('chat');
    // The prototype's order: Chat, Tasks, Time.
    ui.$('#tab-chat').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(ui.shell.module).toBe('tasks');
    ui.$('#tab-tasks').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(ui.shell.module).toBe('time');
  });

  it('lands on Chat at a launch with a stored session (Q1)', async () => {
    const first = await signedIn();
    first.app.destroy();
    const ui = mount('en', false, first.platform);
    await ui.app.init();
    await until(() => ui.shell.root.dataset.bare === 'false', 'the shell');
    expect(ui.shell.module).toBe('chat');
  });

  it('connects chat with a chained device flow and shows the sections', async () => {
    const ui = await signedIn();
    ui.$<HTMLButtonElement>('#tab-chat').click();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
    expect(ui.platform.hooks.chatConnectBegins).toBe(1);
    expect(ui.platform.hooks.opened.at(-1)).toContain('/device');
    ui.$<HTMLButtonElement>('#chat-open-approval').click();
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
    await until(() => ui.$('.side .conv') !== null, 'the conversations');
    expect(ui.platform.hooks.chatToken).not.toBeNull();
    expect(ui.platform.hooks.chatRealtime?.context).toBe('personal');
    expect(ui.$('#tb-search').hidden).toBe(false);
    await inOrg(ui);
    expect([...document.querySelectorAll('.sec-h')].map((node) => node.textContent)).toEqual(['Channels', 'Projects', 'Direct messages', 'Support']);
    expect(ui.$(`[data-conv="${ENVELOPE}"]`).classList.contains('unread')).toBe(true);
    expect(document.querySelector('.conv.muted')).not.toBeNull();
    expect(ui.platform.hooks.badge).toBeGreaterThan(0);
    expect(document.title).toBe('Lumen Works · Beacon Desktop');
    expect(ui.$('.rail-tab#tab-chat .badge')).not.toBeNull();
    // Realtime: polling first (no hub in the mock); live hides nothing, a lost stream shows the banner.
    await until(() => ui.shell.chat.mode === 'polling', 'polling');
    // UXA-14: a healthy connection (polling or live) says nothing in the sidebar; Settings → Chat says it.
    expect(ui.$('#chat-side-foot').hidden).toBe(true);
    expect(ui.$('#chat-side-foot').textContent).toBe('');
    expect(ui.shell.chat.connectionStatus()).toEqual({ tone: 'ok', text: 'Checking for new messages every 30 s' });
    ui.platform.hooks.chatMode('live');
    expect(ui.$('#chat-side-foot').hidden).toBe(true);
    expect(ui.shell.chat.connectionStatus()).toEqual({ tone: 'ok', text: 'Connected' });
    ui.platform.hooks.chatMode('polling');
    expect(ui.$('#chat-banner').hidden).toBe(false);
    expect(ui.$('#chat-side-foot').hidden).toBe(false);
    expect(ui.$('#chat-side-foot').textContent).toContain('Reconnecting');
  });

  it('cancels and reports refused, denied and failed connections', async () => {
    const ui = await signedIn();
    ui.$<HTMLButtonElement>('#tab-chat').click();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-cancel') !== null, 'the chat code');
    ui.$<HTMLButtonElement>('#chat-cancel').click();
    expect(ui.$('#chat-connect')).not.toBeNull();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent, approve: false });
    await until(() => ui.$('.cc-error') !== null, 'the denial');
    expect(ui.$('.cc-error').textContent).toContain('denied');
    await env.control('config', { notFound: ['device/code'] });
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('.cc-error')?.textContent?.includes('Beacon did not accept') === true, 'the refusal');
    ui.platform.hooks.declineSignIn = false;
  });

  it('opens a conversation, its thread, keyboard navigation, history, read marks and Esc', async () => {
    const ui = await connected();
    await inOrg(ui);
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => document.querySelector('#msg-list li.msg') !== null, 'the messages');
    expect(ui.$('#chat-title').textContent).toContain('envelope-v2');
    expect(document.querySelector('#new-div')).not.toBeNull();
    expect(document.querySelector('.msg.mentioned')).not.toBeNull();
    expect(document.querySelector('.react.mine')?.getAttribute('aria-label')).toBe('👀 3, including you');
    expect(document.querySelector('.ref.ref-hidden')?.textContent).toBe('Content not visible');
    // The chat is visible: a read mark goes out for the newest message.
    ui.shell.chat.setShown(true);
    await until(async () => ((await env.control('chat/state')) as { reads: unknown[] }).reads.length > 0, 'a read mark', 5000);
    // Links open through the host.
    (document.querySelector('.m-link') as HTMLAnchorElement).click();
    expect(ui.platform.hooks.chatLinks.at(-1)).toContain('example.com/benchmarks');
    // Thread.
    (document.querySelector('.thread-link') as HTMLButtonElement).click();
    await until(() => document.querySelector('#thread .th-root') !== null, 'the thread');
    expect(document.querySelectorAll('#thread .msg-list li.msg')).toHaveLength(4);
    expect(ui.$('#thread .following')).not.toBeNull();
    const handle = ui.$('.th-resize');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(handle.getAttribute('aria-valuenow')).toBe('404');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    ui.key({ key: 'Escape' });
    expect(document.querySelector('#thread')).toBeNull();
    // Roving focus between messages, Enter on a root opens its thread.
    const items = [...document.querySelectorAll<HTMLElement>('#msg-list li.msg')];
    items[items.length - 1].focus();
    items[items.length - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const root = document.querySelector<HTMLElement>('#msg-list li.msg:has(.thread-link)') as HTMLElement;
    root.focus();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => document.querySelector('#thread') !== null, 'the thread again');
    ui.$<HTMLButtonElement>('#thread-close').click();
    // Context menu: Copy text / Copy link / Open thread.
    root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const menu = document.querySelector('.ctx-menu') as HTMLElement;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['Copy text', 'Copy link', '3 replies, open thread', 'Add reaction']);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    (menu.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click();
    await until(() => ui.platform.hooks.copied.length > 0, 'the copied link');
    expect(ui.platform.hooks.copied.at(-1)).toContain(`chat=${ENVELOPE}&message=`);
    root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    (document.querySelector('.ctx-menu') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.ctx-menu')).toBeNull();
    // Alt+↓ next conversation, Alt+Shift+↓ next unread, Ctrl+[ back, Ctrl+] forward, Ctrl+J jump to unread.
    ui.key({ key: 'ArrowDown', altKey: true });
    await until(() => ui.shell.chat.openUuid() !== ENVELOPE, 'the next conversation');
    const second = ui.shell.chat.openUuid();
    ui.key({ key: '[', ctrlKey: true });
    await until(() => ui.shell.chat.openUuid() === ENVELOPE, 'back');
    ui.key({ key: ']', ctrlKey: true });
    await until(() => ui.shell.chat.openUuid() === second, 'forward');
    ui.key({ key: 'j', ctrlKey: true });
    await until(() => ui.shell.chat.openUuid() === MAYA, 'the unread DM');
    ui.key({ key: 'ArrowUp', altKey: true, shiftKey: true });
    // Esc: mark read and leave.
    ui.key({ key: 'Escape' });
    await until(() => ui.shell.chat.openUuid() === null, 'leaving');
    // The home view replaces "Pick a conversation": unread, mentions and recent, one tab stop, ↑ ↓ between rows.
    expect(ui.$('#chat-home').hidden).toBe(false);
    expect(ui.$('#msg-scroll').hidden).toBe(true);
    expect(ui.$('#chat-home h1').textContent).toBe('Home');
    expect([...document.querySelectorAll('#chat-home h2')].map((node) => node.textContent)).toEqual(expect.arrayContaining(['Unread', 'Mentions', 'Recent']));
    expect(ui.$('#chat-home-link').getAttribute('aria-current')).toBe('page');
    const homeRows = [...document.querySelectorAll<HTMLElement>('#chat-home .hm-row')];
    expect(homeRows.length).toBeGreaterThan(1);
    expect(homeRows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    homeRows[0].focus();
    homeRows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(homeRows[1]);
    expect(homeRows[1].tabIndex).toBe(0);
    // Reopened from memory at once: the whole history is loaded, so the start of the conversation shows.
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    expect(document.querySelector('#msg-list li.msg')).not.toBeNull();
    expect(document.querySelector('.conv-start')?.textContent).toContain('This is the start of envelope-v2.');
    ui.$('#msg-scroll').dispatchEvent(new Event('scroll'));
  });

  it('applies hints: new messages arrive with a pill when scrolled up, threads refresh', async () => {
    const ui = await connected();
    await inOrg(ui);
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => document.querySelector('#msg-list li.msg') !== null, 'the messages');
    const count = document.querySelectorAll('#msg-list li.msg').length;
    // Scrolled up (happy-dom has no layout: pretend).
    Object.defineProperty(ui.$('#msg-scroll'), 'scrollHeight', { configurable: true, value: 5000 });
    ui.$('#msg-scroll').scrollTop = 0;
    ui.$('#msg-scroll').dispatchEvent(new Event('scroll'));
    await env.control('chat/post', { conversation: ENVELOPE, text: 'Fresh news' });
    ui.platform.hooks.chatHint({ kind: 'message', conversationUuid: ENVELOPE, messageId: 9999, body: 'ignored' });
    await until(() => document.querySelectorAll('#msg-list li.msg').length > count, 'the new message');
    expect(ui.$('#new-pill').hidden).toBe(false);
    expect(ui.$('#new-pill').textContent).toContain('1 new message');
    ui.$<HTMLButtonElement>('#new-pill').click();
    expect(ui.$('#new-pill').hidden).toBe(true);
    (document.querySelector('.thread-link') as HTMLButtonElement).click();
    await until(() => document.querySelector('#thread .th-root') !== null, 'the thread');
    await env.control('chat/post', { conversation: ENVELOPE, text: 'Reply', thread: true });
    const root = document.querySelector('#thread .th-root li.msg') as HTMLElement;
    ui.platform.hooks.chatHint({ kind: 'thread', conversationUuid: ENVELOPE, rootUuid: root.dataset.uuid });
    await until(() => document.querySelectorAll('#thread .msg-list li.msg').length === 5, 'the new reply');
    ui.platform.hooks.chatHint({ kind: 'nonsense' });
    ui.platform.hooks.chatHint({ kind: 'message_updated', conversationUuid: ENVELOPE, messageUuid: root.dataset.uuid });
  });

  it('switches organizations: rail tiles, dropdown, stop-and-switch with a running timer (Q4)', async () => {
    const ui = await connected();
    await inOrg(ui);
    expect(JSON.parse(localStorage.getItem(SHELL_KEY) ?? '{}').context).toBe(ORG);
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    // Start a timer in Time, come back, switch: the prompt asks first. Cancel keeps both.
    ui.shell.show('time');
    // The time API follows the organization (X-Beacon-Context, BD-3a): its tasks reload first.
    expect(ui.app.context).toBe(ORG);
    await until(() => !ui.app.busy, 'the time module to reload');
    (ui.root.querySelector('[data-task="T-104"] .row-action') as HTMLButtonElement).click();
    await until(() => ui.app.state.activeTimer !== null, 'the timer');
    expect(ui.$('#timer-pill').classList.contains('running')).toBe(true);
    ui.shell.show('chat');
    const harbor = document.querySelectorAll<HTMLButtonElement>('.ctx-tile')[2];
    harbor.click();
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the prompt');
    expect(ui.$('#shell-confirm-title').textContent).toBe('Stop the timer in Lumen Works and switch?');
    ui.$<HTMLButtonElement>('#confirm-cancel').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ui.shell.context).toBe(ORG);
    expect(ui.app.state.activeTimer).not.toBeNull();
    harbor.click();
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the prompt');
    ui.$<HTMLButtonElement>('#confirm-stop-switch').click();
    await until(() => ui.shell.context !== ORG, 'the switch');
    expect(ui.app.state.activeTimer).toBeNull();
    // Back to Lumen Works: its last conversation reopens.
    ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
    await until(() => ui.shell.chat.openUuid() === ENVELOPE, 'the last conversation');
    // Dropdown mode.
    ui.shell.prefs.switcher = 'dropdown';
    ui.shell.renderChrome();
    expect(document.querySelector('.ctx-tile')).toBeNull();
    ui.$<HTMLButtonElement>('#ctx-dropdown').click();
    const items = [...document.querySelectorAll<HTMLElement>('.ctx-menu [role="menuitem"]')];
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Personal', '✓ Lumen Works', 'Harbor Studio']);
    items[0].click();
    await until(() => ui.shell.context === 'personal', 'personal');
    await ui.shell.switchContext('personal');
    await ui.shell.switchContext('org:none');
  });

  it('quick switcher: fuzzy, recent first, keyboard, opens the conversation', async () => {
    const ui = await connected();
    await inOrg(ui);
    ui.key({ key: 'k', ctrlKey: true });
    const dialog = ui.$<HTMLDialogElement>('#switcher');
    expect(dialog.open).toBe(true);
    const input = ui.$<HTMLInputElement>('#sw-input');
    input.value = 'zzzz';
    input.dispatchEvent(new Event('input'));
    expect(ui.$('.sw-empty')).not.toBeNull();
    input.value = 'maya';
    input.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('#sw-list .opt')).toHaveLength(1);
    expect(input.getAttribute('aria-activedescendant')).toBe('sw-0');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(document.querySelector('#sw-list .opt[aria-selected="true"]')).not.toBeNull();
    (document.querySelectorAll('#sw-list .opt')[0] as HTMLElement).dispatchEvent(new MouseEvent('mousemove'));
    input.value = 'env';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await until(() => ui.shell.chat.openUuid() !== null, 'the conversation');
    expect(dialog.open).toBe(false);
    ui.$<HTMLButtonElement>('#tb-search').click();
    expect(dialog.open).toBe(true);
    expect(document.querySelector('#sw-list .opt .o-t')?.textContent).toBe('envelope-v2');
    ui.key({ key: 'k', ctrlKey: true });
    expect(dialog.open).toBe(false);
    ui.$<HTMLButtonElement>('#chat-search').click();
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (document.querySelectorAll('#sw-list .opt')[0] as HTMLElement).click();
  });

  it('settings: theme, density, switcher, timer placement, disconnect; the shortcut sheet', async () => {
    const ui = await connected('es');
    ui.key({ key: ',', ctrlKey: true });
    const dialog = ui.$<HTMLDialogElement>('#shell-settings');
    expect(dialog.open).toBe(true);
    expect(ui.$('#shell-settings-title').textContent).toBe('Ajustes');
    const pick = (label: string, value: string) => (document.querySelector(`#shell-settings [aria-label="${label}"] [data-value="${value}"]`) as HTMLButtonElement).click();
    pick('Densidad de la barra lateral', 'compact');
    expect(ui.shell.root.dataset.density).toBe('compact');
    pick('Selector de organización', 'dropdown');
    expect(ui.shell.prefs.switcher).toBe('dropdown');
    pick('Temporizador en marcha', 'title-sidebar');
    expect(ui.shell.root.dataset.timer).toBe('title-sidebar');
    // Theme: one control only (the Time module's native radios, in Appearance; UXA-2).
    expect(document.querySelectorAll('#shell-settings #theme')).toHaveLength(1);
    const theme = (value: string) => {
      const radio = document.querySelector(`#shell-settings #theme-${value}`) as HTMLInputElement;
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    };
    theme('dark');
    await until(() => document.documentElement.getAttribute('data-theme') === 'dark', 'dark');
    theme('system');
    await until(() => ui.app.state.settings.theme === 'system', 'system');
    expect(JSON.parse(localStorage.getItem(SHELL_KEY) ?? '{}')).toMatchObject({ density: 'compact', switcher: 'dropdown', timer: 'title-sidebar' });
    // Disconnect (Account) asks first (UXA-8).
    ui.$<HTMLButtonElement>('#chat-disconnect').click();
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the confirmation');
    ui.$<HTMLButtonElement>('#confirm-ok').click();
    await until(() => !ui.shell.chat.connected, 'disconnected');
    expect(ui.platform.hooks.chatToken).toBeNull();
    expect(ui.platform.hooks.badge).toBe(0);
    expect(ui.app.state.session).not.toBeNull();
    ui.$<HTMLButtonElement>('#settings-close').click();
    ui.$<HTMLButtonElement>('#tb-theme').click();
    ui.$<HTMLButtonElement>('#tb-help').click();
    expect(ui.$<HTMLDialogElement>('#shell-keys').open).toBe(true);
    expect(ui.$('#shell-keys-title').textContent).toBe('Atajos de teclado');
    ui.$<HTMLButtonElement>('#keys-close').click();
    ui.key({ key: '?' });
    expect(ui.$<HTMLDialogElement>('#shell-keys').open).toBe(true);
    ui.$<HTMLDialogElement>('#shell-keys').close();
    ui.$<HTMLButtonElement>('#rail-settings').click();
    expect(document.querySelector('#settings-chat-connect')?.textContent).toBe('Conectar chat');
    (document.querySelector('#settings-chat-connect') as HTMLButtonElement).click();
    await until(() => ui.$('#chat-user-code') !== null, 'the code');
  });

  it('disconnect and sign-out revoke the chat token on the server first and forget the last conversations (ZBZ-L4, I3)', async () => {
    const ui = await connected();
    await inOrg(ui);
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => document.querySelector('#msg-list li.msg') !== null, 'the messages');
    expect(JSON.parse(localStorage.getItem('beacon-desktop-chat-view') ?? '{}').lastConversation[ORG]).toBe(ENVELOPE);
    // "No chat token for this URL" from the stream is not a refusal: chat stays connected (ZBZ-I2).
    ui.platform.hooks.chatMode('stopped');
    expect(ui.shell.chat.connected).toBe(true);
    await ui.shell.chat.disconnect();
    expect(((await env.control('chat/state')) as { logouts: number }).logouts).toBe(1);
    expect(JSON.parse(localStorage.getItem('beacon-desktop-chat-view') ?? '{}').lastConversation).toEqual({});
    // Connect again, then sign out: the chat token is revoked before the local delete, and an old server (404) or no
    // answer never blocks it.
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the code');
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
    await until(() => ui.$('.side .conv') !== null, 'the conversations');
    await ui.app.logout();
    expect(((await env.control('chat/state')) as { logouts: number }).logouts).toBe(2);
    expect(ui.platform.hooks.chatToken).toBeNull();
    expect(JSON.parse(localStorage.getItem('beacon-desktop-chat-view') ?? '{}').lastConversation).toEqual({});
  });

  it('falls back to Personal once after a 403 and never remembers the refused context', async () => {
    localStorage.setItem(SHELL_KEY, JSON.stringify({ context: 'org:gone' }));
    const ui = await connected();
    expect(ui.shell.context).toBe('personal');
    expect(JSON.parse(localStorage.getItem(SHELL_KEY) ?? '{}').context).toBe('personal');
    const before = ((await env.control('state')) as { requests: { path: string; context?: string | null }[] }).requests.filter((item) => item.context === 'org:gone' && item.path.startsWith('/api/chat/'));
    expect(before.map((item) => item.path)).toEqual(['/api/chat/v1/me']);
    // The time API started in the remembered context and follows the chat's fallback (BD-3a).
    expect(ui.app.context).toBe('personal');
    // A list refused for an organization: Personal once, no loop, not remembered.
    await inOrg(ui);
    await ui.shell.chat.switchContext('org:revoked');
    expect(ui.shell.context).toBe('personal');
    const refused = ((await env.control('state')) as { requests: { path: string; context?: string | null }[] }).requests.filter((item) => item.context === 'org:revoked');
    expect(refused).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(SHELL_KEY) ?? '{}').context).toBe('personal');
    // Asked for it again: no request, never a second fallback loop.
    await ui.shell.chat.switchContext('org:revoked', false);
    expect(ui.$('#chat-banner').hidden).toBe(false);
  });

  it('a revoked chat token disconnects chat only; sign-out forgets everything', async () => {
    const ui = await connected();
    await inOrg(ui);
    ui.platform.hooks.chatMode('unauthorized');
    await until(() => !ui.shell.chat.connected, 'disconnected');
    expect(ui.$('.cc-error').textContent).toContain('disconnected');
    expect(ui.app.state.session).not.toBeNull();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the code');
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
    await until(() => ui.$('.side .conv') !== null, 'the conversations');
    await ui.app.logout();
    await until(() => ui.shell.root.dataset.bare === 'true', 'signed out');
    expect(ui.shell.chat.connected).toBe(false);
    expect(ui.platform.hooks.chatToken).toBeNull();
    expect(ui.shell.contexts).toEqual([]);
  });

  it('server errors show a quiet banner with retry; 404 says the conversation is not here', async () => {
    const ui = await connected();
    await env.control('config', { chatFailNext: { status: 500, error: 'oops' } });
    ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
    await until(() => ui.$('#chat-banner').hidden === false, 'the banner');
    ui.$<HTMLButtonElement>('#chat-banner .btn').click();
    await until(() => ui.$(`[data-conv="${ENVELOPE}"]`) !== null, 'the list');
    await env.control('config', { chatFailNext: { status: 404, error: 'not_found' } });
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => ui.$('#chat-banner').textContent?.includes('not available') === true, 'the 404 text');
    // Sections collapse and remember it; unread rows stay visible.
    const toggle = ui.$<HTMLButtonElement>('[data-key="sec-channels"]');
    toggle.click();
    expect(ui.$('[data-key="sec-channels"]').getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('beacon-desktop-chat-view') ?? '{}').collapsed.channels).toBe(true);
    ui.$<HTMLButtonElement>('#chat-jump').click();
    ui.$<HTMLButtonElement>('.ch-back').click();
    await until(() => ui.shell.chat.openUuid() === null, 'back to the list');
  });
});
