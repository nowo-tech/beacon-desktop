// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUT, browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock, until } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

function mount(options: { locale?: 'en' | 'es'; fetchImpl?: typeof fetch; now?: () => Date; noticeMs?: number } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.2.0', options.fetchImpl ?? nodeFetch);
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale: options.locale ?? 'en',
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 5,
    now: options.now,
    noticeMs: options.noticeMs,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  const key = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? root) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  return { app, platform, root, $, key, click: (selector: string) => $(selector).click() };
}

async function signedIn(options: Parameters<typeof mount>[0] = {}) {
  const ui = mount(options);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
  await done;
  expect(ui.app.view).toBe('main');
  return ui;
}

const row = (ui: ReturnType<typeof mount>, id: string, list = '#main') => ui.root.querySelector<HTMLButtonElement>(`${list} [data-task="${id}"] .row-action`);

describe('0.2.0 UX', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('keeps every typed letter and the focus in the search field while results arrive (D1)', async () => {
    const ui = await signedIn();
    await env.control('config', { latencyMs: 15 });
    const search = ui.$<HTMLInputElement>('#search');
    search.focus();
    for (const letter of 'fix') {
      search.value += letter;
      search.setSelectionRange(search.value.length, search.value.length);
      search.dispatchEvent(new Event('input'));
      await tick(12);
    }
    await tick(120);
    expect(ui.$<HTMLInputElement>('#search')).toBe(search);
    expect(search.value).toBe('fix');
    expect(document.activeElement).toBe(search);
    expect(ui.root.querySelectorAll('#tasks li')).toHaveLength(1);
    expect(ui.$('#live').textContent).toContain('Tasks found: 1');
    // A periodic refresh does not move the focus either.
    await ui.app.refresh();
    expect(document.activeElement).toBe(search);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(search.value).toBe('');
    ui.app.destroy();
  });

  it('keeps focus on a row across refreshes and moves it to Stop after starting from the keyboard', async () => {
    const ui = await signedIn();
    row(ui, 'T-103')?.focus();
    await ui.app.refresh();
    expect(document.activeElement).toBe(row(ui, 'T-103'));
    row(ui, 'T-103')?.click();
    await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-103');
    expect(document.activeElement?.id).toBe('stop');
    // Arrow keys: search → first row → next row; Home / End; Escape back to the search field.
    ui.app.focusSearch();
    ui.key('ArrowDown');
    const buttons = [...ui.root.querySelectorAll<HTMLButtonElement>('#main button.row-action')];
    expect(document.activeElement).toBe(buttons[0]);
    ui.key('ArrowDown');
    expect(document.activeElement).toBe(buttons[1]);
    ui.key('End');
    expect(document.activeElement).toBe(buttons.at(-1));
    ui.key('Home');
    expect(document.activeElement).toBe(buttons[0]);
    ui.key('ArrowUp');
    expect(document.activeElement?.id).toBe('search');
    buttons[1].focus();
    ui.key('Escape');
    expect(document.activeElement?.id).toBe('search');
    ui.app.destroy();
  });

  it('pinned and recent tasks, Alt+1…9, Resume last, totals and the tray menu', async () => {
    const ui = await signedIn();
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await ui.app.start({ id: 'T-102', title: 'Review pull request queue' });
    await ui.app.stop();
    // Recents come from this week's entries, newest first; they are not repeated in the task list.
    expect([...ui.root.querySelectorAll('#quick li')].map((li) => li.getAttribute('data-task'))).toEqual(['T-102', 'T-101']);
    expect(ui.root.querySelector('#tasks [data-task="T-101"]')).toBeNull();
    expect(ui.$('#quick [data-task="T-102"] kbd').textContent).toBe('1');
    expect(ui.$('#total-today').textContent).toBe('Today0:00');
    expect(ui.$('#total-week').textContent).toBe('This week0:00');
    expect(ui.$('#last-task').textContent).toBe('Last: Review pull request queue');
    expect(ui.$('#resume').getAttribute('aria-label')).toBe('Continue last: “Review pull request queue” (new entry)');
    expect(ui.$('#resume').textContent).toBe('Continue last');
    expect(ui.$('#continue-shortcut').textContent).toBe('Shortcut: Ctrl+Alt+Shift+R');
    expect(ui.platform.hooks.trayMenu?.primary).toEqual({ id: 'resume', label: 'Resume “Review pull request queue”' });
    expect(ui.platform.hooks.trayMenu?.switchTo.map((item) => item.id)).toEqual(['switch:T-102', 'switch:T-101']);
    ui.click('#resume');
    await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    // Pin a task: it goes first in "Pinned and recent", survives a restart, and Alt+1 switches to it.
    ui.root.querySelector<HTMLButtonElement>('#tasks [data-task="T-105"] .pin')?.click();
    expect(ui.app.isPinned('T-105')).toBe(true);
    expect(ui.$('#quick [data-task="T-105"] .pin').getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem('time-track-desktop') ?? '{}').pinned.map((t: { id: string }) => t.id)).toEqual(['T-105']);
    ui.key('1', { altKey: true, code: 'Digit1' }, ui.root);
    await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-105');
    await ui.app.trayAction('switch:T-102');
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    await ui.app.trayAction('switch:unknown');
    // Ctrl+Shift+S stops, then resumes the last task.
    ui.key('S', { ctrlKey: true, shiftKey: true }, ui.root);
    await tick();
    expect(ui.app.state.activeTimer).toBeNull();
    await ui.app.trayAction('resume');
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    ui.root.querySelector<HTMLButtonElement>('#quick [data-task="T-105"] .pin')?.click();
    expect(ui.app.isPinned('T-105')).toBe(false);
    ui.app.destroy();
  });

  it('shows project · board and the start time on the timer when the server sends them', async () => {
    await env.control('config', { taskExtras: { 'T-104': { projectTitle: 'Billing' } } });
    const ui = await signedIn({ locale: 'es' });
    // Freeze only Date (the in-process mock stamps startedAt with it) at a local time with a one-digit hour,
    // so the result does not depend on the clock or the timezone of the machine running the test.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 5, 8, 5) });
    try {
      await ui.app.start({ id: 'T-104', title: 'Fix invoice rounding bug' });
    } finally {
      vi.useRealTimers();
    }
    expect(ui.$('#timer-meta').textContent).toBe('Billing · Engineering · desde 8:05');
    expect(ui.$('#quick-empty').textContent).toContain('Fija una tarea');
    expect(ui.$('#elapsed').getAttribute('role')).toBe('timer');
    expect(ui.$('#stop').getAttribute('aria-label')).toBe('Parar «Fix invoice rounding bug»');
    expect(ui.platform.hooks.trayMenu?.search).toBe('Buscar tarea…');
    ui.app.destroy();
  });

  it('keyboard shortcuts: Ctrl+K and / search, Ctrl+, settings, Escape back', async () => {
    const ui = await signedIn();
    (document.activeElement as HTMLElement | null)?.blur();
    ui.key('k', { ctrlKey: true }, ui.root);
    expect(document.activeElement?.id).toBe('search');
    row(ui, 'T-101')?.focus();
    ui.key('/', {}, row(ui, 'T-101') as HTMLElement);
    expect(document.activeElement?.id).toBe('search');
    ui.key(',', { ctrlKey: true }, ui.root);
    expect(ui.app.view).toBe('settings');
    ui.key('Escape', {}, ui.root);
    expect(ui.app.view).toBe('main');
    await ui.app.trayAction('settings');
    expect(ui.app.view).toBe('settings');
    await ui.app.trayAction('search');
    expect(ui.app.view).toBe('main');
    expect(document.activeElement?.id).toBe('search');
  });

  it('error catalogue: not Beacon, no device sign-in (with Retry), copy details', async () => {
    const ui = mount();
    await ui.app.init();
    await env.control('config', { notFound: ['me'] });
    await ui.app.connect(env.url);
    expect(ui.$('#error-title').textContent).toBe('Not a Beacon server');
    expect(ui.$('#error .error-art').getAttribute('src')).toBe('mascot/error-404.webp');
    ui.click('#error-help');
    expect(ui.$('#where-text').textContent).toContain('address bar');
    await env.control('config', { notFound: ['device/code'] });
    await ui.app.connect(env.url);
    expect(ui.$('#error-title').textContent).toBe("This server doesn't support device sign-in yet");
    expect(ui.$('#error-text').textContent).toContain('update Beacon');
    expect(ui.$('#error').textContent).not.toContain('Not Found');
    ui.click('#error-copy');
    await tick();
    expect(ui.platform.hooks.copied[0]).toContain('stage: deviceCode');
    expect(ui.platform.hooks.copied[0]).toContain('status: 404');
    expect(ui.platform.hooks.copied[0]).toContain('TimeTrack desktop 0.2.0');
    expect(ui.$('#notice').textContent).toBe('Copied to the clipboard.');
    await env.control('config', { notFound: [] });
    const retried = ui.app.retry();
    await tick();
    expect(ui.app.view).toBe('device');
    ui.click('#cancel-device');
    await retried;
    ui.app.dismissError();
    expect(ui.$('#error')).toBeNull();
  });

  it('completes and validates the server address, and never clears it', async () => {
    const ui = mount({ locale: 'es' });
    await ui.app.init();
    const field = ui.$<HTMLInputElement>('#server');
    expect(field.type).toBe('text');
    expect(field.getAttribute('inputmode')).toBe('url');
    await ui.app.connect('   ');
    expect(ui.$('#server-problem').textContent).toBe('Escribe la dirección de Beacon.');
    await ui.app.connect('https://ada:pw@beacon.example.com');
    expect(ui.$('#server-problem').textContent).toBe('Quita el usuario y la contraseña de la dirección.');
    expect(ui.$<HTMLInputElement>('#server').value).toBe('https://ada:pw@beacon.example.com');
    expect(ui.$('#server').getAttribute('aria-describedby')).toBe('server-problem server-help');
    // No scheme: https:// is added (then the host is unreachable here).
    await ui.app.connect('unreachable.invalid/dashboard/tasks');
    expect(ui.$<HTMLInputElement>('#server').value).toBe('https://unreachable.invalid');
    expect(ui.$('#error-title').textContent).toBe('No podemos contactar con unreachable.invalid');
    expect(ui.$('#error .error-art').getAttribute('src')).toBe('mascot/pose-reconnect.webp');
    expect(ui.$('#error .error-art').getAttribute('aria-hidden')).toBe('true');
    expect(ui.$('#login-form .mascot').getAttribute('alt')).toBe('El robot mascota de Beacon saludando');
  });

  it('device code: copy, countdown, expired in place with "Get a new code"', async () => {
    const ui = mount();
    await ui.app.init();
    const pending = ui.app.connect(env.url);
    await tick();
    expect(ui.$('#expires').textContent).toBe('Expires in 10:00');
    expect(ui.$('[role="progressbar"]').getAttribute('aria-valuemax')).toBe('600');
    const code = ui.$('#user-code').textContent ?? '';
    expect(ui.$('#user-code').getAttribute('aria-label')).toBe(`Code ${code.split('').map((c) => (c === '-' ? 'dash' : c)).join(' ')}`);
    ui.click('#copy-code');
    await tick();
    expect(ui.platform.hooks.copied).toEqual([code]);
    ui.click('#cancel-device');
    await pending;
    await env.control('config', { deviceExpiresIn: 0 });
    await ui.app.connect(env.url);
    expect(ui.app.view).toBe('device');
    expect(ui.$('#device-state').textContent).toBe('The code expired');
    expect(ui.$('#device [data-moment="deviceExpired"]').getAttribute('data-pose')).toBe('pose-hourglass');
    await env.control('config', { deviceExpiresIn: 600 });
    ui.click('#new-code');
    await tick();
    expect(ui.$('#user-code')).not.toBeNull();
    ui.click('#cancel-device');
    ui.app.destroy();
  });

  it('announces the last minute of the device code once', async () => {
    let now = Date.now();
    const ui = mount({ now: () => new Date(now) });
    await ui.app.init();
    await env.control('config', { deviceExpiresIn: 90 });
    const pending = ui.app.connect(env.url);
    await tick();
    now += 45_000;
    await tick(1100);
    expect(ui.$('#live').textContent).toContain('The code expires in 1 minute.');
    ui.click('#cancel-device');
    await pending;
  });

  it('global shortcut: default without Ctrl+Alt+T, configurable, refusal shown', async () => {
    const ui = await signedIn();
    expect(ui.platform.hooks.shortcut).toBe(DEFAULT_SHORTCUT);
    expect(DEFAULT_SHORTCUT).toBe('CommandOrControl+Alt+Shift+T');
    ui.click('#open-settings');
    const field = ui.$<HTMLInputElement>('#shortcut');
    expect(field.value).toBe(DEFAULT_SHORTCUT);
    field.value = 'CommandOrControl+Shift+Space';
    ui.$<HTMLFormElement>('#shortcut-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(ui.platform.hooks.shortcut).toBe('CommandOrControl+Shift+Space');
    expect(ui.$('#shortcut-message').textContent).toBe('Shortcut set: CommandOrControl+Shift+Space');
    ui.platform.hooks.refusedShortcuts.push('Alt+Tab');
    expect(await ui.app.applyShortcut('Alt+Tab')).toBe(false);
    expect(ui.$('#shortcut-message').textContent).toBe('Shortcut “Alt+Tab” is in use or not valid — choose another.');
    expect(ui.app.state.settings.shortcut).toBe('CommandOrControl+Shift+Space');
    ui.click('#shortcut-default');
    await tick();
    expect(ui.app.state.settings.shortcut).toBe(DEFAULT_SHORTCUT);
    expect(ui.$('#about').textContent).toContain('TimeTrack 0.2.0');
  });

  it('info notices are dismissed automatically (D9)', async () => {
    const ui = mount({ noticeMs: 20 });
    await ui.app.init();
    ui.app.setNotice('Hello');
    expect(ui.$('#notice').textContent).toBe('Hello');
    await tick(60);
    expect(ui.$('#notice')).toBeNull();
  });

  it('error titles for 429, missing scope, a running timer and server errors', async () => {
    const ui = await signedIn();
    await env.control('config', { failNext: { status: 429, error: 'rate_limited', retryAfter: 7 } });
    await ui.app.refresh();
    expect(ui.$('#error-title').textContent).toBe('Too many requests');
    expect(ui.$('#error-text').textContent).toBe('Try again in 7 s.');
    await env.control('config', { failNext: { status: 409, error: 'timer_running' } });
    await ui.app.refresh();
    expect(ui.$('#error-title').textContent).toBe('A timer is already running');
    ui.click('#error-retry');
    await tick();
    expect(ui.$('#error')).toBeNull();
    await env.control('config', { failNext: { status: 403, error: 'insufficient_scope' } });
    await ui.app.refresh();
    expect(ui.$('#error-title').textContent).toBe('This connection is missing permissions');
    ui.click('#error-reconnect');
    await tick();
    expect(ui.app.view).toBe('login');
  });
});
