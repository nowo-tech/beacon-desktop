// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

function mount(options: { locale?: 'en' | 'es'; fetchImpl?: typeof fetch; now?: () => Date } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.1.0', options.fetchImpl ?? nodeFetch);
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale: options.locale ?? 'en',
    beaconUrl: 'https://beacon.example.com',
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
    now: options.now,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  return { app, platform, root, $, click: (selector: string) => $(selector).click() };
}

async function signedIn(options: Parameters<typeof mount>[0] = {}, server = env.url) {
  const ui = mount(options);
  await ui.app.init();
  const done = ui.app.connect(server);
  await tick();
  const code = ui.$('#user-code').textContent ?? '';
  await env.control('device/approve', { userCode: code });
  await done;
  expect(ui.app.view).toBe('main');
  return ui;
}

describe('desktop app', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('signs in with the device flow: shows the code and opens the verification page', async () => {
    const ui = mount();
    await ui.app.init();
    expect(ui.app.view).toBe('login');
    expect(ui.$<HTMLInputElement>('#server').value).toBe('https://beacon.example.com');
    ui.$<HTMLInputElement>('#server').value = env.url;
    ui.$<HTMLFormElement>('#login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(ui.app.view).toBe('device');
    const code = ui.$('#user-code').textContent ?? '';
    expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(ui.platform.hooks.opened[0]).toContain(`code=${code}`);
    ui.click('#open-again');
    expect(ui.platform.hooks.opened).toHaveLength(2);
    await env.control('device/approve', { userCode: code });
    for (let i = 0; i < 50 && ui.app.view !== 'main'; i++) await tick();
    expect(ui.app.view).toBe('main');
    expect(await ui.platform.secretGet()).toHaveLength(43);
    expect(localStorage.getItem('time-track-desktop')).not.toContain((await ui.platform.secretGet()) ?? 'x');
    expect(ui.root.querySelectorAll('#tasks li')).toHaveLength(8);
  });

  it('reports denied requests, bad URLs and cancel', async () => {
    const ui = mount();
    await ui.app.init();
    await ui.app.connect('http://insecure.example.com');
    expect(ui.$('#server-problem').textContent).toContain('https://');
    expect(ui.$<HTMLInputElement>('#server').value).toBe('http://insecure.example.com');
    expect(ui.$('#server').getAttribute('aria-invalid')).toBe('true');
    const denied = ui.app.connect(env.url);
    await tick();
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent, approve: false });
    await denied;
    expect(ui.app.view).toBe('device');
    expect(ui.$('#device-state').textContent).toBe('The connection was declined in Beacon');
    ui.click('#cancel-device');
    const cancelled = ui.app.connect(env.url);
    await tick();
    ui.click('#cancel-device');
    await cancelled;
    expect(ui.app.view).toBe('login');
    expect(ui.app.error).toBeNull();
    await env.control('config', { failNext: { status: 500, error: 'boom' } });
    await ui.app.connect(env.url);
    expect(ui.$('#error-title').textContent).toBe('Beacon has a problem');
    expect(ui.$('#error').textContent).not.toContain('Simulated');
    expect(ui.$<HTMLInputElement>('#server').value).toBe(env.url);
  });

  it('starts, switches and stops; tray follows; tray stop works', async () => {
    const ui = await signedIn();
    ui.root.querySelector<HTMLElement>('[data-task="T-101"] .row-action')?.click();
    await tick();
    expect(ui.$('#timer-task').textContent).toBe('Write onboarding guide');
    expect(ui.platform.hooks.tray).toEqual({
      title: '0:00 Write onboarding gu…',
      tooltip: 'TimeTrack — Tracking “Write onboarding guide” · 0:00 · Today 0:00',
      status: '● 0:00 · Write onboarding guide',
      running: true,
    });
    expect(ui.platform.hooks.trayMenu?.primary).toEqual({ id: 'stop', label: 'Stop timer' });
    expect(ui.platform.hooks.trayMenu?.openBeacon).toBeNull();
    // The running task is not repeated in the lists.
    expect(ui.root.querySelector('#tasks [data-task="T-101"]')).toBeNull();
    ui.root.querySelector<HTMLElement>('[data-task="T-102"] .row-action')?.click();
    await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    await ui.app.trayAction('stop');
    await tick();
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.platform.hooks.tray.running).toBe(false);
    await ui.app.stop();
    const search = ui.$<HTMLInputElement>('#search');
    search.value = 'invoice';
    search.dispatchEvent(new Event('input'));
    search.dispatchEvent(new Event('input'));
    await tick();
    expect(ui.root.querySelectorAll('#tasks li')).toHaveLength(1);
    await ui.app.search('zzz');
    expect(ui.$('#tasks-empty').textContent).toBe('No tasks match “zzz”. Only tasks you can track time on appear.');
    ui.platform.hooks.shortcutPressed();
    expect(document.activeElement?.id).toBe('search');
    await ui.app.start({ id: 'T-900', title: 'x' });
    expect(ui.$('#error-title').textContent).toBe('You can’t track time on “x”'.replace('’', "'"));
    ui.app.destroy();
  });

  it('queues actions offline and syncs them when back', async () => {
    const ui = await signedIn();
    let online = true;
    const flaky = ((input: string, init?: RequestInit) => (online ? nodeFetch(input, init) : Promise.reject(new Error('offline')))) as typeof fetch;
    (ui.platform as { fetch: typeof fetch }).fetch = flaky;
    online = false;
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    expect(ui.app.offline).toBe(true);
    expect(ui.$('#offline').textContent).toContain('1 action(s)');
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    await ui.app.start({ id: 'T-102', title: 'Review pull request queue' });
    await ui.app.stop();
    expect(ui.app.queue.size).toBe(3);
    await ui.app.refresh();
    expect(ui.app.offline).toBe(true);
    online = true;
    await ui.app.refresh();
    expect(ui.app.offline).toBe(false);
    expect(ui.app.queue.size).toBe(0);
    expect(ui.$('#notice').textContent).toBe('Back online: 3 action(s) sent.');
    expect(ui.app.state.activeTimer).toBeNull();
  });

  it('asks about idle time locally (opt-in) and sends only the decision', async () => {
    let now = new Date(Date.now() - 300_000);
    const ui = await signedIn({ now: () => now });
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    ui.platform.hooks.idleSeconds = 1200;
    await ui.app.tick();
    expect(ui.app.idle).toBeNull();

    ui.click('#open-settings');
    const toggle = ui.$<HTMLInputElement>('#feature-idleDetection');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await tick();
    expect(ui.$('#consent-idleDetection').textContent).toContain('Consent given on');
    const minutes = ui.$<HTMLSelectElement>('#idle-minutes');
    minutes.value = '15';
    minutes.dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.idleMinutes).toBe(15);
    await ui.app.setFeature('notifications', true);
    ui.click('#back');

    await ui.app.tick();
    now = new Date();
    ui.platform.hooks.idleSeconds = 2;
    await ui.app.tick();
    expect(ui.app.idle).not.toBeNull();
    expect(ui.$('#idle').textContent).toContain('You were away');
    expect(ui.platform.hooks.notifications).toHaveLength(1);
    await ui.app.tick();
    ui.click('#idle-split');
    await tick();
    const state = (await env.control('state')) as { idleDecisions: { action: string }[]; requests: { body: string }[] };
    expect(state.idleDecisions.map((d) => d.action)).toEqual(['split']);
    expect(state.requests.map((r) => r.body).join()).not.toMatch(/isIdle|idleSeconds/);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');

    ui.app.idle = { from: new Date(Date.now() - 500), to: new Date() };
    await ui.app.resolveIdle('discard');
    expect(ui.app.state.activeTimer).toBeNull();
    ui.app.idle = { from: new Date(Date.now() - 120_000), to: new Date(Date.now() - 60_000) };
    await ui.app.resolveIdle('keep');
    expect(ui.app.state.activeTimer).toBeNull();
    await ui.app.resolveIdle('keep');
    await ui.app.setFeature('idleDetection', false);
    expect(ui.app.state.consents.idleDetection?.granted).toBe(false);
  });

  it('suppresses notifications outside working hours', async () => {
    const ui = await signedIn();
    await env.control('config', { workingHours: { slots: [] } });
    await ui.app.start({ id: 'T-101', title: 'x' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    await ui.app.setFeature('idleDetection', true);
    await ui.app.setFeature('notifications', true);
    ui.platform.hooks.idleSeconds = 1200;
    await ui.app.tick();
    ui.platform.hooks.idleSeconds = 1;
    await ui.app.tick();
    expect(ui.app.idle).not.toBeNull();
    expect(ui.platform.hooks.notifications).toHaveLength(0);
  });

  it('handles updates: 204, available, 401 = sign in again', async () => {
    const ui = await signedIn();
    await ui.app.checkUpdates();
    expect(ui.app.update).toBeNull();
    await env.control('config', { update: { version: '0.2.0', notes: '', pub_date: '', url: 'u', signature: 's' } });
    await ui.app.checkUpdates();
    expect(ui.$('#update').textContent).toContain('Version 0.2.0 is available.');
    ui.click('#install-update');
    await tick();
    await env.control('config', { failNext: { status: 500, error: 'x' } });
    await ui.app.checkUpdates();
    await env.control('token/revoke', {});
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('login');
    expect(ui.$('#notice').textContent).toBe('Your session ended. Sign in again.');
    expect(await ui.platform.secretGet()).toBeNull();
    await ui.app.checkUpdates();
    await ui.app.installUpdate();
  });

  it('update required never traps: remind later, download from Beacon, sign out', async () => {
    const ui = await signedIn();
    await env.control('config', { minSupportedVersion: '0.2.0', update: { version: '0.3.0', notes: '', pub_date: '', url: 'u', signature: 's' } });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('update-required');
    expect(ui.$('#update-required').textContent).toContain('Version 0.2.0 or later is required.');
    ui.click('#download-required');
    expect(ui.platform.hooks.opened.at(-1)).toBe(`${env.url}/dashboard/tasks/time/apps`);
    ui.click('#remind-later');
    expect(ui.app.view).toBe('main');
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('main');
    ui.app.updateDismissed = false;
    await ui.app.checkUpdates();
    ui.click('#logout-required');
    await tick();
    expect(ui.app.view).toBe('login');
  });

  it('a failed download or verification is non-blocking with a Beacon link', async () => {
    const ui = await signedIn();
    await env.control('config', { update: { version: '0.3.0', notes: '', pub_date: '', url: 'u', signature: 's', min_supported_version: '0.2.0' } });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('update-required');
    ui.platform.hooks.installError = 'signature verification failed';
    ui.click('#install-required');
    await tick();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#update-message').textContent).toContain('The automatic update failed: signature verification failed.');
    ui.click('#download-beacon');
    expect(ui.platform.hooks.opened.at(-1)).toBe(`${env.url}/dashboard/tasks/time/apps`);
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('main');
  });

  it('does not block on an unsatisfiable, invalid or uninstallable minimum', async () => {
    const ui = await signedIn();
    // Minimum above the version the channel offers.
    await env.control('config', { update: { version: '0.3.0', notes: '', pub_date: '', url: 'u', signature: 's', min_supported_version: '0.9.0' } });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#update-message').textContent).toContain('version 0.9.0 or later');
    // 204 with X-Min-Supported-Version above the running version: nothing to install.
    await env.control('config', { update: null, minSupportedVersion: '0.5.0' });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#update-message').textContent).toContain('version 0.5.0 or later');
    // Invalid minimum is ignored.
    await env.control('config', { minSupportedVersion: null, update: { version: '0.3.0', notes: '', pub_date: '', url: 'u', signature: 's', min_supported_version: 'latest' } });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#update')).not.toBeNull();
    // Build without the updater public key.
    ui.platform.hooks.installable = false;
    await env.control('config', { update: { version: '0.3.0', notes: '', pub_date: '', url: 'u', signature: 's', min_supported_version: '0.2.0' } });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#update-message').textContent).toContain('Automatic updates are not available in this build. Download version 0.3.0');
    // Up to date again clears the message.
    await env.control('config', { update: null, minSupportedVersion: null });
    await ui.app.checkUpdates();
    expect(ui.$('#update-message')).toBeNull();
  });

  it('opens the verification page only on the server host; shows other hosts as text', async () => {
    await env.control('config', { verificationUri: 'https://evil.example.com/device' });
    const ui = mount();
    await ui.app.init();
    const done = ui.app.connect(env.url);
    await tick();
    expect(ui.platform.hooks.opened).toEqual([]);
    expect(ui.$('#open-again')).toBeNull();
    expect(ui.$('#device-untrusted').textContent).toContain('https://evil.example.com/device?code=');
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
    await done;
    expect(ui.app.view).toBe('main');
  });

  it('resumes a stored session, signs out on 401 and shows settings, privacy and Spanish', async () => {
    const first = await signedIn();
    const token = await first.platform.secretGet();
    const ui = mount({ locale: 'es' });
    await ui.platform.secretSet(token ?? '');
    await ui.app.init();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#timer').textContent).toContain('Sin registrar');
    expect(document.documentElement.lang).toBe('es');
    ui.click('#open-settings');
    await ui.app.setFeature('autostart', true);
    expect(await ui.platform.autostartEnabled()).toBe(true);
    ui.click('#open-privacy');
    expect(ui.$('#privacy').textContent).toContain('Nunca se recoge');
    ui.click('#back');
    expect(ui.app.view).toBe('settings');
    ui.click('#back');
    expect(ui.app.view).toBe('main');
    await env.control('token/revoke', {});
    await ui.app.refresh();
    expect(ui.app.view).toBe('login');
    ui.click('#open-privacy');
    ui.click('#back');
    expect(ui.app.view).toBe('login');
  });

  it('signs out, also when the server is down', async () => {
    const ui = await signedIn();
    ui.click('#open-settings');
    ui.click('#logout');
    await tick();
    expect(ui.app.view).toBe('login');
    expect(await ui.platform.secretGet()).toBeNull();
    const again = await signedIn({ fetchImpl: nodeFetch });
    (again.platform as { fetch: typeof fetch }).fetch = () => Promise.reject(new Error('down'));
    await again.app.logout();
    expect(again.app.view).toBe('login');
    await again.app.connect(env.url.replace('127.0.0.1', 'localhost'));
    expect(again.$('#error-title').textContent).toBe(`Can't reach ${new URL(env.url.replace('127.0.0.1', 'localhost')).host}`);
    again.app.render();
    (again.app as unknown as { fail(e: unknown, stage: string): void }).fail('plain', 'action');
    expect(again.$('#error-title').textContent).toBe('That could not be completed');
    again.app.view = 'loading';
    again.app.render();
  });

  describe('Beacon links', () => {
    const HTTPS = 'https://beacon.test';
    /** Serves https://beacon.test from the http mock, so the https-only links can be rendered. */
    const proxy = ((input: string, init?: RequestInit) => nodeFetch(String(input).replace(HTTPS, env.url), init)) as typeof fetch;
    const taskUrls = {
      'T-101': `${HTTPS}/dashboard/tasks/T-101`,
      'T-102': 'https://evil.test/dashboard/tasks/T-102',
      'T-103': 'javascript:alert(1)',
      'T-104': `http://beacon.test/dashboard/tasks/T-104`,
      'T-105': `https://user@beacon.test/dashboard/tasks/T-105`,
      'T-106': `${HTTPS}:8443/dashboard/tasks/T-106`,
      'T-107': '/dashboard/tasks/T-107',
    };

    beforeEach(async () => {
      await env.control('config', { taskUrls, verificationUri: `${HTTPS}/device` });
    });

    it('shows Open Beacon, My time and same-origin task links only, and opens them through the platform', async () => {
      const ui = await signedIn({ fetchImpl: proxy }, HTTPS);
      ui.platform.hooks.opened.length = 0;
      const nav = ui.$('header nav');
      expect(nav.getAttribute('aria-label')).toBe('Beacon links');
      expect(ui.$<HTMLAnchorElement>('#open-beacon').href).toBe(`${HTTPS}/dashboard`);
      expect(ui.$('#open-beacon').getAttribute('aria-label')).toBe('Open Beacon');
      expect(ui.$<HTMLAnchorElement>('#open-my-time').href).toBe(`${HTTPS}/dashboard/tasks/time`);
      expect([...nav.children].map((el) => el.id)).toEqual(['open-beacon', 'open-settings']);
      const links = [...ui.root.querySelectorAll<HTMLAnchorElement>('#tasks a.beacon-link')];
      expect(links.map((a) => a.closest('li')?.getAttribute('data-task'))).toEqual(['T-101']);
      expect(links[0].getAttribute('aria-label')).toBe('Open “Write onboarding guide” in Beacon');
      expect(links[0].getAttribute('title')).toBe('Open “Write onboarding guide” in Beacon');
      expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
      expect(links[0].querySelector('[aria-hidden="true"]')).not.toBeNull();
      // Focus order inside a row: title, link, start button.
      const row = links[0].closest('li') as HTMLElement;
      expect([...row.children].map((el) => el.tagName)).toEqual(['BUTTON', 'SPAN', 'A', 'BUTTON']);
      ui.click('#open-beacon');
      ui.click('#open-my-time');
      links[0].click();
      expect(ui.platform.hooks.opened).toEqual([`${HTTPS}/dashboard`, `${HTTPS}/dashboard/tasks/time`, `${HTTPS}/dashboard/tasks/T-101`]);
      expect(ui.platform.hooks.trayMenu?.openBeacon).toBe('Open Beacon');
      expect(ui.platform.hooks.trayMenu?.myTime).toBe('My time');
      await ui.app.trayAction('open-beacon');
      expect(ui.platform.hooks.opened.at(-1)).toBe(`${HTTPS}/dashboard`);
      await ui.app.trayAction('my-time');
      expect(ui.platform.hooks.opened.at(-1)).toBe(`${HTTPS}/dashboard/tasks/time`);
      ui.platform.hooks.opened.pop();
      ui.app.openBeacon('https://evil.test/dashboard');
      ui.app.openBeacon(null);
      expect(ui.platform.hooks.opened).toHaveLength(4);
      ui.click('#open-settings');
      expect(ui.$('#open-beacon')).not.toBeNull();
      ui.app.destroy();
    });

    it('links the running timer from its url, or from the task list, and hides foreign ones', async () => {
      const ui = await signedIn({ fetchImpl: proxy, locale: 'es' }, HTTPS);
      await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
      const link = ui.$<HTMLAnchorElement>('#timer-open-in-beacon');
      expect(link.href).toBe(`${HTTPS}/dashboard/tasks/T-101`);
      expect(link.getAttribute('aria-label')).toBe('Abrir «Write onboarding guide» en Beacon');
      expect(ui.$('#open-beacon').getAttribute('aria-label')).toBe('Abrir Beacon');
      expect(ui.$('#open-my-time').textContent).toBe('Mi tiempo');
      link.click();
      expect(ui.platform.hooks.opened.at(-1)).toBe(`${HTTPS}/dashboard/tasks/T-101`);
      await ui.app.start({ id: 'T-102', title: 'Review pull request queue' });
      expect(ui.$('#timer-open-in-beacon')).toBeNull();
      // A timer without `url` (TimeTrackBundle 1.9.x) falls back to the same task in the list.
      await ui.app.stop();
      await env.control('config', { taskUrls: null });
      await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
      expect(ui.app.state.activeTimer?.url).toBeUndefined();
      expect(ui.$<HTMLAnchorElement>('#timer-open-in-beacon').href).toBe(`${HTTPS}/dashboard/tasks/T-101`);
      await ui.app.refresh();
      expect(ui.$('#timer-open-in-beacon')).toBeNull();
      expect(ui.root.querySelectorAll('#main a.beacon-link.icon')).toHaveLength(0);
      ui.app.destroy();
    });

    it('shows no Beacon link before connecting, on http servers, and after signing out', async () => {
      const ui = mount({ fetchImpl: proxy });
      await ui.app.init();
      expect(ui.root.querySelectorAll('a.beacon-link')).toHaveLength(0);
      await ui.app.trayAction('open-beacon');
      expect(ui.platform.hooks.opened).toHaveLength(0);
      const http = await signedIn();
      expect(http.root.querySelectorAll('a.beacon-link')).toHaveLength(0);
      expect(http.platform.hooks.trayMenu?.openBeacon).toBeNull();
      await http.app.trayAction('open-beacon');
      expect(http.platform.hooks.opened.filter((url) => url.includes('/dashboard'))).toHaveLength(0);
      const https = await signedIn({ fetchImpl: proxy }, HTTPS);
      expect(https.platform.hooks.trayMenu?.openBeacon).toBe('Open Beacon');
      await https.app.logout();
      expect(https.platform.hooks.trayMenu?.openBeacon).toBeNull();
      expect(https.root.querySelectorAll('a.beacon-link')).toHaveLength(0);
    });
  });
});
