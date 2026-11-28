// @vitest-environment happy-dom
// 0.14.2 against the in-process mock Beacon: Rust refuses a chat / tasks connect started while nobody is at the app
// (`sign_in_not_present`: window not focused or no recent input). The first run's Chat → Tasks chain waits for the
// window to come back and for the server's tasks answer; the refusal itself says "come back and press Connect", never
// the network text.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectErrorMessage } from '../../src/chat/module';
import { chatText } from '../../src/chat/i18n';
import { SIGN_IN_NOT_PRESENT, isSignInDeclined, isSignInNotPresent } from '../../src/lib/nativeFetch';
import { browserPlatform } from '../../src/platform';
import { SHELL_KEY, Shell } from '../../src/shell/shell';
import { OFFER_KEY } from '../../src/tasks/module';
import { tasksText } from '../../src/tasks/i18n';
import { DesktopApp } from '../../src/ui/app';
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds the tasks offer probe (the first `device/code` for the `tasks` family) until `release()`. */
function gatedFetch() {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let held = 0;
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    if (String(input).endsWith('/device/code') && typeof init.body === 'string' && init.body.includes('"family":"tasks"') && held === 0) {
      held += 1;
      await gate;
    }
    return nodeFetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, release: () => open() };
}

function mount(options: { platform?: ReturnType<typeof browserPlatform>; locale?: 'en' | 'es' } = {}) {
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
    beforeSignOut: () => shell.revokeOnServer(),
    clearParked: () => shell.clearParked(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
  });
  shell.attach(app);
  shell.freshSignIn = true;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  return { platform, shell, app, $ };
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

/** Connects chat from the setup card; the approval happens "in the browser". */
async function approveChat(ui: ReturnType<typeof mount>) {
  await until(() => ui.shell.setupShown, 'the setup');
  ui.$<HTMLButtonElement>('#setup-connect').click();
  await until(() => ui.$('#setup-code') !== null, 'the chat code');
  await env.control('device/approve', { userCode: ui.$('#setup-code').textContent });
  await until(() => ui.shell.chat.connected, 'chat connected');
}

const offers = () => JSON.parse(localStorage.getItem(OFFER_KEY) ?? '{}') as Record<string, boolean>;
const origin = () => new URL(env.url).origin;
let focused = true;

beforeEach(async () => {
  localStorage.clear();
  localStorage.removeItem(SHELL_KEY);
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  await env.control('reset', {});
  await env.control('config', { deviceInterval: 1 });
});
afterEach(() => vi.restoreAllMocks());

describe('sign_in_not_present in words (0.14.2)', () => {
  it('is recognised as the bare string Tauri rejects with and as an Error; still a quiet decline for the sign-in', () => {
    expect(isSignInNotPresent(SIGN_IN_NOT_PRESENT)).toBe(true);
    expect(isSignInNotPresent(new Error(SIGN_IN_NOT_PRESENT))).toBe(true);
    expect(isSignInNotPresent('network')).toBe(false);
    expect(isSignInDeclined(SIGN_IN_NOT_PRESENT)).toBe(true);
  });

  it('chat: come back and press Connect, never the network text', () => {
    expect(connectErrorMessage(SIGN_IN_NOT_PRESENT, chatText('en'))).toBe('Come back to Beacon Desktop and press Connect to continue.');
    expect(connectErrorMessage(SIGN_IN_NOT_PRESENT, chatText('es'))).toBe('Vuelve a Beacon Desktop y pulsa Conectar para continuar.');
    expect(connectErrorMessage(SIGN_IN_NOT_PRESENT, chatText('en'))).not.toBe(chatText('en')('connectFailed'));
  });

  it('chat from the setup card: the new text, and Connect works again once the person is back', async () => {
    const ui = await signIn(mount({ locale: 'es' }));
    await until(() => ui.shell.setupShown, 'the setup');
    ui.platform.hooks.connectAway = true;
    ui.$<HTMLButtonElement>('#setup-connect').click();
    await until(() => ui.$('#setup-step-chat .cc-error') !== null, 'the message');
    expect(ui.$('#setup-step-chat .cc-error').textContent).toBe('Vuelve a Beacon Desktop y pulsa Conectar para continuar.');
    expect(ui.$<HTMLButtonElement>('#setup-connect').disabled).toBe(false);
    expect(ui.platform.hooks.chatConnectBegins).toBe(0);
    ui.platform.hooks.connectAway = false;
    ui.$<HTMLButtonElement>('#setup-connect').click();
    await until(() => ui.$('#setup-code') !== null, 'the chat code');
    expect(ui.platform.hooks.chatConnectBegins).toBe(1);
  });

  it('tasks module: the new text in both languages', async () => {
    expect(tasksText('en')('connectNotPresent')).toBe('Come back to Beacon Desktop and press Connect to continue.');
    expect(tasksText('es')('connectNotPresent')).toBe('Vuelve a Beacon Desktop y pulsa Conectar para continuar.');
    localStorage.setItem(SHELL_KEY, JSON.stringify({ setup: 'done', module: 'time' }));
    const ui = await signIn(mount());
    await until(() => offers()[origin()] === true, 'offered');
    ui.platform.hooks.connectAway = true;
    ui.$<HTMLButtonElement>('#tab-tasks').click();
    ui.$<HTMLButtonElement>('#tasks-connect').click();
    await until(() => ui.shell.tasks?.connect.kind === 'idle' && ui.shell.tasks.connect.message !== null, 'the message');
    expect(ui.shell.tasks?.connect).toMatchObject({ message: 'Come back to Beacon Desktop and press Connect to continue.' });
    expect(ui.$('#mod-tasks').textContent).toContain('Come back to Beacon Desktop and press Connect to continue.');
    expect(ui.$<HTMLButtonElement>('#tasks-connect').disabled).toBe(false);
    // A refusal for presence never says the server lacks tasks.
    expect(offers()[origin()]).toBe(true);
  });
});

