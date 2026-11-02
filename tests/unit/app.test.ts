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

async function signedIn(options: Parameters<typeof mount>[0] = {}) {
  const ui = mount(options);
  await ui.app.init();
  const done = ui.app.connect(env.url);
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
    expect(ui.$('#error').textContent).toContain('https://');
    const denied = ui.app.connect(env.url);
    await tick();
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent, approve: false });
    await denied;
    expect(ui.$('#error').textContent).toBe('The request was denied in Beacon.');
    const cancelled = ui.app.connect(env.url);
    await tick();
    ui.click('#cancel-device');
    await cancelled;
    expect(ui.app.view).toBe('login');
    expect(ui.app.error).toBeNull();
    await env.control('config', { failNext: { status: 500, error: 'boom' } });
    await ui.app.connect(env.url);
    expect(ui.$('#error').textContent).toBe('Something went wrong: Simulated boom.');
  });

  it('starts, switches and stops; tray follows; tray stop works', async () => {
    const ui = await signedIn();
    ui.root.querySelector<HTMLElement>('[data-task="T-101"] button')?.click();
    await tick();
    expect(ui.$('#timer-task').textContent).toBe('Write onboarding guide');
    expect(ui.platform.hooks.tray).toEqual({ text: '0:00:00 · Write onboarding guide', running: true });
    ui.root.querySelector<HTMLElement>('[data-task="T-102"] button')?.click();
    await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    ui.platform.hooks.emit('tray-stop');
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
    expect(ui.$('#tasks').textContent).toBe('No tasks found.');
    ui.platform.hooks.emit('shortcut');
    expect(document.activeElement?.id).toBe('search');
    await ui.app.start({ id: 'T-900', title: 'x' });
    expect(ui.$('#error').textContent).toBe('You cannot track time on this task.');
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

  it('handles updates: 204, available, required (blocking), 401 = sign in again', async () => {
    const ui = await signedIn();
    await ui.app.checkUpdates();
    expect(ui.app.update).toBeNull();
    await env.control('config', { update: { version: '0.2.0', notes: '', pub_date: '', url: 'u', signature: 's' } });
    await ui.app.checkUpdates();
    expect(ui.$('#update').textContent).toContain('Version 0.2.0 is available.');
    ui.click('#install-update');
    await tick();
    await env.control('config', { update: { version: '0.3.0', notes: '', pub_date: '', url: 'u', signature: 's', min_supported_version: '0.2.0' } });
    await ui.app.checkUpdates();
    expect(ui.app.view).toBe('update-required');
    expect(ui.$('#update-required').textContent).toContain('Version 0.2.0 or later is required.');
    await ui.app.installUpdate();
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

  it('resumes a stored session, signs out on 401 and shows settings, privacy and Spanish', async () => {
    const first = await signedIn();
    const token = await first.platform.secretGet();
    const ui = mount({ locale: 'es' });
    await ui.platform.secretSet(token ?? '');
    await ui.app.init();
    expect(ui.app.view).toBe('main');
    expect(ui.$('#timer').textContent).toBe('No hay ningún temporizador en marcha.');
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
    expect(again.$('#error').textContent).toContain('cannot be reached');
    again.app.render();
    (again.app as unknown as { fail(e: unknown): void }).fail('plain');
    expect(again.$('#error').textContent).toBe('Something went wrong: plain');
    again.app.view = 'loading';
    again.app.render();
  });
});
