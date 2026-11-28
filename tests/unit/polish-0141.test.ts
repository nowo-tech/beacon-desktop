// @vitest-environment happy-dom
// 0.14.1 polish against the in-process mock Beacon: the Tasks module hidden up front on a server without the `tasks`
// scope family, the server logout of the tasks token (BDA13-L2), the Chat → Tasks chain of the first run, the
// "Finish setup" chip, and the status strip's reserved band in tall windows only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { SETUP_CHIP_KEY, SHELL_KEY, Shell } from '../../src/shell/shell';
import { TasksApi } from '../../src/tasks/api';
import { OFFER_KEY } from '../../src/tasks/module';
import { StatusStrip, type TallQuery } from '../../src/ui/statusStrip';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

async function until(ready: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function mount(options: { freshSignIn?: boolean; platform?: ReturnType<typeof browserPlatform>; locale?: 'en' | 'es' } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const locale = options.locale ?? 'en';
  const platform = options.platform ?? browserPlatform('0.1.0', nodeFetch);
  const shell = new Shell(root, platform, { locale, storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, {
    storage: localStorage,
    locale,
    onRender: () => shell.onAppRender(),
    // As main.ts: the chat and tasks tokens are revoked on the server before the sign-out.
    beforeSignOut: () => shell.revokeOnServer(),
    clearParked: () => shell.clearParked(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
  });
  shell.attach(app);
  shell.freshSignIn = options.freshSignIn ?? false;
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

const offers = () => JSON.parse(localStorage.getItem(OFFER_KEY) ?? '{}') as Record<string, boolean>;
const origin = () => new URL(env.url).origin;
const probes = async () => ((await env.control('state')) as { tasksDeviceRequests: number }).tasksDeviceRequests;
const logouts = async () => ((await env.control('tasks/state')) as { logouts: { mode: string; known: boolean }[] }).logouts;

async function connectTasks(ui: ReturnType<typeof mount>) {
  ui.$<HTMLButtonElement>('#tab-tasks').click();
  ui.$<HTMLButtonElement>('#tasks-connect').click();
  await until(() => ui.$('#tasks-user-code') !== null, 'the tasks code');
  await env.control('device/approve', { userCode: ui.$('#tasks-user-code').textContent });
  await until(() => ui.shell.tasks?.connected === true, 'tasks connected');
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem(SHELL_KEY, JSON.stringify({ module: 'time', setup: 'done' }));
  await env.control('reset', {});
  await env.control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

describe('Tasks hidden up front where Beacon does not offer them (0.14.1)', () => {
  it('a chat-only server: no tab, no Ctrl+2, no tray item, no setup step; remembered, asked once per start, shown once offered', async () => {
    await env.control('config', { chatOnly: true });
    const ui = await signIn(mount());
    // One probe (`device/code` for the `tasks` family): `invalid_scope`, remembered for this server.
    await until(() => offers()[origin()] === false, 'the answer remembered');
    expect(await probes()).toBe(1);
    await until(() => ui.$('#tab-tasks') === null, 'the tab gone');
    expect(ui.shell.tasksHidden).toBe(true);
    expect([...document.querySelectorAll('.rail-tab[role="tab"]')].map((tab) => tab.id)).toEqual(['tab-chat', 'tab-time']);
    // Ctrl/⌘+2 is Time now; there is no third module.
    ui.key({ key: '2', ctrlKey: true });
    expect(ui.shell.module).toBe('time');
    ui.key({ key: '3', ctrlKey: true });
    expect(ui.shell.module).toBe('time');
    expect(ui.shell.trayTasks()).toEqual([]);
    // The switcher has no Tasks entries.
    ui.key({ key: 'k', ctrlKey: true });
    expect(ui.$('#sw-list').textContent).not.toMatch(/Tasks|Boards/);
    ui.key({ key: 'k', ctrlKey: true });
    // The shortcut sheet names two modules.
    ui.shell.openKeys();
    expect(ui.$('#shell-keys').textContent).toContain('1 2');
    expect(ui.$('#shell-keys').textContent).not.toContain('1 2 3');
    ui.$<HTMLDialogElement>('#shell-keys').close();
    // Settings: said once, nothing to press.
    ui.shell.openSettings('account');
    expect(ui.$('#account-tasks').textContent).toContain('Not available on this Beacon server yet.');
    expect(ui.$('#account-tasks-connect')).toBeNull();
    ui.$<HTMLDialogElement>('#shell-settings').close();
    // The next start: hidden from the first frame, asked again once.
    const again = mount();
    await again.app.init();
    const done = again.app.connect(env.url);
    await until(() => again.$('#user-code') !== null, 'the device code');
    await env.control('device/approve', { userCode: again.$('#user-code').textContent });
    await done;
    await until(() => again.shell.root.dataset.bare === 'false', 'the shell');
    expect(again.$('#tab-tasks')).toBeNull();
    await until(async () => (await probes()) === 2, 'one probe this start');
    // Beacon is upgraded: the next start finds the family and shows the module (and stops asking).
    await env.control('config', { chatOnly: false });
    const upgraded = await signIn(mount());
    await until(() => upgraded.$('#tab-tasks') !== null, 'the tab back');
    expect(offers()[origin()]).toBe(true);
    expect(await probes()).toBe(3);
    const later = await signIn(mount());
    expect(later.$('#tab-tasks')).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await probes()).toBe(3);
  });

  it('the first run has no Tasks step there, and ends after Chat', async () => {
    localStorage.removeItem(SHELL_KEY);
    await env.control('config', { chatOnly: true });
    const ui = await signIn(mount({ freshSignIn: true }));
    await until(() => ui.shell.setupShown, 'the setup');
    await until(() => ui.$('#setup-step-tasks') === null, 'no tasks step');
    ui.$<HTMLButtonElement>('#setup-connect').click();
    await until(() => ui.$('#setup-code') !== null, 'the chat code');
    await env.control('device/approve', { userCode: ui.$('#setup-code').textContent });
    await until(() => !ui.shell.setupShown, 'the end of the setup');
    expect(ui.shell.module).toBe('chat');
    expect(ui.platform.hooks.tasksConnectBegins).toBe(0);
    // Nothing left to finish: no chip.
    expect(ui.$('#setup-chip')).toBeNull();
  });

  it('a "Connect tasks" refused as an unknown family keeps its explanation, then the tab goes', async () => {
    const ui = await signIn(mount());
    await until(() => offers()[origin()] === true, 'offered at first');
    // The server loses the family (a downgrade, or a family turned off).
    await env.control('config', { chatOnly: true });
    ui.$<HTMLButtonElement>('#tab-tasks').click();
    ui.$<HTMLButtonElement>('#tasks-connect').click();
    await until(() => document.querySelector('#mod-tasks .cc-error') !== null, 'the refusal');
    expect(ui.$('#mod-tasks .cc-error').textContent).toBe('Tasks are not available on this Beacon server yet: they need a newer version of Beacon.');
    expect(offers()[origin()]).toBe(false);
    // Still readable where it was asked; the tab leaves with the person.
    expect(ui.$('#tab-tasks')).not.toBeNull();
    ui.$<HTMLButtonElement>('#tab-time').click();
    expect(ui.$('#tab-tasks')).toBeNull();
  });
});

describe('server logout of the tasks token (BDA13-L2, TaskBoard 3.7.0)', () => {
  it('classifies the answers: 204, 404, 409, 429, 5xx, a network error, no answer in time, 401', async () => {
    const answer = (status: number) => (async () => new Response(status === 204 ? null : JSON.stringify({ ok: false, error: status === 409 ? 'unavailable' : 'x' }), { status })) as unknown as typeof fetch;
    const api = (fetchImpl: typeof fetch) => new TasksApi({ baseUrl: 'https://beacon.example', token: 't', context: null, fetchImpl });
    expect(await api(answer(204)).logout()).toBe('revoked');
    expect(await api(answer(404)).logout()).toBe('gone');
    expect(await api(answer(409)).logout()).toBe('retry');
    expect(await api(answer(500)).logout()).toBe('retry');
    // BDA141-I3: rate limited, the token is still valid: parked too.
    expect(await api(answer(429)).logout()).toBe('retry');
    expect(await api(answer(401)).logout()).toBe('refused');
    expect(await api((async () => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch).logout()).toBe('retry');
    expect(await api((() => new Promise<Response>(() => undefined)) as unknown as typeof fetch).logout(20)).toBe('retry');
    // No body, the Bearer, `POST <server>/api/task-board/v1/logout`.
    let seen: { url: string; init: RequestInit } | null = null;
    await api((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch).logout();
    expect(seen).toMatchObject({ url: 'https://beacon.example/api/task-board/v1/logout', init: { method: 'POST', body: undefined } });
    expect((seen as unknown as { init: { headers: Record<string, string> } }).init.headers.Authorization).toBe('Bearer t');
  });

  it('Disconnect and sign-out revoke first; a 409 parks the token for one retry at the next start; a 404 does not', async () => {
    const platform = browserPlatform('0.1.0', nodeFetch);
    const ui = await signIn(mount({ platform }));
    await connectTasks(ui);
    // Disconnect: revoked (204), then forgotten here.
    await ui.shell.tasks?.disconnect();
    expect(await logouts()).toEqual([{ mode: 'ok', known: true }]);
    expect(platform.hooks.tasksToken).toBeNull();
    expect(platform.hooks.tasksRevokeParked).toEqual([]);
    // A server before 3.7.0 (404): nothing to revoke there, nothing parked.
    await connectTasks(ui);
    await env.control('config', { tasksLogout: 'missing' });
    await ui.shell.tasks?.disconnect();
    expect((await logouts()).at(-1)).toEqual({ mode: 'missing', known: true });
    expect(platform.hooks.tasksRevokeParked).toEqual([]);
    // Busy server (409 with Retry-After) at sign-out: parked, and the sign-out still goes through.
    await connectTasks(ui);
    const token = platform.hooks.tasksToken;
    await env.control('config', { tasksLogout: 'unavailable' });
    await ui.app.logout();
    expect(platform.hooks.tasksToken).toBeNull();
    expect(platform.hooks.tasksRevokeParked).toEqual([{ server: env.url, token, attempts: 0 }]);
    expect((await logouts()).at(-1)).toEqual({ mode: 'unavailable', known: true });
    // The next start tries once more (now answered): revoked; the start after that sends nothing.
    await env.control('config', { tasksLogout: 'ok' });
    mount({ platform });
    await until(async () => (await logouts()).length === 4, 'the retry');
    expect((await logouts()).at(-1)).toEqual({ mode: 'ok', known: true });
    expect(platform.hooks.tasksRevokeParked).toEqual([]);
    mount({ platform });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await logouts()).toHaveLength(4);
  });

  it('a 5xx parks too; an answered retry is final, whatever it says', async () => {
    const platform = browserPlatform('0.1.0', nodeFetch);
    const ui = await signIn(mount({ platform }));
    await connectTasks(ui);
    await env.control('config', { tasksLogout: 'error' });
    await ui.shell.tasks?.disconnect();
    expect(platform.hooks.tasksRevokeParked).toHaveLength(1);
    expect(await platform.tasks?.retryRevoke?.()).toBe('failed');
    expect(platform.hooks.tasksRevokeParked).toEqual([]);
    expect(await platform.tasks?.retryRevoke?.()).toBe('none');
  });

  it('BDA141-L1: an offline start waits for `online`, no answer parks it again (3 starts at most), one run at a time', async () => {
    let offline = false;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      if (offline && String(input).endsWith('/logout')) throw new TypeError('Failed to fetch');
      return nodeFetch(input, init);
    }) as unknown as typeof fetch;
    const platform = browserPlatform('0.1.0', fetchImpl);
    const ui = await signIn(mount({ platform }));
    await connectTasks(ui);
    await env.control('config', { tasksLogout: 'unavailable' });
    await ui.app.logout();
    expect(platform.hooks.tasksRevokeParked).toHaveLength(1);
    await env.control('config', { tasksLogout: 'ok' });
    const sent = (await logouts()).length;
    // An autostart before the network: nothing is spent while the webview says it is offline.
    const onLine = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      const start = mount({ platform });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(platform.hooks.tasksRevokeRuns).toBe(0);
      expect(platform.hooks.tasksRevokeParked).toHaveLength(1);
      // Online: exactly one successful POST.
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
      window.dispatchEvent(new Event('online'));
      await until(() => platform.hooks.tasksRevokeParked.length === 0 && platform.hooks.tasksRevokeRuns === 1, 'the retry once online');
      expect((await logouts()).slice(sent)).toEqual([{ mode: 'ok', known: true }]);
      // Two calls at once: one run (the second joins it).
      platform.hooks.tasksRevokeParked = [{ server: env.url, token: 'parked-token', attempts: 0 }];
      await Promise.all([start.shell.tasks?.retryParkedLogout(), start.shell.tasks?.retryParkedLogout()]);
      expect(platform.hooks.tasksRevokeRuns).toBe(2);
      expect((await logouts()).slice(sent)).toHaveLength(2);
    } finally {
      if (onLine !== undefined) Object.defineProperty(navigator, 'onLine', onLine);
      else Reflect.deleteProperty(navigator, 'onLine');
    }
    // "Online" but no answer at all (a captive network): parked again, at most 3 starts in all.
    platform.hooks.tasksRevokeParked = [{ server: env.url, token: 'parked-token', attempts: 0 }];
    offline = true;
    expect(await platform.tasks?.retryRevoke?.()).toBe('parked');
    expect(platform.hooks.tasksRevokeParked).toEqual([{ server: env.url, token: 'parked-token', attempts: 1 }]);
    expect(await platform.tasks?.retryRevoke?.()).toBe('parked');
    expect(await platform.tasks?.retryRevoke?.()).toBe('failed');
    expect(platform.hooks.tasksRevokeParked).toEqual([]);
  });

  it('BDA141-I3: a second failed logout keeps the first parked token; both are retried', async () => {
    const platform = browserPlatform('0.1.0', nodeFetch);
    const ui = await signIn(mount({ platform }));
    await env.control('config', { tasksLogout: 'unavailable' });
    await connectTasks(ui);
    const first = platform.hooks.tasksToken;
    await ui.shell.tasks?.disconnect();
    await connectTasks(ui);
    const second = platform.hooks.tasksToken;
    await ui.shell.tasks?.disconnect();
    expect(platform.hooks.tasksRevokeParked.map((item) => item.token)).toEqual([first, second]);
    await env.control('config', { tasksLogout: 'ok' });
    expect(await platform.tasks?.retryRevoke?.()).toBe('revoked,revoked');
    expect(platform.hooks.tasksRevokeParked).toEqual([]);
  });

  it('BDA141-L2/L3: Clear local data revokes chat and tasks on the server, keeps nothing parked and leaves no view keys', async () => {
    const platform = browserPlatform('0.1.0', nodeFetch);
    const ui = await signIn(mount({ platform }));
    ui.$<HTMLButtonElement>('#tab-chat').click();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
    await until(() => ui.shell.chat.connected, 'chat');
    await connectTasks(ui);
    // An older token waits for its retry (the server was busy then).
    platform.hooks.tasksRevokeParked = [{ server: env.url, token: 'older-token', attempts: 0 }];
    for (const key of ['beacon-desktop-chat-view', 'beacon-desktop-chat-notify', 'beacon-desktop-tasks-view']) localStorage.setItem(key, '{}');
    const chatLogouts = ((await env.control('chat/state')) as { logouts: number }).logouts;
    const tasksLogouts = (await logouts()).length;
    await ui.app.clearLocalData();
    expect(((await env.control('chat/state')) as { logouts: number }).logouts).toBe(chatLogouts + 1);
    expect((await logouts()).slice(tasksLogouts)).toEqual([
      { mode: 'ok', known: true },
      { mode: 'ok', known: false },
    ]);
    expect(platform.hooks.tasksRevokeParked).toEqual([]);
    expect(platform.hooks.tasksToken).toBeNull();
    expect(platform.hooks.chatToken).toBeNull();
    expect(Object.keys(localStorage).filter((key) => key.startsWith('beacon-desktop'))).toEqual([]);
  });
});

describe('Settings with a stale "not offered" (BDA141-I4)', () => {
  it('connected tasks never read as turned off, whatever was cached', async () => {
    const ui = await signIn(mount());
    await connectTasks(ui);
    localStorage.setItem(OFFER_KEY, JSON.stringify({ [origin()]: false }));
    expect(ui.shell.tasks?.unavailable).toBe(false);
    expect(ui.shell.tasksHidden).toBe(false);
    ui.shell.openSettings('tasks');
    expect(ui.$('#shell-settings').textContent).not.toContain('Turned off in Beacon');
    expect(ui.$('#shell-settings').textContent).toContain('Connected');
  });
});

describe('first run and "Finish setup" (0.14.1)', () => {
  it('Chat approved: the Tasks code is asked for at once; Later still ends it', async () => {
    localStorage.removeItem(SHELL_KEY);
    const ui = await signIn(mount({ freshSignIn: true }));
    await until(() => ui.shell.setupShown, 'the setup');
    ui.$<HTMLButtonElement>('#setup-connect').click();
    await until(() => ui.$('#setup-code') !== null, 'the chat code');
    const chatCode = ui.$('#setup-code').textContent;
    await env.control('device/approve', { userCode: chatCode });
    await until(() => ui.$('#setup-step-tasks')?.getAttribute('aria-current') === 'step' && ui.$('#setup-code') !== null, 'the tasks code, no click');
    expect(ui.platform.hooks.tasksConnectBegins).toBe(1);
    expect(ui.$('#setup-code').textContent).not.toBe(chatCode);
    // "Later" cancels it and ends the setup.
    ui.$<HTMLButtonElement>('#setup-later').click();
    expect(ui.shell.setupShown).toBe(false);
    expect(ui.shell.tasks?.connect.kind).toBe('idle');
    // Tasks are left: the chip says so.
    await until(() => ui.$('#setup-chip') !== null, 'the chip');
    expect(ui.$('#setup-chip').textContent).toBe('Finish setup');
    expect(ui.$('#setup-chip-hint').textContent).toBe('Tasks are not connected yet.');
  });

  it('the chip opens the pending step, × hides it for this server and organization, and it goes once all is connected', async () => {
    localStorage.removeItem(SHELL_KEY);
    const ui = await signIn(mount({ freshSignIn: true, locale: 'es' }));
    await until(() => ui.shell.setupShown, 'the setup');
    // Nothing on screen while the setup card is.
    expect(ui.$('#setup-chip')).toBeNull();
    ui.$<HTMLButtonElement>('#setup-skip').click();
    ui.$<HTMLButtonElement>('#setup-later').click();
    await until(() => ui.$('#setup-chip') !== null, 'the chip');
    expect(ui.$('#setup-chip').textContent).toBe('Terminar configuración');
    expect(ui.$('#setup-chip-hint').textContent).toBe('El chat aún no está conectado.');
    expect(ui.$('#setup-chip-dismiss').getAttribute('aria-label')).toBe('Ocultar «Terminar configuración»');
    // Opens the setup at the step skipped before.
    ui.$<HTMLButtonElement>('#setup-chip').click();
    expect(ui.shell.setupShown).toBe(true);
    expect(ui.$('#setup-step-chat').getAttribute('aria-current')).toBe('step');
    expect(ui.$('#setup-chip')).toBeNull();
    ui.$<HTMLButtonElement>('#setup-later').click();
    // × : hidden, remembered for this server and organization; focus goes to the search, the change is announced.
    ui.$<HTMLButtonElement>('#setup-chip-dismiss').click();
    expect(ui.$('#setup-chip')).toBeNull();
    expect(document.activeElement?.id).toBe('tb-search');
    await until(() => ui.$('#shell-live').textContent?.startsWith('Oculto.') === true, 'the announcement');
    expect(JSON.parse(localStorage.getItem(SETUP_CHIP_KEY) ?? '[]')).toEqual([`${origin()}|personal`]);
    // Another organization: shown there (not dismissed there).
    await until(() => ui.$(`.ctx-tile[data-context="${ORG}"]`) !== null, 'the organization tiles');
    ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
    await until(() => ui.shell.context === ORG, 'the organization');
    await until(() => ui.$('#setup-chip') !== null, 'the chip there');
    // Everything connected: it goes by itself.
    ui.$<HTMLButtonElement>('#tab-chat').click();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
    await until(() => ui.shell.chat.connected, 'chat');
    expect(ui.shell.setupPending()).toBe('tasks');
    await connectTasks(ui);
    expect(ui.shell.setupPending()).toBeNull();
    await until(() => ui.$('#setup-chip') === null, 'no chip');
  });
});

describe('status strip: the band reserved in tall windows only (0.14.1)', () => {
  function fakeTall(matches: boolean) {
    const listeners: (() => void)[] = [];
    const query: TallQuery & { set(value: boolean): void } = {
      matches,
      addEventListener: (_type, listener) => void listeners.push(listener),
      set(value: boolean) {
        (this as { matches: boolean }).matches = value;
        for (const listener of listeners) listener();
      },
    };
    return query;
  }

  it('overlays below 720 px, reserves from 720 px, and never switches while a message shows', () => {
    const tall = fakeTall(false);
    const modes: string[] = [];
    const strip = new StatusStrip({ id: 'x', dismissLabel: 'Dismiss', overlay: true, tall, onMode: (mode) => modes.push(mode) });
    expect(strip.root.dataset.mode).toBe('overlay');
    strip.show({ key: 'offline', text: 'You are offline.', tone: 'warn' });
    // Resized past the threshold while the message shows: no jump.
    tall.set(true);
    expect(strip.root.dataset.mode).toBe('overlay');
    expect(modes).toEqual([]);
    // The message goes: the new mode now.
    strip.show(null);
    expect(strip.root.dataset.mode).toBe('reserved');
    expect(modes).toEqual(['reserved']);
    // With nothing shown, a resize applies at once.
    tall.set(false);
    expect(strip.root.dataset.mode).toBe('overlay');
    // A dismissed message counts as gone.
    tall.set(true);
    strip.show({ key: 'rate', text: 'Paused.', tone: 'info' });
    tall.set(false);
    expect(strip.root.dataset.mode).toBe('reserved');
    strip.dismiss();
    expect(strip.root.dataset.mode).toBe('overlay');
    expect(modes).toEqual(['reserved', 'overlay', 'reserved', 'overlay']);
  });

  it('strips without overlay (Time) always reserve; the default query is the window height', () => {
    expect(new StatusStrip({ id: 'y', dismissLabel: 'Dismiss', tall: fakeTall(false) }).root.dataset.mode).toBe('reserved');
    // happy-dom's window here is 400 × 640: below the threshold.
    expect(new StatusStrip({ id: 'z', dismissLabel: 'Dismiss', overlay: true }).root.dataset.mode).toBe('overlay');
    expect(new StatusStrip({ id: 'w', dismissLabel: 'Dismiss', overlay: true, tall: null }).root.dataset.mode).toBe('reserved');
  });

  it('chat and tasks strips are overlay-capable; the chat strip sits in the timeline box, above the message box', async () => {
    const ui = await signIn(mount());
    ui.$<HTMLButtonElement>('#tab-chat').click();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
    await until(() => ui.$('#chat-banner-strip') !== null, 'the chat page');
    await connectTasks(ui);
    await until(() => ui.$('#tasks-banner-strip') !== null, 'the tasks page');
    expect(ui.$('#chat-banner-strip').dataset.mode).toBe('overlay');
    expect(ui.$('#chat-banner-strip').parentElement?.classList.contains('msgs-wrap')).toBe(true);
    expect(ui.$('#tasks-banner-strip').dataset.mode).toBe('overlay');
    expect(ui.$('#time-strip-strip').dataset.mode).toBe('reserved');
  });
});
