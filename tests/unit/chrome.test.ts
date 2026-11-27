// @vitest-environment happy-dom
// UX batch 7: the custom title bar (window buttons, drag region, bare bar while signed out), the update pill and its
// panel, the tray's "Quick add task…" and the title bar keeping the focus across renders.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform, chromeMode, type ChromeMode } from '../../src/platform';
import { Shell } from '../../src/shell/shell';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
vi.setConfig({ testTimeout: 30_000 });
const UPDATE = { version: '0.5.0', notes: '### Added\n- A pill in the title bar', pub_date: '2026-11-27T10:00:00Z', url: 'u', signature: 's' };
const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

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

/** The shell wired as main.ts does (update pill, tray tasks). */
function mount(mode: ChromeMode = 'custom', locale: 'en' | 'es' = 'en') {
  document.body.replaceChildren();
  delete document.documentElement.dataset.chrome;
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.4.0', nodeFetch);
  platform.hooks.chrome.mode = mode;
  const shell = new Shell(root, platform, { locale, storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, {
    storage: localStorage,
    locale,
    onRender: () => shell.onAppRender(),
    beforeSignOut: () => shell.chat.revokeOnServer(),
    trayChat: () => shell.trayChat(),
    trayTasks: () => shell.trayTasks(),
    updateInShell: true,
    showUpdate: () => shell.openUpdate(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
  });
  shell.attach(app);
  shell.freshSignIn = true;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  return { root, platform, shell, app, $ };
}

async function signedIn(mode: ChromeMode = 'custom', locale: 'en' | 'es' = 'en') {
  const ui = mount(mode, locale);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
  await done;
  await until(() => ui.shell.root.dataset.bare === 'false', 'the shell');
  return ui;
}

beforeEach(async () => {
  localStorage.clear();
  await env.control('reset', {});
  await env.control('config', { deviceInterval: 1 });
});

describe('window chrome (UXA-45)', () => {
  it('parses the chrome mode safely', () => {
    expect(chromeMode('custom')).toBe('custom');
    expect(chromeMode('overlay')).toBe('overlay');
    for (const other of ['native', 'CUSTOM', '', null, undefined, 1, {}]) expect(chromeMode(other)).toBe('native');
  });

  it('custom: drag region, labelled window buttons in platform order, maximise / restore, close hides to the tray', async () => {
    const ui = mount('custom');
    await until(() => document.documentElement.dataset.chrome === 'custom', 'the chrome mode');
    const bar = ui.$('#titlebar');
    expect(bar.getAttribute('data-tauri-drag-region')).toBe('deep');
    const group = ui.$('#win-controls');
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Window');
    // Right edge, after the title bar's own content, in the order Windows and GNOME / KDE use.
    expect(bar.lastElementChild).toBe(group);
    expect([...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Minimize', 'Maximize', 'Close']);
    expect([...group.querySelectorAll('button')].every((b) => b.getAttribute('type') === 'button')).toBe(true);
    expect(ui.$('#wc-close').title).toBe('Close (Beacon Desktop keeps running in the tray)');
    ui.$<HTMLButtonElement>('#wc-maximize').click();
    await until(() => ui.$('#wc-maximize').getAttribute('aria-label') === 'Restore', 'Restore');
    expect(group.dataset.maximized).toBe('true');
    ui.$<HTMLButtonElement>('#wc-maximize').click();
    await until(() => ui.$('#wc-maximize').getAttribute('aria-label') === 'Maximize', 'Maximize');
    ui.$<HTMLButtonElement>('#wc-minimize').click();
    ui.$<HTMLButtonElement>('#wc-close').click();
    await until(() => ui.platform.hooks.chrome.calls.length === 4, 'the calls');
    expect(ui.platform.hooks.chrome.calls).toEqual(['toggle-maximize', 'toggle-maximize', 'minimize', 'close']);
  });

  it('follows a maximise from elsewhere (double click on the bar, a snap)', async () => {
    const ui = mount('custom');
    await until(() => ui.$('#wc-maximize') !== null, 'the buttons');
    await ui.platform.chrome?.toggleMaximize();
    expect(ui.$('#wc-maximize').getAttribute('aria-label')).toBe('Restore');
  });

  it('signed out: a bare bar with the brand and the window buttons only', async () => {
    const ui = mount('custom');
    await ui.app.init();
    await until(() => ui.$('#win-controls') !== null, 'the buttons');
    expect(ui.shell.root.dataset.bare).toBe('true');
    const main = ui.$('.tb-main');
    expect(main.querySelector('.brand')?.textContent).toBe('Beacon Desktop');
    expect(main.querySelector('#tb-search, #timer-pill, #tb-theme')).toBeNull();
  });

  it('signed in: the buttons stay (and keep the focus) while the bar is rebuilt', async () => {
    const ui = await signedIn('custom');
    const close = ui.$<HTMLButtonElement>('#wc-close');
    close.focus();
    ui.app.render();
    expect(ui.$('#wc-close')).toBe(close);
    expect(document.activeElement).toBe(close);
    // The bar's own tools keep the focus too (UXA-28 neighbour): the theme button is rebuilt, focus follows its id.
    ui.$<HTMLButtonElement>('#tb-theme').focus();
    ui.app.render();
    expect(document.activeElement?.id).toBe('tb-theme');
  });

  it('macOS overlay: drag region, no buttons (the traffic lights are the system\'s); native: neither', async () => {
    const mac = mount('overlay');
    await until(() => document.documentElement.dataset.chrome === 'overlay', 'overlay');
    expect(mac.$('#titlebar').getAttribute('data-tauri-drag-region')).toBe('deep');
    expect(mac.$('#win-controls')).toBeNull();
    const native = mount('native');
    await until(() => document.documentElement.dataset.chrome === 'native', 'native');
    expect(native.$('#titlebar').hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(native.$('#win-controls')).toBeNull();
  });

  it('Spanish labels', async () => {
    const ui = mount('custom', 'es');
    await until(() => ui.$('#win-controls') !== null, 'the buttons');
    expect([...ui.$('#win-controls').querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Minimizar', 'Maximizar', 'Cerrar']);
    expect(ui.$('#win-controls').getAttribute('aria-label')).toBe('Ventana');
  });
});

describe('update pill (UXA-22)', () => {
  it('shows the offer as a pill instead of a card; the panel holds the same card, Later hides both', async () => {
    const ui = await signedIn();
    expect(ui.$('#tb-update')).toBeNull();
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    // No card above the task list any more.
    expect(ui.shell.timeRoot.querySelector('#update')).toBeNull();
    const pill = ui.$('#tb-update');
    expect(pill.textContent).toBe('Update');
    expect(pill.getAttribute('aria-label')).toBe('Update to version 0.5.0');
    expect(pill.getAttribute('aria-haspopup')).toBe('dialog');
    expect(pill.getAttribute('aria-controls')).toBe('update-pop');
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    pill.click();
    expect(ui.shell.updateOpen()).toBe(true);
    expect(ui.$('#tb-update').getAttribute('aria-expanded')).toBe('true');
    const pop = ui.$('#update-pop');
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(pop.getAttribute('aria-labelledby')).toBe('update-title');
    expect(pop.querySelector('#update-title')?.textContent).toBe('Version 0.5.0 is available');
    expect(document.activeElement?.id).toBe('update-now');
    ui.$<HTMLButtonElement>('#update-notes-toggle').click();
    expect(ui.$('#update-notes').textContent).toBe(UPDATE.notes);
    // Escape closes it and gives the focus back to the pill.
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(ui.shell.updateOpen()).toBe(false);
    expect(document.activeElement?.id).toBe('tb-update');
    ui.$<HTMLButtonElement>('#tb-update').click();
    ui.$<HTMLButtonElement>('#update-later').click();
    expect(ui.shell.updateOpen()).toBe(false);
    expect(ui.$('#tb-update')).toBeNull();
  });

  it('the pill follows the install: progress, then restarting; a running timer is asked about first', async () => {
    const ui = await signedIn();
    await ui.app.start(ui.app.tasks[0]);
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    ui.$<HTMLButtonElement>('#tb-update').click();
    ui.$<HTMLButtonElement>('#update-now').click();
    expect(document.activeElement?.id).toBe('update-after-stop');
    ui.$<HTMLButtonElement>('#update-after-stop').click();
    expect(ui.$('#tb-update').textContent).toBe('Update after stop');
    expect(ui.$('#tb-update').getAttribute('aria-label')).toBe('Update after stop: version 0.5.0 installs when you stop the timer');
    // Slow fake download: each progress step is its own render.
    ui.platform.hooks.installStepMs = 20;
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const text = document.querySelector('#tb-update')?.textContent;
      if (text !== undefined && seen.at(-1) !== text) seen.push(text);
    });
    observer.observe(ui.$('#titlebar'), { childList: true, subtree: true, characterData: true });
    await ui.app.stop();
    await until(() => ui.platform.hooks.installed === 1, 'the install');
    observer.disconnect();
    expect(seen).toContain('Updating 50%');
    expect(seen.at(-1)).toBe('Restarting…');
    expect(ui.$('#tb-update').dataset.stage).toBe('installing');
  });

  it('a manual check (tray "Check for updates…") opens the panel; a failed install leaves the non-blocking message', async () => {
    const ui = await signedIn();
    await env.control('config', { update: UPDATE });
    ui.platform.hooks.trayAction('check-updates');
    await until(() => ui.shell.updateOpen(), 'the panel');
    expect(document.activeElement?.id).toBe('update-now');
    ui.platform.hooks.installError = 'signature verification failed';
    ui.$<HTMLButtonElement>('#update-now').click();
    await until(() => ui.$('#update-message') !== null, 'the message');
    expect(ui.shell.updateOpen()).toBe(false);
    expect(ui.$('#tb-update')).toBeNull();
    expect(ui.$('#update-message').textContent).toContain('The automatic update failed: signature verification failed.');
  });

  it('the forced update keeps its screen (non-trapping), never the pill', async () => {
    const ui = await signedIn();
    await env.control('config', { update: { ...UPDATE, min_supported_version: '0.5.0' } });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('update-required');
    expect(ui.$('#update-required').getAttribute('role')).toBe('alertdialog');
    expect(ui.$('#remind-later')).not.toBeNull();
    expect(ui.$('#tb-update')).toBeNull();
    ui.shell.openUpdate();
    expect(ui.shell.updateOpen()).toBe(false);
  });

  it('Spanish pill', async () => {
    const ui = await signedIn('custom', 'es');
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    expect(ui.$('#tb-update').textContent).toBe('Actualizar');
    expect(ui.$('#tb-update').getAttribute('aria-label')).toBe('Actualizar a la versión 0.5.0');
  });
});

describe('tray (UXA-41)', () => {
  it('"Quick add task…" only while tasks are connected; it opens Tasks with quick add focused', async () => {
    await env.control('config', { contextPolicy: { required: false, refuse: [] } });
    const ui = await signedIn();
    await ui.app.updateTray();
    expect(ui.platform.hooks.trayMenu?.tasks).toEqual([]);
    await until(() => document.querySelector(`.ctx-tile[data-context="${ORG}"]`) !== null, 'the organization tiles');
    ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
    await until(() => ui.shell.context === ORG, 'the organization');
    ui.$<HTMLButtonElement>('#tab-tasks').click();
    ui.$<HTMLButtonElement>('#tasks-connect').click();
    await until(() => ui.$('#tasks-user-code') !== null, 'the tasks code');
    await env.control('device/approve', { userCode: ui.$('#tasks-user-code').textContent });
    await until(() => ui.$('#tasks-mine .row') !== null, 'My tasks');
    await ui.app.updateTray();
    expect(ui.platform.hooks.trayMenu?.tasks).toEqual([{ id: 'quick-add-task', label: 'Quick add task…' }]);
    ui.$<HTMLButtonElement>('#tab-chat').click();
    expect(ui.shell.module).toBe('chat');
    ui.platform.hooks.trayAction('quick-add-task');
    expect(ui.shell.module).toBe('tasks');
    expect(document.activeElement?.id).toBe('qa-input');
  });
});