describe('the Chat → Tasks chain waits (0.14.2)', () => {
  it('waits for the window to come back, then asks for the Tasks code', async () => {
    const ui = await signIn(mount());
    await until(() => offers()[origin()] === true, 'offered');
    await until(() => ui.shell.setupShown, 'the setup');
    ui.$<HTMLButtonElement>('#setup-connect').click();
    await until(() => ui.$('#setup-code') !== null, 'the chat code');
    // The person is in the browser approving: the window is not focused.
    focused = false;
    await env.control('device/approve', { userCode: ui.$('#setup-code').textContent });
    await until(() => ui.$('#setup-step-tasks')?.getAttribute('aria-current') === 'step', 'the tasks step');
    await pause(100);
    expect(ui.platform.hooks.tasksConnectBegins).toBe(0);
    expect(ui.$('#setup-code')).toBeNull();
    expect(ui.$('#setup-step-tasks .cc-error')).toBeNull();
    // A focus event while still away (another window of the app, say) changes nothing.
    globalThis.dispatchEvent(new Event('focus'));
    await pause(50);
    expect(ui.platform.hooks.tasksConnectBegins).toBe(0);
    // Back in the app: the code comes without a click.
    focused = true;
    globalThis.dispatchEvent(new Event('focus'));
    await until(() => ui.$('#setup-code') !== null, 'the tasks code');
    expect(ui.platform.hooks.tasksConnectBegins).toBe(1);
    // Once only: another focus does not start it again.
    globalThis.dispatchEvent(new Event('focus'));
    await pause(50);
    expect(ui.platform.hooks.tasksConnectBegins).toBe(1);
  });

  it('starts at once when the window is focused and the server is known to offer tasks', async () => {
    const ui = await signIn(mount());
    await until(() => offers()[origin()] === true, 'offered');
    await approveChat(ui);
    await until(() => ui.$('#setup-code') !== null, 'the tasks code');
    expect(ui.platform.hooks.tasksConnectBegins).toBe(1);
  });

  it('waits for the offer probe while it is unknown, then starts', async () => {
    const gated = gatedFetch();
    const ui = await signIn(mount({ platform: browserPlatform('0.1.0', gated.fetchImpl) }));
    await approveChat(ui);
    await until(() => ui.$('#setup-step-tasks')?.getAttribute('aria-current') === 'step', 'the tasks step');
    await pause(100);
    expect(offers()[origin()]).toBeUndefined();
    expect(ui.platform.hooks.tasksConnectBegins).toBe(0);
    gated.release();
    await until(() => ui.$('#setup-code') !== null, 'the tasks code');
    expect(offers()[origin()]).toBe(true);
    expect(ui.platform.hooks.tasksConnectBegins).toBe(1);
  });

  it('never starts when the probe answers "not offered": the step goes and the setup ends', async () => {
    const gated = gatedFetch();
    await env.control('config', { chatOnly: true });
    const ui = await signIn(mount({ platform: browserPlatform('0.1.0', gated.fetchImpl) }));
    await until(() => ui.$('#setup-step-tasks') !== null, 'the tasks step while unknown');
    await approveChat(ui);
    await pause(100);
    expect(ui.platform.hooks.tasksConnectBegins).toBe(0);
    gated.release();
    await until(() => !ui.shell.setupShown, 'the end of the setup');
    expect(offers()[origin()]).toBe(false);
    expect(ui.platform.hooks.tasksConnectBegins).toBe(0);
  });

  it('Skip while waiting drops the chain: focus later starts nothing', async () => {
    const ui = await signIn(mount());
    await until(() => offers()[origin()] === true, 'offered');
    await until(() => ui.shell.setupShown, 'the setup');
    ui.$<HTMLButtonElement>('#setup-connect').click();
    await until(() => ui.$('#setup-code') !== null, 'the chat code');
    focused = false;
    await env.control('device/approve', { userCode: ui.$('#setup-code').textContent });
    await until(() => ui.$('#setup-step-tasks')?.getAttribute('aria-current') === 'step', 'the tasks step');
    ui.$<HTMLButtonElement>('#setup-skip').click();
    await until(() => !ui.shell.setupShown, 'the end of the setup');
    focused = true;
    globalThis.dispatchEvent(new Event('focus'));
    await pause(50);
    expect(ui.platform.hooks.tasksConnectBegins).toBe(0);
  });
});
