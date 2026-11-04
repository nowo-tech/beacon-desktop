// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { type Channel, DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock } from './helpers';

/** 0.4.0 updater UX: update card, "after I stop", forced update (updater minimum and GET me), Store channel. */
let env: Awaited<ReturnType<typeof startMock>>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const UPDATE = { version: '0.5.0', notes: '### Added\n- Calmer update card', pub_date: '2026-11-04T10:00:00Z', url: 'u', signature: 's' };

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

function mount(options: { locale?: 'en' | 'es'; channel?: Channel; storeUrl?: string; version?: string } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform(options.version ?? '0.4.0', nodeFetch);
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale: options.locale ?? 'en',
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
    channel: options.channel,
    storeUrl: options.storeUrl,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  return { app, platform, root, $, click: (selector: string) => $(selector).click() };
}

async function signedIn(options: Parameters<typeof mount>[0] = {}) {
  const ui = mount(options);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await tick();
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent ?? '' });
  await done;
  expect(ui.app.view).toBe('main');
  return ui;
}

async function startFirstTask(ui: Awaited<ReturnType<typeof signedIn>>) {
  await ui.app.start(ui.app.tasks[0]);
  expect(ui.app.state.activeTimer).not.toBeNull();
}

describe('updates (0.4.0)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('shows a calm card with the mascot, release notes, Update now and Later', async () => {
    const ui = await signedIn();
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    const card = ui.$('#update');
    expect(card.getAttribute('role')).toBe('region');
    expect(card.getAttribute('aria-labelledby')).toBe('update-title');
    expect(ui.$('#update-title').textContent).toBe('Version 0.5.0 is available');
    expect(card.querySelector('img.mascot')).not.toBeNull();
    // Calm: the same moss / mist card as "Still there?", never the alert styles.
    expect(card.className).toContain('still-there');
    expect(card.querySelector('.danger, .error, .alert')).toBeNull();
    const toggle = ui.$('#update-notes-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(ui.$('#update-notes')).toBeNull();
    ui.click('#update-notes-toggle');
    expect(ui.$('#update-notes-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(ui.$('#update-notes').textContent).toBe(UPDATE.notes);
    ui.click('#update-later');
    expect(ui.$('#update')).toBeNull();
    // The 6-hour check keeps it hidden; a manual check brings it back.
    await ui.app.checkUpdates();
    expect(ui.$('#update')).toBeNull();
    await ui.app.checkUpdates(true);
    expect(ui.$('#update')).not.toBeNull();
    expect(ui.$('#notice').textContent).toBe('Version 0.5.0 is available.');
  });

  it('downloads with progress, then installs (the app relaunches)', async () => {
    const ui = await signedIn();
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    const seen: string[] = [];
    ui.platform.hooks.installSteps = [
      { phase: 'downloading', downloaded: 0, total: null },
      { phase: 'downloading', downloaded: 250, total: 1000 },
      { phase: 'installing' },
    ];
    const install = ui.platform.installUpdate.bind(ui.platform);
    ui.platform.installUpdate = async (server, token, onProgress) =>
      install(server, token, (progress) => {
        onProgress?.(progress);
        seen.push(ui.$('#update-progress-label').textContent ?? '');
      });
    ui.click('#update-now');
    await tick();
    expect(seen).toEqual(['Downloading version 0.5.0…', 'Downloading version 0.5.0… 25%', 'Installing version 0.5.0. TimeTrack will restart.']);
    expect(ui.platform.hooks.installed).toBe(1);
    expect(ui.$<HTMLProgressElement>('#update-progress').value).toBe(100);
    expect(ui.$('#live').textContent).toBe('Installing version 0.5.0. TimeTrack will restart.');
    // No second check or install while it installs.
    await ui.app.checkUpdates(true);
    await ui.app.installUpdate();
    expect(ui.platform.hooks.installed).toBe(1);
    expect(ui.app.updatePercent()).toBe(25);
  });

  it('never updates a running timer without asking: "After I stop" installs once stopped', async () => {
    const ui = await signedIn();
    await startFirstTask(ui);
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    ui.click('#update-now');
    expect(ui.platform.hooks.installed).toBe(0);
    expect(ui.app.updateStage).toBe('confirm-running');
    expect(ui.$('#update-running').textContent).toContain(`A timer is running on ${ui.app.state.activeTimer?.taskTitle}`);
    expect(document.activeElement?.id).toBe('update-after-stop');
    ui.click('#update-cancel');
    expect(ui.app.updateStage).toBe('offer');
    expect(document.activeElement?.id).toBe('update-now');
    ui.click('#update-now');
    ui.click('#update-after-stop');
    expect(ui.$('#update-waiting').textContent).toBe('TimeTrack will update when you stop the timer.');
    expect(ui.$('#live').textContent).toBe('TimeTrack will update when you stop the timer.');
    // A periodic check does not reset the choice.
    await ui.app.checkUpdates();
    expect(ui.app.updateStage).toBe('after-stop');
    expect(ui.platform.hooks.installed).toBe(0);
    await ui.app.stop();
    await tick();
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.platform.hooks.installed).toBe(1);
    expect(ui.app.updateStage).toBe('installing');
  });

  it('"Update now" while running installs only after the explicit choice; a failure is non-blocking', async () => {
    const ui = await signedIn();
    await startFirstTask(ui);
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    ui.click('#update-now');
    ui.platform.hooks.installError = 'signature verification failed';
    ui.click('#update-anyway');
    await tick();
    expect(ui.platform.hooks.installed).toBe(0);
    expect(ui.app.updateStage).toBe('offer');
    expect(ui.$('#update')).toBeNull();
    expect(ui.$('#update-message').textContent).toContain('The automatic update failed: signature verification failed.');
    expect(ui.app.state.activeTimer).not.toBeNull();
  });

  it('"After I stop" with no timer running installs right away; the waiting card offers Update now', async () => {
    const ui = await signedIn();
    await startFirstTask(ui);
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    ui.click('#update-now');
    ui.click('#update-after-stop');
    ui.click('#update-anyway');
    await tick();
    expect(ui.platform.hooks.installed).toBe(1);
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
    localStorage.clear();
    const idle = await signedIn();
    await idle.app.checkUpdates();
    idle.app.update = { version: '0.5.0', min: null, installable: true, notes: null };
    idle.app.updateAfterStop();
    await tick();
    expect(idle.platform.hooks.installed).toBe(1);
  });

  it('forced update from the updater minimum, with a running timer: stop, then update', async () => {
    const ui = await signedIn();
    await startFirstTask(ui);
    const task = ui.app.state.activeTimer?.taskTitle ?? '';
    await env.control('config', { update: { ...UPDATE, min_supported_version: '0.5.0' } });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('update-required');
    expect(ui.$('#update-required').getAttribute('role')).toBe('alertdialog');
    expect(ui.$('#update-required-running').textContent).toContain(`A timer is running on ${task}`);
    ui.click('#stop-then-update');
    await tick();
    await tick();
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.platform.hooks.installed).toBe(1);
    expect(ui.$('#update-progress-label').textContent).toBe('Installing version 0.5.0. TimeTrack will restart.');
  });

  it('forced update from GET me minSupportedVersion (higher than the updater minimum)', async () => {
    const ui = await signedIn();
    await env.control('config', { update: UPDATE, minSupportedVersion: '0.4.5' });
    await ui.app.refresh();
    await tick();
    expect(ui.app.meMinimum).toBe('0.4.5');
    expect(ui.app.view).toBe('update-required');
    expect(ui.$('#update-required-text').textContent).toContain('Version 0.4.5 or later is required.');
    expect(ui.$('#update-required-running')).toBeNull();
    // Remind me later never traps; the next refresh with the same minimum does not ask again.
    ui.click('#remind-later');
    await ui.app.refresh();
    await tick();
    expect(ui.app.view).toBe('main');
    // A minimum above what is offered: Beacon download message, no blocking screen.
    await env.control('config', { minSupportedVersion: '0.9.0' });
    ui.app.updateDismissed = false;
    await ui.app.refresh();
    await tick();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#update-message').textContent).toContain('version 0.9.0 or later');
    // GET me's minimum counts even when the updater sends none.
    await env.control('config', { update: null, minSupportedVersion: null });
    ui.app.meMinimum = '0.6.0';
    await ui.app.checkUpdates(true);
    expect(ui.$('#update-message').textContent).toContain('version 0.6.0 or later');
    expect(ui.$('#notice').textContent).toContain('version 0.6.0 or later');
  });

  it('manual check: tray item, About button, up to date, failure', async () => {
    const ui = await signedIn();
    expect(ui.platform.hooks.trayMenu?.checkUpdates).toBe('Check for updates…');
    ui.app.show('settings');
    await ui.platform.hooks.trayAction('check-updates');
    await tick();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#notice').textContent).toBe('TimeTrack 0.4.0 is up to date.');
    ui.app.show('settings');
    expect(ui.$('#update-status').textContent).toBe('TimeTrack 0.4.0 is up to date.');
    ui.platform.checkUpdate = async () => {
      throw new Error('offline');
    };
    ui.click('#check-updates');
    await tick();
    expect(ui.$('#update-status').textContent).toBe('Could not check for updates right now. Try again later.');
    ui.platform.checkUpdate = async () => ({ status: 'error', message: 'HTTP 500' });
    ui.app.updateStatus = null;
    await ui.app.checkUpdates(true);
    expect(ui.app.updateStatus).toBe('Could not check for updates right now. Try again later.');
    ui.platform.checkUpdate = async () => ({ status: 'disabled' });
    await ui.app.checkUpdates();
    expect(ui.app.update).toBeNull();
  });

  it('concurrent automatic checks share one request', async () => {
    const ui = await signedIn();
    let calls = 0;
    const check = ui.platform.checkUpdate.bind(ui.platform);
    ui.platform.checkUpdate = async (server, token) => {
      calls += 1;
      return check(server, token);
    };
    await Promise.all([ui.app.checkUpdates(), ui.app.checkUpdates(), ui.app.checkUpdates()]);
    expect(calls).toBe(1);
    await ui.app.checkUpdates(true);
    expect(calls).toBe(2);
  });

  it('Store channel: no updater calls, no tray item, no autostart; GET me minimum opens the Store', async () => {
    const storeUrl = 'https://apps.microsoft.com/detail/9NTIMETRACK0';
    const ui = await signedIn({ channel: 'store', storeUrl });
    let calls = 0;
    ui.platform.checkUpdate = async () => {
      calls += 1;
      return { status: 'up_to_date' };
    };
    expect(ui.platform.hooks.trayMenu?.checkUpdates).toBeNull();
    ui.app.show('settings');
    expect(ui.$('#check-updates')).toBeNull();
    expect(ui.$('#update-status').textContent).toBe('Updates come from the Microsoft Store.');
    expect(ui.$('#feature-autostart')).toBeNull();
    ui.click('#open-store');
    expect(ui.platform.hooks.opened.at(-1)).toBe(storeUrl);
    await ui.app.checkUpdates(true);
    expect(ui.$('#notice').textContent).toBe('Updates come from the Microsoft Store.');
    await env.control('config', { update: UPDATE, minSupportedVersion: '0.5.0' });
    await ui.app.refresh();
    await tick();
    expect(calls).toBe(0);
    expect(ui.app.view).toBe('update-required');
    expect(ui.$('#update-required-text').textContent).toBe('This version (0.4.0) is no longer supported by your server. Update TimeTrack to version 0.5.0 or later from the Microsoft Store.');
    expect(ui.$('#install-required')).toBeNull();
    expect(ui.$('#download-required')).toBeNull();
    ui.click('#open-store-required');
    expect(ui.platform.hooks.opened.at(-1)).toBe(storeUrl);
    await ui.app.installUpdate();
    expect(ui.platform.hooks.installed).toBe(0);
    ui.click('#remind-later');
    expect(ui.app.view).toBe('main');
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('main');
    await env.control('config', { minSupportedVersion: null });
    await ui.app.refresh();
    await ui.app.checkUpdates();
    expect(ui.app.update).toBeNull();
  });

  it('Store channel without a Store link opens Beacon\'s Apps page', async () => {
    const ui = await signedIn({ channel: 'store', storeUrl: 'http://not-the-store.example.com' });
    ui.app.openStore();
    expect(ui.platform.hooks.opened.at(-1)).toBe(`${env.url}/dashboard/tasks/time/apps`);
  });

  it('speaks Spanish', async () => {
    const ui = await signedIn({ locale: 'es' });
    await startFirstTask(ui);
    await env.control('config', { update: UPDATE });
    await ui.app.checkUpdates();
    expect(ui.$('#update-title').textContent).toBe('La versión 0.5.0 está disponible');
    expect(ui.$('#update-notes-toggle').textContent).toBe('Novedades');
    expect(ui.$('#update-now').textContent).toBe('Actualizar ahora');
    expect(ui.$('#update-later').textContent).toBe('Más tarde');
    ui.click('#update-now');
    expect(ui.$('#update-after-stop').textContent).toBe('Cuando lo pare');
    expect(ui.platform.hooks.trayMenu?.checkUpdates).toBe('Buscar actualizaciones…');
  });
});
