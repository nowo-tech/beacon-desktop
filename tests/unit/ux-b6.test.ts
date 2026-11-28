// @vitest-environment happy-dom
// UX batch 6: Time hosted in the shell (UXA-1, UXA-24, UXA-25), the one Settings with Account (UXA-2, disconnect
// confirm), the guided first run (UXA-4) and the first-run window (UXA-30), against the in-process mock Beacon.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { loadShellPrefs, SHELL_KEY, Shell } from '../../src/shell/shell';
import { DesktopApp } from '../../src/ui/app';
import { loadWindowMemory, placeWindow, WINDOW_KEY } from '../../src/lib/layout';
import { SETTINGS_TAB_KEY } from '../../src/lib/settings';
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

function mount(options: { freshSignIn?: boolean; width?: { value: number }; platform?: ReturnType<typeof browserPlatform>; locale?: 'en' | 'es' } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const locale = options.locale ?? 'en';
  const platform = options.platform ?? browserPlatform('0.1.0', nodeFetch);
  const shell = new Shell(root, platform, { locale, storage: localStorage });
  const width = options.width;
  const app = new DesktopApp(shell.timeRoot, platform, {
    storage: localStorage,
    locale,
    onRender: () => shell.onAppRender(),
    beforeSignOut: () => shell.chat.revokeOnServer(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
    ...(width !== undefined ? { viewportWidth: () => width.value } : {}),
  });
  shell.attach(app);
  shell.freshSignIn = options.freshSignIn ?? true;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  return { root, platform, shell, app, $, key };
}

async function signIn(ui: ReturnType<typeof mount>) {
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
  await done;
  await until(() => ui.shell.root.dataset.bare === 'false', 'the shell');
  return ui;
}

/** A signed-in shell past the setup (as after "Finish later"), on Time. */
async function onTime(width?: { value: number }) {
  localStorage.setItem(SHELL_KEY, JSON.stringify({ module: 'time', setup: 'done' }));
  const ui = await signIn(mount({ width }));
  await until(() => ui.$('#tasks li') !== null, 'the task list');
  expect(ui.shell.module).toBe('time');
  return ui;
}

const prefs = () => JSON.parse(localStorage.getItem(SHELL_KEY) ?? '{}') as Record<string, unknown>;

beforeEach(async () => {
  localStorage.clear();
  await env.control('reset', {});
  await env.control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

describe('preferences and the first-run window (UXA-30)', () => {
  it('parses the setup state and the skipped steps safely', () => {
    localStorage.setItem(SHELL_KEY, JSON.stringify({ setup: 'pending', skipped: ['tasks', 'x', 'chat', 'tasks'] }));
    expect(loadShellPrefs(localStorage)).toMatchObject({ setup: 'pending', skipped: ['chat', 'tasks'] });
    localStorage.setItem(SHELL_KEY, JSON.stringify({ setup: 'bogus', skipped: 'chat' }));
    expect(loadShellPrefs(localStorage)).toMatchObject({ setup: null, skipped: [] });
    expect(loadShellPrefs(undefined)).toMatchObject({ setup: null, skipped: [] });
  });

  it('opens the first window at about 1200 × 780 centred and clamped; saved bounds still win', () => {
    const conf = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')) as { app: { windows: { width: number; height: number; center: boolean; minWidth: number; minHeight: number }[] } };
    expect(conf.app.windows[0]).toMatchObject({ width: 1200, height: 780, center: true, minWidth: 380, minHeight: 560 });
    const memory = loadWindowMemory(localStorage);
    expect(memory.mode).toBe('full');
    const screens = { areas: [{ x: 0, y: 0, width: 1920, height: 1040 }], current: { x: 0, y: 0, width: 1920, height: 1040 }, scale: 1 };
    expect(placeWindow(memory.mode, memory, screens)).toEqual({ x: 360, y: 130, width: 1200, height: 780 });
    // A small laptop work area: clamped, still centred.
    const small = { areas: [{ x: 0, y: 0, width: 1024, height: 700 }], current: { x: 0, y: 0, width: 1024, height: 700 }, scale: 1 };
    expect(placeWindow(memory.mode, memory, small)).toEqual({ x: 0, y: 0, width: 1024, height: 700 });
    localStorage.setItem(WINDOW_KEY, JSON.stringify({ mode: 'compact', bounds: { compact: { x: 10, y: 20, width: 500, height: 600 } } }));
    const saved = loadWindowMemory(localStorage);
    expect(placeWindow(saved.mode, saved, screens)).toEqual({ x: 10, y: 20, width: 500, height: 600 });
  });

  it('remembers the size the window was left at and restores it at the next launch', async () => {
    const ui = await onTime({ value: 1280 });
    ui.platform.hooks.window.bounds = { x: 100, y: 80, width: 1300, height: 820 };
    await ui.app.rememberWindow();
    expect(loadWindowMemory(localStorage)).toMatchObject({ mode: 'full', bounds: { full: { x: 100, y: 80, width: 1300, height: 820 } } });
  });
});

describe('Time hosted in the shell (UXA-1, UXA-24, UXA-25)', () => {
  it('has no header, Compact view toggle or Settings of its own; a sidebar like Chat; Track not Tasks', async () => {
    const width = { value: 1280 };
    const ui = await onTime(width);
    expect(ui.$('#app').classList.contains('no-bar')).toBe(true);
    expect(ui.$<HTMLElement>('#app > .bar').hidden).toBe(true);
    expect(ui.$('#layout-toggle')).toBeNull();
    expect(ui.$('#open-settings')).toBeNull();
    expect(ui.$('#nav-settings')).toBeNull();
    expect(ui.$('#pane-hint')).toBeNull();
    expect([...document.querySelectorAll('header')].filter((header) => !header.hidden && header.closest('[hidden]') === null)).toHaveLength(1);
    expect(ui.$('#time-side-title').textContent).toBe('Time');
    expect(ui.$('#nav-tasks').textContent).toBe('Track');
    expect([...document.querySelectorAll('.rail-tab[role="tab"]')].map((tab) => tab.querySelector('.rt-label')?.textContent)).not.toContain('Track');
    expect(ui.$('#open-beacon')?.closest('.sidebar')).not.toBeNull();
    // Ctrl+Shift+L is not a layout switch here, and the tray has no Compact view item.
    const sets = ui.platform.hooks.window.set.length;
    ui.key({ key: 'L', ctrlKey: true, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ui.platform.hooks.window.set).toHaveLength(sets);
    await ui.app.updateTray();
    expect(ui.platform.hooks.trayMenu?.layout).toBeNull();
  });

  it('collapses the detail pane below 1100 px and brings it back wider', async () => {
    const width = { value: 1280 };
    const ui = await onTime(width);
    expect(ui.$<HTMLElement>('#detail').hidden).toBe(false);
    width.value = 1000;
    ui.app.relayout();
    expect(ui.$<HTMLElement>('#detail').hidden).toBe(true);
    expect(ui.$<HTMLElement>('#sidebar').hidden).toBe(false);
    width.value = 1200;
    ui.app.relayout();
    expect(ui.$<HTMLElement>('#detail').hidden).toBe(false);
  });

  it('rows carry one quiet play icon: one Tab stop, arrows move, S starts, the running row stops', async () => {
    const ui = await onTime({ value: 1280 });
    const plays = () => [...document.querySelectorAll<HTMLButtonElement>('#tasks button.row-action')];
    expect(plays().length).toBeGreaterThan(3);
    expect(plays().every((button) => button.classList.contains('play') && !button.classList.contains('primary'))).toBe(true);
    expect(plays().every((button) => button.textContent === '')).toBe(true);
    const stops = [...document.querySelectorAll<HTMLButtonElement>('#main button.row-action')].filter((button) => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
    stops[0].focus();
    expect(document.activeElement).toBe(stops[0]);
    stops[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const second = document.activeElement as HTMLButtonElement;
    expect(second.outerHTML.slice(0, 120)).toContain('row-action');
    expect(second).not.toBe(stops[0]);
    expect(second.tabIndex).toBe(0);
    expect(stops[0].tabIndex).toBe(-1);
    const task = second.closest('li')?.getAttribute('data-task');
    expect(task).toMatch(/./);
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }));
    await until(() => ui.app.state.activeTimer?.taskId === task, 'the timer');
    // The running task moves to the timer card; the other rows' icons now switch to them.
    await until(() => document.querySelector(`#main li[data-task="${task}"]`) === null, 'the running row in the timer card');
    const other = document.querySelector<HTMLButtonElement>('#main button.row-action') as HTMLButtonElement;
    expect(other.getAttribute('aria-label')).toMatch(/^Switch/);
    expect(other.querySelector('svg')).not.toBeNull();
    await ui.app.stop();
    await until(() => ui.app.state.activeTimer === null, 'the stop');
  });
});

describe('one Settings with Account (UXA-2)', () => {
  it('the gear, Ctrl/⌘+, in Time and the tray open the same dialog; Theme once; Time panels inside', async () => {
    const ui = await onTime();
    ui.$<HTMLButtonElement>('#rail-settings').click();
    const dialog = ui.$<HTMLDialogElement>('#shell-settings');
    expect(dialog.open).toBe(true);
    const tabs = [...dialog.querySelectorAll('[role="tab"]')].map((tab) => tab.id.replace('settings-tab-', ''));
    expect(tabs).toEqual(['general', 'appearance', 'timer', 'shortcuts', 'schedule', 'notifications', 'meetings', 'chat', 'tasks', 'updates', 'account']);
    expect(dialog.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Settings sections');
    expect(document.querySelectorAll('#theme')).toHaveLength(1);
    expect(dialog.querySelector('#settings-panel-appearance #theme')).not.toBeNull();
    expect(dialog.querySelector('#settings-panel-general #theme')).toBeNull();
    expect(dialog.querySelector('#settings-panel-timer #settings-time-tracking')).not.toBeNull();
    expect(dialog.querySelector('#settings-panel-shortcuts #shortcut')).not.toBeNull();
    expect(dialog.querySelectorAll('#logout')).toHaveLength(1);
    expect(dialog.querySelector('#settings-panel-account #logout')).not.toBeNull();
    // Selecting a tab is remembered (same key as before).
    (dialog.querySelector('#settings-tab-meetings') as HTMLButtonElement).click();
    expect(localStorage.getItem(SETTINGS_TAB_KEY)).toBe('meetings');
    dialog.close();
    // Ctrl+, in the Time module: the same dialog, never a Time view.
    ui.key({ key: ',', ctrlKey: true });
    expect(dialog.open).toBe(true);
    expect(ui.app.view).toBe('main');
    expect((dialog.querySelector('#settings-tab-meetings') as HTMLElement).getAttribute('aria-selected')).toBe('true');
    dialog.close();
    await ui.app.trayAction('settings');
    expect(dialog.open).toBe(true);
    // A Time panel follows the app: a theme picked here applies at once and stays the only Theme.
    (dialog.querySelector('#settings-tab-appearance') as HTMLButtonElement).click();
    const dark = dialog.querySelector<HTMLInputElement>('#theme-dark') as HTMLInputElement;
    dark.checked = true;
    dark.dispatchEvent(new Event('change'));
    await until(() => document.documentElement.getAttribute('data-theme') === 'dark', 'the theme');
    expect(document.querySelectorAll('#theme')).toHaveLength(1);
  });

  it('Account: identity, connections, Disconnect asks first (Cancel keeps it), What we collect, Sign out', async () => {
    localStorage.setItem(SHELL_KEY, JSON.stringify({ setup: 'done' }));
    const ui = await signIn(mount());
    ui.$<HTMLButtonElement>('#tab-chat').click();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
    await until(() => ui.shell.chat.connected && ui.$('.side .conv') !== null, 'the conversations');
    ui.shell.openSettings('account');
    const dialog = ui.$<HTMLDialogElement>('#shell-settings');
    const account = dialog.querySelector('#settings-panel-account') as HTMLElement;
    expect(account.textContent).toContain('Signed in as');
    expect(account.querySelector('#account-time .conn-state.on')).not.toBeNull();
    expect(account.querySelector('#account-chat .conn-state.on')).not.toBeNull();
    expect(account.querySelector('#account-tasks .conn-state.on')).toBeNull();
    expect(account.querySelector('#account-tasks-connect')).not.toBeNull();
    // Disconnect: a confirmation first, Cancel focused; Cancel keeps chat.
    (account.querySelector('#chat-disconnect') as HTMLButtonElement).click();
    const confirm = ui.$<HTMLDialogElement>('#shell-confirm');
    await until(() => confirm.open, 'the confirmation');
    expect(confirm.querySelector('h1')?.textContent).toBe('Disconnect chat?');
    expect(document.activeElement?.id).toBe('confirm-cancel');
    ui.$<HTMLButtonElement>('#confirm-cancel').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ui.shell.chat.connected).toBe(true);
    // Confirmed: chat only; time stays signed in.
    (dialog.querySelector('#chat-disconnect') as HTMLButtonElement).click();
    await until(() => confirm.open, 'the confirmation');
    ui.$<HTMLButtonElement>('#confirm-ok').click();
    await until(() => !ui.shell.chat.connected, 'the disconnect');
    expect(ui.app.state.session).not.toBeNull();
    expect(dialog.querySelector('#account-chat .conn-state.on')).toBeNull();
    expect(dialog.querySelector('#account-chat-connect')).not.toBeNull();
    // What we collect: the Time module's page, Settings closed.
    (dialog.querySelector('#open-privacy') as HTMLButtonElement).click();
    expect(dialog.open).toBe(false);
    expect(ui.shell.module).toBe('time');
    expect(ui.app.view).toBe('privacy');
    // Its way back reopens Settings.
    ui.$<HTMLButtonElement>('#back').click();
    expect(ui.app.view).toBe('main');
    expect(dialog.open).toBe(true);
    // Sign out from Account.
    (dialog.querySelector('#settings-tab-account') as HTMLButtonElement).click();
    (dialog.querySelector('#logout') as HTMLButtonElement).click();
    await until(() => ui.app.state.session === null, 'the sign-out');
    expect(dialog.open).toBe(false);
    expect(ui.shell.root.dataset.bare).toBe('true');
  });
});

describe('guided first run (UXA-4)', () => {
  it('chains Chat then Tasks from one card, then lands on Chat', async () => {
    const ui = await signIn(mount());
    await until(() => ui.shell.setupShown, 'the setup');
    expect(ui.$<HTMLElement>('#mod-setup').hidden).toBe(false);
    expect(ui.$<HTMLElement>('#mod-chat').hidden).toBe(true);
    expect(ui.$<HTMLElement>('#mod-time').hidden).toBe(true);
    expect(prefs().setup).toBe('pending');
    expect(document.querySelectorAll('.rail-tab[aria-selected="true"]')).toHaveLength(0);
    expect(ui.$('#setup-step-time').classList.contains('done')).toBe(true);
    expect(ui.$('#setup-step-chat').getAttribute('aria-current')).toBe('step');
    expect(document.activeElement?.id).toBe('setup-connect');
    ui.$<HTMLButtonElement>('#setup-connect').click();
    await until(() => ui.$('#setup-code') !== null, 'the chat code in the card');
    expect(ui.platform.hooks.opened.at(-1)).toContain('/device');
    await env.control('device/approve', { userCode: ui.$('#setup-code').textContent });
    await until(() => ui.$('#setup-step-tasks')?.getAttribute('aria-current') === 'step', 'the tasks step');
    expect(ui.$('#setup-step-chat').classList.contains('done')).toBe(true);
    // 0.14.1 (owner approval 2026-11-28): the Tasks code is asked for as soon as Chat is approved, no click.
    await until(() => ui.$('#setup-code') !== null, 'the tasks code in the card');
    expect(ui.platform.hooks.tasksConnectBegins).toBe(1);
    await env.control('device/approve', { userCode: ui.$('#setup-code').textContent });
    await until(() => !ui.shell.setupShown, 'the end of the setup');
    expect(ui.shell.chat.connected).toBe(true);
    expect(ui.shell.tasks?.connected).toBe(true);
    expect(ui.shell.module).toBe('chat');
    expect(ui.$<HTMLElement>('#mod-chat').hidden).toBe(false);
    expect(ui.$<HTMLElement>('#mod-setup').hidden).toBe(true);
    expect(prefs()).toMatchObject({ setup: 'done', module: 'chat' });
    await until(() => ui.$('#shell-live').textContent === 'Setup finished. Opening chat.', 'the announcement');
  });

  it('skips a step, finishes later, and resumes from Settings → Account', async () => {
    const ui = await signIn(mount({ locale: 'es' }));
    await until(() => ui.shell.setupShown, 'the setup');
    expect(ui.$('#setup-title').textContent).toBe('Configura Beacon Desktop');
    ui.$<HTMLButtonElement>('#setup-skip').click();
    expect(ui.$('#setup-step-chat').classList.contains('skipped')).toBe(true);
    expect(ui.$('#setup-step-tasks').getAttribute('aria-current')).toBe('step');
    expect(prefs().skipped).toEqual(['chat']);
    ui.$<HTMLButtonElement>('#setup-later').click();
    expect(ui.shell.setupShown).toBe(false);
    expect(ui.shell.module).toBe('chat');
    expect(prefs().setup).toBe('done');
    // Nothing nags at the next launch; Settings → Account offers to finish.
    ui.shell.openSettings('account');
    const resume = ui.$<HTMLButtonElement>('#account-finish-setup');
    expect(resume).not.toBeNull();
    resume.click();
    expect(ui.shell.setupShown).toBe(true);
    expect(ui.$('#setup-step-chat').getAttribute('aria-current')).toBe('step');
    // A rail tab leaves the setup too.
    ui.$<HTMLButtonElement>('#tab-time').click();
    expect(ui.shell.setupShown).toBe(false);
    expect(ui.shell.module).toBe('time');
  });

  it('comes back at the next launch when the app quit in the middle; a running timer lands on Time instead', async () => {
    const first = await signIn(mount());
    await until(() => first.shell.setupShown, 'the setup');
    first.app.destroy();
    const again = mount({ freshSignIn: false, platform: first.platform });
    await again.app.init();
    await until(() => again.shell.root.dataset.bare === 'false', 'the shell');
    await until(() => again.shell.setupShown, 'the setup again');
    again.app.destroy();
    // A timer running at launch: Time wins (owner Q1) and the setup waits.
    await again.app.start({ id: 'T-104', title: 'Fix invoice rounding bug' } as never).catch(() => undefined);
    const third = mount({ freshSignIn: false, platform: first.platform });
    await third.app.init();
    await until(() => third.shell.root.dataset.bare === 'false', 'the shell');
    await until(() => third.app.state.activeTimer !== null, 'the timer');
    expect(third.shell.setupShown).toBe(false);
    expect(third.shell.module).toBe('time');
    expect(prefs().setup).toBe('pending');
  });

  it('a sign-in after the setup follows the landing rule (no setup, no forced Time)', async () => {
    localStorage.setItem(SHELL_KEY, JSON.stringify({ setup: 'done', module: 'tasks' }));
    const ui = await signIn(mount());
    await until(() => ui.shell.tasks !== null && ui.$('#tasks-connect') !== null, 'tasks');
    expect(ui.shell.setupShown).toBe(false);
    expect(ui.shell.module).toBe('tasks');
  });
});

describe('one Beacon server (owner decision 2026-11-27)', () => {
  function plainApp(fixedServer: string | undefined, platform = browserPlatform('0.1.0', nodeFetch), locale: 'en' | 'es' = 'en') {
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const app = new DesktopApp(root, platform, { storage: localStorage, locale, sleep: () => new Promise((resolve) => setTimeout(resolve, 5)), searchDelayMs: 1, ...(fixedServer !== undefined ? { fixedServer } : {}) });
    return { app, platform, $: <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T };
  }

  it('release builds: no address field; the sign-in goes to the build server whatever is passed', async () => {
    const ui = plainApp(env.url);
    await ui.app.init();
    expect(ui.$('#server')).toBeNull();
    expect(ui.$('#where')).toBeNull();
    expect(ui.$('#server-fixed').textContent).toContain(new URL(env.url).host);
    expect(ui.$('#connect').textContent).toBe('Sign in with Beacon');
    const done = ui.app.connect('https://beacon.example.com');
    await until(() => ui.$('#user-code') !== null, 'the device code');
    expect(ui.platform.hooks.signInConfirmations).toEqual([env.url]);
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
    await done;
    expect(ui.app.state.session?.server).toBe(env.url);
  });

  it('release builds: a session stored for another server is signed out with a clear message', async () => {
    const first = plainApp(undefined);
    await first.app.init();
    const done = first.app.connect(env.url);
    await until(() => first.$('#user-code') !== null, 'the device code');
    await env.control('device/approve', { userCode: first.$('#user-code').textContent });
    await done;
    first.app.destroy();
    const again = plainApp('https://beacon.nowo.tech', first.platform, 'es');
    await again.app.init();
    expect(again.app.state.session).toBeNull();
    expect(again.app.view).toBe('login');
    expect(again.$('#notice').textContent).toContain('ahora usa siempre beacon.nowo.tech');
    expect(again.$('#notice').textContent).toContain(new URL(env.url).host);
    expect(again.$('#server')).toBeNull();
  });

  it('release builds: a session of the build server keeps working', async () => {
    const first = plainApp(env.url);
    await first.app.init();
    const done = first.app.connect();
    await until(() => first.$('#user-code') !== null, 'the device code');
    await env.control('device/approve', { userCode: first.$('#user-code').textContent });
    await done;
    first.app.destroy();
    const again = plainApp(env.url, first.platform);
    await again.app.init();
    expect(again.app.state.session?.server).toBe(env.url);
    expect(again.app.view).toBe('main');
  });

  it('development and mock builds keep the address field', async () => {
    const ui = plainApp(undefined);
    await ui.app.init();
    expect(ui.$('#server')).not.toBeNull();
    expect(ui.$('#server-fixed')).toBeNull();
  });
});
