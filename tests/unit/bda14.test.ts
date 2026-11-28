// @vitest-environment happy-dom
// Beacon Desktop 0.14.0 audit fixes, through the DOM against the in-process mock Beacon: the quick switcher never lists
// the previous organization's Time tasks (BDA14-L1), messages waiting in the offline queue are never dropped without a
// question or an announcement (BDA14-L3), Time's `429` automatic retry is capped (BDA14-I2) and the short "You're in"
// line in the compact layout (BDA14-L5).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { Shell } from '../../src/shell/shell';
import { DesktopApp, rateRetryWait, TIME_AUTO_RETRIES } from '../../src/ui/app';
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

/**
 * Holds the time API's task lists of one context until released (an answer that arrives after an organization switch).
 */
function gatedFetch() {
  const gate = { context: null as string | null, release: null as (() => void) | null, held: 0 };
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (gate.context !== null && input.includes('/api/time-track/') && /\/tasks(\?|$)/.test(input) && headers['X-Beacon-Context'] === gate.context) {
      gate.held += 1;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    }
    return nodeFetch(input, init);
  }) as unknown as typeof fetch;
  return { gate, fetchImpl };
}

function mount(options: { width?: number; fetchImpl?: typeof fetch } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.1.0', options.fetchImpl ?? nodeFetch);
  const shell = new Shell(root, platform, { locale: 'en', storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, {
    storage: localStorage,
    locale: 'en',
    onRender: () => shell.onAppRender(),
    beforeSignOut: () => shell.chat.revokeOnServer(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
    ...(options.width !== undefined ? { viewportWidth: () => options.width as number } : {}),
  });
  shell.attach(app);
  shell.freshSignIn = true;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  return { root, platform, shell, app, $ };
}

async function signedIn(options: { width?: number; fetchImpl?: typeof fetch } = {}) {
  const ui = mount(options);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
  await done;
  return ui;
}

async function connected(options: { fetchImpl?: typeof fetch } = {}) {
  const ui = await signedIn(options);
  ui.$<HTMLButtonElement>('#tab-chat').click();
  ui.$<HTMLButtonElement>('#chat-connect').click();
  await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
  await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
  await until(() => ui.$('.side .conv') !== null, 'the conversations');
  ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
  await until(() => ui.$(`[data-conv="${ENVELOPE}"]`) !== null && ui.app.context === ORG, 'the organization list');
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

/** One message waiting for the connection in the open conversation (writes fail with a `503`). */
async function queueOne(ui: Awaited<ReturnType<typeof connected>>, text = 'Written on the train'): Promise<void> {
  await env.control('config', { chatFailNext: { status: 503, error: 'server_error', writesOnly: true, times: 1000 } });
  type(ui.$<HTMLTextAreaElement>('#composer'), text);
  enter(ui.$<HTMLTextAreaElement>('#composer'));
  await until(() => document.querySelector('#msg-list li.msg.pending.queued') !== null, 'the queued message');
  await until(() => ui.platform.hooks.unsent === 1, 'the count reported to the host');
}

const confirmOpen = () => (document.querySelector('#shell-confirm') as HTMLDialogElement).open;
const switcherTitles = () => [...document.querySelectorAll('#sw-list [data-module="time"]')].map((node) => node.textContent ?? '');

describe('BDA14 audit fixes', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1, contextTasks: { personal: ['T-101', 'T-102'], [ORG]: ['T-104', 'T-105'] } });
  });

  it('BDA14-L1: the quick switcher never lists the previous organization’s Time tasks, and a late answer is dropped', async () => {
    const { gate, fetchImpl } = gatedFetch();
    const ui = await connected({ fetchImpl });
    await until(() => !ui.app.busy && ui.app.tasks.some((task) => task.id === 'T-104'), "the organization's tasks");
    expect(ui.app.tasks.map((task) => task.id)).toEqual(['T-104', 'T-105']);
    // A search in the organization is still on its way when the person switches to Personal.
    gate.context = ORG;
    const search = ui.app.search('invoice');
    await until(() => gate.held === 1, 'the held search');
    ui.shell.openSwitcher();
    const input = ui.$<HTMLInputElement>('#sw-input');
    input.value = 'invoice';
    input.dispatchEvent(new Event('input'));
    expect(switcherTitles().some((title) => title.includes('Fix invoice rounding bug'))).toBe(true);
    ui.$<HTMLButtonElement>('.ctx-tile[data-context="personal"]').click();
    await until(() => ui.app.context === 'personal', 'the switch');
    // The open switcher follows the switch at once: the organization's task is gone before anything reloads.
    expect((document.querySelector('#switcher') as HTMLDialogElement).open).toBe(true);
    expect(switcherTitles().some((title) => title.includes('Fix invoice rounding bug'))).toBe(false);
    await until(() => !ui.app.busy, 'the Personal refresh');
    // The organization's answer arrives last: it never replaces Personal's list.
    gate.context = null;
    gate.release?.();
    await search;
    expect(ui.app.tasks.some((task) => task.id === 'T-104' || task.id === 'T-105')).toBe(false);
    input.dispatchEvent(new Event('input'));
    expect(switcherTitles().some((title) => title.includes('Fix invoice rounding bug'))).toBe(false);
  });

  it('BDA14-L3: an organization switch with a message waiting asks first; Cancel keeps it, Discard drops it', async () => {
    const ui = await connected();
    await queueOne(ui);
    ui.$<HTMLButtonElement>('.ctx-tile[data-context="personal"]').click();
    await until(confirmOpen, 'the question');
    expect(ui.$('#shell-confirm-title').textContent).toBe('1 message is waiting to send. Discard it?');
    expect(ui.$('#shell-confirm .dlg-b').textContent).toBe('It is only on this computer and cannot be recovered.');
    expect(ui.$('#confirm-ok').textContent).toBe('Discard and switch');
    // Cancel is the default (focused first).
    expect(document.activeElement).toBe(ui.$('#confirm-cancel'));
    ui.$<HTMLButtonElement>('#confirm-cancel').click();
    await until(() => !confirmOpen(), 'the closed question');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ui.app.context).toBe(ORG);
    expect(ui.shell.chat.unsentCount()).toBe(1);
    ui.$<HTMLButtonElement>('.ctx-tile[data-context="personal"]').click();
    await until(confirmOpen, 'the question again');
    ui.$<HTMLButtonElement>('#confirm-ok').click();
    await until(() => ui.app.context === 'personal', 'the switch');
    expect(ui.shell.chat.unsentCount()).toBe(0);
    expect(ui.platform.hooks.unsent).toBe(0);
  });

  it('BDA14-L3: a drop with no question (a refused organization) is announced', async () => {
    const ui = await connected();
    await queueOne(ui);
    const announced: string[] = [];
    const live = ui.$('#shell-live');
    const observer = new MutationObserver(() => announced.push(live.textContent ?? ''));
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    await ui.shell.chat.refuseContext(ORG);
    await until(() => announced.includes('1 unsent message was discarded.'), 'the announcement');
    observer.disconnect();
    expect(ui.shell.chat.unsentCount()).toBe(0);
  });

  it('BDA14-L3: sign-out, Disconnect chat and Quit ask while a message waits; nothing waiting quits at once', async () => {
    const ui = await connected();
    // Nothing waiting: the tray's Quit ends the app with no question.
    ui.platform.hooks.quitRequest();
    expect(ui.platform.hooks.quits).toBe(1);
    expect(confirmOpen()).toBe(false);
    await queueOne(ui);
    // Quit: asked in the main window; Cancel keeps the app running.
    ui.platform.hooks.quitRequest();
    await until(confirmOpen, 'the quit question');
    expect(ui.$('#confirm-ok').textContent).toBe('Discard and quit');
    ui.$<HTMLButtonElement>('#confirm-cancel').click();
    await until(() => !confirmOpen(), 'closed');
    expect(ui.platform.hooks.quits).toBe(1);
    ui.platform.hooks.quitRequest();
    await until(confirmOpen, 'the quit question again');
    ui.$<HTMLButtonElement>('#confirm-ok').click();
    await until(() => ui.platform.hooks.quits === 2, 'the confirmed quit');
    // Disconnect chat: one question that also names the waiting message.
    const disconnect = ui.shell.disconnectModule('chat');
    await until(confirmOpen, 'the disconnect question');
    expect(ui.$('#shell-confirm .dlg-b').textContent).toMatch(/^1 message is waiting to send\. Discard it\? Your conversations leave this computer/);
    ui.$<HTMLButtonElement>('#confirm-cancel').click();
    await disconnect;
    expect(ui.shell.chat.connected).toBe(true);
    // Sign-out: asked first; Cancel keeps the session.
    ui.shell.openSettings('account');
    ui.$<HTMLButtonElement>('#logout').click();
    await until(confirmOpen, 'the sign-out question');
    expect(ui.$('#confirm-ok').textContent).toBe('Discard and sign out');
    ui.$<HTMLButtonElement>('#confirm-cancel').click();
    await until(() => !confirmOpen(), 'closed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ui.app.state.session).not.toBeNull();
    ui.$<HTMLButtonElement>('#logout').click();
    await until(confirmOpen, 'the sign-out question again');
    ui.$<HTMLButtonElement>('#confirm-ok').click();
    await until(() => ui.app.state.session === null, 'signed out');
    expect(ui.platform.hooks.unsent).toBe(0);
  });

  it('BDA14-I2: the 429 wait honours Retry-After with a growing floor, and stops retrying on its own after 3', async () => {
    expect(TIME_AUTO_RETRIES).toBe(3);
    expect([0, 1, 2, 3].map((attempt) => rateRetryWait(0, attempt))).toEqual([1, 2, 4, 8]);
    expect(rateRetryWait(20, 1)).toBe(20);
    expect(rateRetryWait(undefined, 0)).toBe(30);
    const ui = await signedIn();
    const timerReads = async () => ((await env.control('state')) as { requests: { path: string }[] }).requests.filter((item) => item.path.endsWith('/timer')).length;
    // Every answer is a 429: the first one and three automatic retries, then nothing more on its own.
    await env.control('config', { failNext: { status: 429, error: 'rate_limited', retryAfter: 1, times: 100 } });
    const before = await timerReads();
    await ui.app.refresh();
    const end = () => {
      const rate = ui.app.rateLimit;
      if (rate !== null) rate.until = Date.now() - 1;
      ui.app.render();
    };
    for (let attempt = 1; attempt <= TIME_AUTO_RETRIES; attempt += 1) {
      expect(ui.app.rateLimit?.attempt).toBe(attempt - 1);
      end();
      await until(() => ui.app.rateLimit?.attempt === attempt, `automatic retry ${attempt}`);
    }
    expect(ui.app.rateLimit?.held).toBe(true);
    const spent = await timerReads();
    expect(spent - before).toBe(1 + TIME_AUTO_RETRIES);
    end();
    await until(() => ui.$('#time-strip-retry') !== null, 'the Retry button');
    expect(ui.$('#time-strip-text').textContent).toBe("Beacon is still busy. Try again when you're ready.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await timerReads()).toBe(spent);
    // The person's Retry: Beacon answers now, the strip goes.
    await env.control('config', { failNext: null });
    ui.$<HTMLButtonElement>('#time-strip-retry').click();
    await until(() => ui.app.rateLimit === null && !ui.app.busy, 'the answer');
    expect(await timerReads()).toBeGreaterThan(spent);
    expect(ui.$('#time-strip-retry')).toBeNull();
  });

  it('BDA14-L5: "You\'re in" is the short line in the compact layout, the full one when wide', async () => {
    const narrow = await signedIn({ width: 400 });
    await until(() => narrow.$('#time-strip-text') !== null, 'the strip');
    expect(narrow.$('#time-strip-text').textContent).toBe("You're in, Ada Lovelace.");
    const wide = await signedIn({ width: 1280 });
    await until(() => wide.$('#time-strip-text') !== null, 'the strip');
    expect(wide.$('#time-strip-text').textContent).toBe("You're in, Ada Lovelace. Pick a task and press Start.");
  });
});
