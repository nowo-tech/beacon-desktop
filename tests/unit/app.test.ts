// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(ui.$('#tasks-empty').textContent).toBe('Nothing matches “zzz”, and the robot read the list twice. Only tasks you can track time on appear.');
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

  it('"Still there?" on a 1.10 server: on by default, asks after the threshold and sends only the decision', async () => {
    const realNow = Date.now();
    let now = new Date(realNow - 120_000);
    const sent: string[] = [];
    const logged: string[] = [];
    const recording = ((input: string, init?: RequestInit) => {
      sent.push(`${input} ${JSON.stringify(init?.headers ?? {})} ${String(init?.body ?? '')}`);
      return nodeFetch(input, init);
    }) as typeof fetch;
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' '))),
    );
    const ui = await signedIn({ now: () => now, fetchImpl: recording });
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    expect(ui.app.idleCheckEnabled()).toBe(true);
    // A recognisable counter value: it must never leave the device or reach a log.
    ui.platform.hooks.idleSeconds = 617.25;
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('asking');
    expect(ui.$('#idle-title').textContent).toBe('Still there?');
    expect(ui.$('#idle-text').textContent).toBe('No activity for 10 min on Write onboarding guide.');
    expect(ui.$('#live').textContent).toContain('Still there?');
    // A modal: it takes focus (the first answer) and the rest of the window is inert until it is answered.
    expect(document.activeElement?.closest('#idle')).not.toBeNull();
    expect(ui.$('#idle').getAttribute('aria-modal')).toBe('true');
    expect(ui.$('#timer').hasAttribute('inert')).toBe(true);
    // The person is back but has not answered: the prompt stays and nothing is stopped.
    now = new Date(realNow - 60_000);
    ui.platform.hooks.idleSeconds = 1;
    await ui.app.tick();
    expect(ui.app.state.idleCheck).toMatchObject({ phase: 'asking', returnedAt: new Date(now.getTime() - 1000).toISOString() });

    ui.click('#idle-meeting');
    expect(document.activeElement?.id).toBe('idle-note');
    ui.click('#idle-meeting-cancel');
    expect(document.activeElement?.id).toBe('idle-meeting');
    ui.click('#idle-meeting');
    ui.$<HTMLInputElement>('#idle-note').value = 'Acme call';
    ui.$<HTMLSelectElement>('#idle-target').value = 'T-103';
    ui.$<HTMLFormElement>('#idle-meeting-form').dispatchEvent(new Event('submit', { cancelable: true }));
    for (let i = 0; i < 20 && ui.app.state.idleCheck.phase !== 'watching'; i++) await tick();
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    expect(ui.$('#notice').textContent).toBe('Got it, the time is kept.');
    const state = (await env.control('state')) as { idleDecisions: { action: string; taskId: string; note: string }[]; requests: { path: string; body: string }[] };
    expect(state.idleDecisions).toEqual([expect.objectContaining({ action: 'reassign', taskId: 'T-103', then: 'continue', note: 'Acme call' })]);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');

    // Privacy: only the decision. The counter is not in any URL, header, body, log or the app's storage.
    for (const request of state.requests.filter((r) => r.path.endsWith('discard-idle'))) {
      expect(Object.keys(JSON.parse(request.body) as object).every((key) => ['from', 'to', 'action', 'taskId', 'then', 'note', 'source'].includes(key))).toBe(true);
    }
    const everything = [...sent, ...logged, ...Object.values(localStorage)].join('\n');
    expect(everything).not.toMatch(/617\.25|617250|idleSeconds|isIdle|lastInput|idleSince/);
    spies.forEach((spy) => spy.mockRestore());
    ui.app.destroy();
  });

  it('no answer: stops at the last input, asks about the gap on return, then offers Resume', async () => {
    const realNow = Date.now();
    let now = new Date(realNow - 480_000);
    const ui = await signedIn({ now: () => now });
    await ui.app.setFeature('notifications', true);
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    ui.platform.hooks.idleSeconds = 660;
    await ui.app.tick();
    const lastInput = now.getTime() - 660_000;
    expect(ui.platform.hooks.notifications).toEqual(['Still there?: No activity for 10 min on Write onboarding guide.']);
    now = new Date(realNow - 120_000);
    ui.platform.hooks.idleSeconds = 660 + 360;
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('away');
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.$('#idle-away').textContent).toContain('Timer paused');
    const stopped = Object.values(((await env.control('state')) as { entries: Record<string, { endedAt: string }[]> }).entries).flat();
    expect(Math.abs(Date.parse(stopped[0].endedAt) - lastInput)).toBeLessThan(30_000);

    ui.platform.hooks.idleSeconds = 1;
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('gap');
    expect(ui.$('#gap-text').textContent).toContain('Write onboarding guide');
    expect(ui.$<HTMLSelectElement>('#gap-task').options.length).toBeGreaterThan(0);
    ui.click('#gap-keep');
    for (let i = 0; i < 20 && ui.app.state.idleCheck.phase !== 'resume'; i++) await tick();
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('resume');
    const entries = Object.values(((await env.control('state')) as { entries: Record<string, { taskId: string; startedAt: string; endedAt: string }[]> }).entries).flat();
    expect(entries).toHaveLength(2);
    expect(entries[1].startedAt).toBe(entries[0].endedAt);
    expect(Math.abs(Date.parse(entries[1].endedAt) - (now.getTime() - 1000))).toBeLessThan(2000);
    expect(ui.$('#gap-resume-card-title').textContent).toBe('Resume Write onboarding guide?');
    ui.click('#gap-resume');
    for (let i = 0; i < 20 && ui.app.state.activeTimer === null; i++) await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    ui.app.destroy();
  });

  it('gap on another task, sleep as idle, pause and discard', async () => {
    const realNow = Date.now();
    let now = new Date(realNow - 1_500_000);
    const ui = await signedIn({ now: () => now });
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    ui.platform.hooks.idleSeconds = 1;
    await ui.app.tick();
    // The computer slept 20 min and was woken by a key press: the gap question comes at once.
    now = new Date(realNow - 60_000);
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('gap');
    ui.$<HTMLSelectElement>('#gap-task').value = 'T-102';
    ui.click('#gap-reassign');
    for (let i = 0; i < 20 && ui.app.state.idleCheck.phase !== 'resume'; i++) await tick();
    await tick();
    const entries = Object.values(((await env.control('state')) as { entries: Record<string, { taskId: string }[]> }).entries).flat();
    expect(entries.map((e) => e.taskId)).toEqual(['T-101', 'T-102']);
    ui.click('#gap-dismiss');
    expect(ui.app.state.idleCheck.phase).toBe('watching');

    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    ui.platform.hooks.idleSeconds = 700;
    await ui.app.tick();
    ui.click('#idle-discard');
    for (let i = 0; i < 20 && ui.app.state.idleCheck.phase !== 'watching'; i++) await tick();
    await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    expect(ui.$('#notice').textContent).toBe('Those minutes were left out. The timer keeps running.');
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    await ui.app.tick();
    ui.click('#idle-pause');
    for (let i = 0; i < 20 && ui.app.state.activeTimer !== null; i++) await tick();
    await tick();
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.app.state.idleCheck.phase).toBe('resume');
    const decisions = ((await env.control('state')) as { idleDecisions: { action: string }[] }).idleDecisions.map((d) => d.action);
    expect(decisions).toEqual(['split', 'discard']);
    ui.app.destroy();
  });

  it('"Still there?" on a 1.9 server is opt-in; organisation off hides it; the person can only wait longer', async () => {
    await env.control('config', { apiVersion: '1.9' });
    let now = new Date(Date.now() - 300_000);
    const ui = await signedIn({ now: () => now });
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    ui.platform.hooks.idleSeconds = 1000;
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    ui.click('#open-settings');
    const toggle = ui.$<HTMLInputElement>('#feature-idleDetection');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await tick();
    expect(ui.$('#consent-idleDetection').textContent).toContain('Consent given on');
    const minutes = ui.$<HTMLSelectElement>('#idle-minutes');
    minutes.value = '15';
    minutes.dispatchEvent(new Event('change'));
    // The countdown is IDLE_COUNTDOWN_MINUTES, never longer than the organisation's answer timeout.
    expect(ui.app.idleSettings()).toEqual({ thresholdMinutes: 15, answerTimeoutMinutes: 2 });
    ui.click('#back');
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('asking');
    expect(ui.root.querySelector('#idle-target')).toBeNull();
    // 1.9 cannot add past time: after an automatic stop the gap can only be left out.
    now = new Date(now.getTime() + 300_000);
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('away');
    ui.platform.hooks.idleSeconds = 0;
    await ui.app.tick();
    expect(ui.$('#gap-unsupported').textContent).toContain('cannot add past time');
    ui.click('#gap-discard');
    await tick();
    ui.click('#gap-dismiss');
    await ui.app.setFeature('idleDetection', false);
    expect(ui.app.idleCheckEnabled()).toBe(false);

    await env.control('config', { apiVersion: '1.10', idleCheck: { enabled: false, threshold_minutes: 20, answer_timeout_minutes: 3 } });
    await ui.app.refresh();
    ui.app.show('settings');
    expect(ui.$('#idle-org').textContent).toBe('Turned off by your organisation.');
    expect(ui.app.idleCheckEnabled()).toBe(false);
    await env.control('config', { idleCheck: { enabled: true, threshold_minutes: 20, answer_timeout_minutes: 3 } });
    await ui.app.refresh();
    ui.app.show('settings');
    expect(ui.$('#idle-org').textContent).toContain('after 20 minutes');
    expect([...ui.$<HTMLSelectElement>('#idle-minutes').options].map((o) => o.value)).toEqual(['20', '30', '45', '60']);
    expect(ui.app.idleSettings()).toEqual({ thresholdMinutes: 20, answerTimeoutMinutes: 2 });
    const select = ui.$<HTMLSelectElement>('#idle-minutes');
    select.value = '20';
    select.dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.idleMinutes).toBeNull();
    ui.app.destroy();
  });

  it('sends the meeting note with keep when the server takes it (idle_keep_note)', async () => {
    await env.control('config', { keepNote: true });
    const ui = await signedIn();
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    expect(ui.app.features().idleKeepNote).toBe(true);
    ui.platform.hooks.idleSeconds = 700;
    await ui.app.tick();
    await ui.app.answerIdle({ kind: 'meeting', note: 'Standup' });
    const decisions = ((await env.control('state')) as { idleDecisions: { action: string; note?: string }[] }).idleDecisions;
    expect(decisions).toEqual([expect.objectContaining({ action: 'keep', note: 'Standup' })]);
    expect(ui.app.state.pendingNote).toBeNull();
    // Without the feature (1.10.0): the note waits for the stop.
    await env.control('config', { keepNote: false });
    await ui.app.refresh();
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    await ui.app.tick();
    await ui.app.answerIdle({ kind: 'meeting', note: 'Retro' });
    expect(ui.app.state.pendingNote).toBe('Retro');
    ui.app.destroy();
  });

  it('personal accounts (user_can_disable) get an on/off switch, on by default, with dated consent', async () => {
    await env.control('config', { userCanDisable: true });
    const ui = await signedIn();
    expect(ui.app.idleCheckEnabled()).toBe(true);
    ui.app.show('settings');
    const toggle = ui.$<HTMLInputElement>('#idle-toggle');
    expect(toggle.checked).toBe(true);
    expect(ui.$('#idle-org').textContent).toContain('You can turn it off');
    expect(ui.root.querySelector('#idle-minutes')).not.toBeNull();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await tick();
    expect(ui.app.idleCheckEnabled()).toBe(false);
    expect(ui.$('#consent-idleDetection').textContent).toContain('Consent withdrawn on');
    expect(ui.root.querySelector('#idle-minutes')).toBeNull();
    await ui.app.setFeature('idleDetection', true);
    expect(ui.app.idleCheckEnabled()).toBe(true);
    // An organisation policy (false or key absent): mandatory, no switch.
    await env.control('config', { userCanDisable: false });
    await ui.app.refresh();
    await ui.app.setFeature('idleDetection', false);
    expect(ui.app.idleCheckEnabled()).toBe(true);
    ui.app.show('settings');
    expect(ui.root.querySelector('#idle-toggle')).toBeNull();
    await env.control('config', { userCanDisable: null });
    await ui.app.refresh();
    expect(ui.app.features().userCanDisable).toBe(false);
    expect(ui.app.idleCheckEnabled()).toBe(true);
    ui.app.destroy();
  });

  it('formats times with the locale: 24 h in Spanish, no hard-coded AM/PM', () => {
    const local = new Date(2026, 10, 4, 13, 59).toISOString();
    const note = { kind: 'start' as const, taskTitle: 'A', requested: local, applied: local, reason: 'overlap' as const };
    const es = mount({ locale: 'es' }).app.clampText(note);
    expect(es).toContain('13:59');
    expect(es).not.toMatch(/AM|PM|a\. m\.|p\. m\./i);
    expect(mount({ locale: 'en' }).app.clampText(note)).toContain('1:59');
  });

  it('suppresses notifications outside working hours', async () => {
    const ui = await signedIn();
    await env.control('config', { workingHours: { slots: [] } });
    await ui.app.start({ id: 'T-101', title: 'x' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    await ui.app.setFeature('notifications', true);
    ui.platform.hooks.idleSeconds = 700;
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('asking');
    expect(ui.platform.hooks.notifications).toHaveLength(0);
  });

  it('shows clamped offline times in plain words and keeps a meeting note for the stop', async () => {
    const ui = await signedIn({ now: () => new Date(Date.now() + 10 * 60_000) });
    const online = { value: false };
    (ui.platform as { fetch: typeof fetch }).fetch = ((input: string, init?: RequestInit) => (online.value ? nodeFetch(input, init) : Promise.reject(new Error('offline')))) as typeof fetch;
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    expect(ui.app.queue.list()).toEqual([expect.objectContaining({ kind: 'start', taskId: 'T-101' })]);
    online.value = true;
    await ui.app.refresh();
    expect(ui.$('#clamps').textContent).toContain('the requested time');
    expect(ui.$('#clamps').textContent).toContain('was in the future');
    ui.click('#clamps-dismiss');
    expect(ui.root.querySelector('#clamps')).toBeNull();
    expect(ui.app.clampText({ kind: 'stop', taskTitle: null, requested: '2026-11-04T10:00:00Z', applied: '2026-11-04T09:00:00Z', reason: 'before_start' })).toContain('when it started');
    expect(ui.app.clampText({ kind: 'start', taskTitle: 'A', requested: '2026-11-04T10:00:00Z', applied: '2026-11-04T09:00:00Z', reason: 'weird' as never })).toContain('instead of');

    ui.app.state.pendingNote = 'Weekly sync';
    await ui.app.stop();
    const entries = Object.values(((await env.control('state')) as { entries: Record<string, { metadata: { note?: string } | null }[]> }).entries).flat();
    expect(entries.at(-1)?.metadata).toEqual({ note: 'Weekly sync' });
    expect(ui.app.state.pendingNote).toBeNull();
  });

  it('privacy screen says what is sent and what stays local; clear local data', async () => {
    const ui = await signedIn();
    await ui.app.setFeature('autostart', true);
    ui.app.togglePin({ id: 'T-101', title: 'Write onboarding guide' });
    (ui.platform as { fetch: typeof fetch }).fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await ui.app.start({ id: 'T-102', title: 'Review pull request queue' });
    ui.app.show('privacy');
    for (const id of ['privacy-sent', 'privacy-local', 'privacy-never']) expect(ui.root.querySelector(`#${id} li`)).not.toBeNull();
    expect(ui.$('#privacy-local').textContent).toContain('never stored, logged or sent');
    ui.click('#clear-local');
    expect(document.activeElement?.id).toBe('clear-local-yes');
    expect(ui.$('#clear-local-question').textContent).toContain('1 action(s) have not reached the server');
    ui.click('#clear-local-no');
    expect(document.activeElement?.id).toBe('clear-local');
    ui.click('#clear-local');
    ui.click('#clear-local-yes');
    for (let i = 0; i < 20 && ui.app.view !== 'login'; i++) await tick();
    expect(ui.app.view).toBe('login');
    expect(ui.$('#notice').textContent).toContain('Local data cleared');
    expect(localStorage.length).toBe(0);
    expect(await ui.platform.secretGet()).toBeNull();
    expect(await ui.platform.autostartEnabled()).toBe(false);
    expect(ui.app.state.pinned).toEqual([]);
    ui.app.show('privacy');
    ui.click('#clear-local');
    expect(ui.$('#clear-local-question').textContent).toBe('Delete all TimeTrack data on this computer?');
    await ui.app.clearLocalData();
    expect(ui.app.view).toBe('login');
  });

  it('handles updates: 204, available, 401 = sign in again', async () => {
    const ui = await signedIn();
    await ui.app.checkUpdates();
    expect(ui.app.update).toBeNull();
    await env.control('config', { update: { version: '0.2.0', notes: '', pub_date: '', url: 'u', signature: 's' } });
    await ui.app.checkUpdates();
    expect(ui.$('#update').textContent).toContain('Version 0.2.0 is available');
    ui.click('#update-now');
    await tick();
    expect(ui.platform.hooks.installed).toBe(1);
    expect(ui.$('#update').textContent).toContain('Installing version 0.2.0. TimeTrack will restart.');
    // The real app relaunches here; the browser fake stays, so go back to "offered".
    ui.app.updateStage = 'offer';
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
    expect(ui.$('#update-message').textContent).toContain('Automatic updates are not available for this installation. Download version 0.3.0');
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
