// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_POSES, EMPTY_STATES, EMPTY_TEXTS, PIN_HINT, quickEmptyState } from '../../src/lib/emptyStates';
import { MESSAGE_LOCALES } from '../../src/lib/friendly';
import { copyableUrl, externalUrl, sanitizeBrowser, SYSTEM_BROWSER } from '../../src/lib/links';
import { loadLocal, saveLocal, emptyState as emptyLocal } from '../../src/lib/settings';
import { tasksPage } from '../../src/lib/urls';
import { browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { emptyArt, poseFile } from '../../src/ui/mascot';
import { nodeFetch, startMock, until } from './helpers';

/** "Open Beacon in", every link through openExternal, "Copy link", and the empty states of the list (0.5.0). */
let env: Awaited<ReturnType<typeof startMock>>;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const BEACON = 'https://beacon.example.test';

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

function mount(options: { locale?: 'en' | 'es'; storeUrl?: string; channel?: 'direct' | 'store' } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.5.0', nodeFetch);
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale: options.locale ?? 'en',
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 5,
    storeUrl: options.storeUrl,
    channel: options.channel,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  return { app, platform, hooks: platform.hooks, root, $, click: (selector: string) => $(selector).click() };
}

async function signedIn(options: Parameters<typeof mount>[0] = {}) {
  const ui = mount(options);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent ?? '' });
  await done;
  expect(ui.app.view).toBe('main');
  ui.hooks.opened.length = 0;
  ui.hooks.openedWith.length = 0;
  return ui;
}

/** The session as if connected to an https Beacon (links are only drawn for https servers). */
function onHttpsBeacon(ui: Awaited<ReturnType<typeof signedIn>>): void {
  ui.app.state.session = { ...ui.app.state.session!, server: BEACON };
  ui.app.render();
}

describe('link rules', () => {
  it('Beacon links must be on the connected server; help links https; device links on the server host', () => {
    expect(externalUrl(`${BEACON}/dashboard`, { kind: 'beacon', server: BEACON })).toBe(`${BEACON}/dashboard`);
    expect(externalUrl('https://evil.example/dashboard', { kind: 'beacon', server: BEACON })).toBeNull();
    expect(externalUrl('http://beacon.example.test/dashboard', { kind: 'beacon', server: BEACON })).toBeNull();
    expect(externalUrl(`${BEACON}/x`, { kind: 'beacon', server: null })).toBeNull();
    // A development Beacon on this computer: its own http pages only.
    expect(externalUrl('http://localhost:8000/dashboard', { kind: 'beacon', server: 'http://localhost:8000' })).toBe('http://localhost:8000/dashboard');
    expect(externalUrl('http://localhost:9000/dashboard', { kind: 'beacon', server: 'http://localhost:8000' })).toBeNull();
    expect(externalUrl('http://u:p@localhost:8000/', { kind: 'beacon', server: 'http://localhost:8000' })).toBeNull();
    expect(externalUrl('http://beacon.lan:8000/', { kind: 'beacon', server: 'http://beacon.lan:8000' })).toBeNull();
    expect(externalUrl('http://localhost:8000/', { kind: 'beacon', server: 'not a url' })).toBeNull();
    expect(externalUrl('https://apps.microsoft.com/detail/9N', { kind: 'help' })).toBe('https://apps.microsoft.com/detail/9N');
    for (const bad of ['http://apps.microsoft.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@example.com/', 'nonsense', '']) {
      expect(externalUrl(bad, { kind: 'help' }), bad).toBeNull();
    }
    expect(externalUrl(undefined, { kind: 'help' })).toBeNull();
    expect(externalUrl(`${BEACON}/device?user_code=ABCD`, { kind: 'device', server: BEACON })).toBe(`${BEACON}/device?user_code=ABCD`);
    expect(externalUrl('https://other.example/device', { kind: 'device', server: BEACON })).toBeNull();
  });

  it('copied links never carry credentials or secret parameters', () => {
    const rule = { kind: 'help' } as const;
    expect(copyableUrl('https://b.example/x?token=abc&page=2&API_KEY=k&signature=s&access_token=t&code=c', rule)).toBe('https://b.example/x?page=2');
    expect(copyableUrl('https://b.example/x#access_token=abc', rule)).toBe('https://b.example/x');
    expect(copyableUrl('https://b.example/x#section', rule)).toBe('https://b.example/x#section');
    // The sign-in page keeps the code the person types anyway.
    expect(copyableUrl(`${BEACON}/device?user_code=ABCD-EFGH`, { kind: 'device', server: BEACON })).toBe(`${BEACON}/device?user_code=ABCD-EFGH`);
    // Same checks as opening: credentials or another origin are not copied at all.
    expect(copyableUrl('https://u:p@b.example/x', rule)).toBeNull();
    expect(copyableUrl('https://evil.example/x', { kind: 'beacon', server: BEACON })).toBeNull();
  });

  it("the host's browser choice is sanitised; the window's storage no longer keeps one (GC-L1)", () => {
    expect(sanitizeBrowser({ kind: 'detected', id: 'win:brave', name: 'Brave' })).toEqual({ kind: 'detected', id: 'win:brave', name: 'Brave' });
    expect(sanitizeBrowser({ kind: 'custom', path: '/opt/b/brave', name: 'brave' })).toEqual({ kind: 'custom', path: '/opt/b/brave', name: 'brave' });
    for (const bad of [null, 'brave', 3, {}, { kind: 'shell', cmd: 'x' }, { kind: 'detected', id: '' , name: 'X' }, { kind: 'detected', id: 'x' }, { kind: 'custom', path: ' ', name: 'b' }, { kind: 'custom', path: 'x'.repeat(5000), name: 'b' }]) {
      expect(sanitizeBrowser(bad)).toEqual(SYSTEM_BROWSER);
    }
    const storage = new Map<string, string>();
    const fake = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } as Storage;
    // A 0.5.0 preview stored it in the settings: dropped on load (the host owns it now).
    const state = emptyLocal();
    saveLocal({ ...state, settings: { ...state.settings, browser: { kind: 'custom', path: '/bin/sh', name: 'sh' } } as typeof state.settings }, fake);
    const loaded = loadLocal(fake);
    expect('browser' in loaded.settings).toBe(false);
    expect(JSON.stringify(loaded)).not.toContain('/bin/sh');
  });

  it('the tasks page of a server', () => {
    expect(tasksPage('https://b.example/')).toBe('https://b.example/dashboard/tasks');
  });
});

describe('opening links', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1, taskUrls: { 'T-101': `${BEACON}/dashboard/tasks/T-101` } });
  });

  it('with Brave as the system default, "System default" calls the OS opener with no browser override', async () => {
    const ui = await signedIn();
    // The host's own default handler (Brave here) is what the OS opener uses; the app passes no browser of its own.
    ui.hooks.browsers = [
      { id: 'win:brave', name: 'Brave' },
      { id: 'win:google chrome', name: 'Google Chrome' },
    ];
    onHttpsBeacon(ui);
    ui.click('#open-my-time');
    await tick();
    expect(ui.hooks.opened).toEqual([`${BEACON}/dashboard/tasks/time`]);
    expect(ui.hooks.openedWith).toEqual([{ kind: 'system' }]);
    expect(JSON.stringify(ui.hooks.openedWith)).not.toContain('chrome');
    ui.app.destroy();
  });

  it('every link uses the chosen browser; a browser that is gone falls back to the default with a notice', async () => {
    const ui = await signedIn({ locale: 'es' });
    ui.hooks.browsers = [{ id: 'win:brave', name: 'Brave' }];
    ui.hooks.browserChoice = { kind: 'detected', id: 'win:brave', name: 'Brave' };
    await ui.app.loadBrowserChoice();
    onHttpsBeacon(ui);
    ui.click('#open-beacon');
    ui.app.openApps();
    await ui.app.trayAction('my-time');
    await tick();
    expect(ui.hooks.opened).toEqual([`${BEACON}/dashboard`, `${BEACON}/dashboard/tasks/time/apps`, `${BEACON}/dashboard/tasks/time`]);
    expect(ui.hooks.openedWith.every((choice) => choice.kind === 'detected' && choice.id === 'win:brave')).toBe(true);
    expect(ui.$('#notice')).toBeNull();
    ui.hooks.browsers = [];
    expect(await ui.app.openExternal(`${BEACON}/dashboard`, { kind: 'beacon', server: BEACON })).toBe(true);
    expect(ui.$('#notice').textContent).toBe('No se encontró Brave, así que el enlace se abrió en el navegador predeterminado del sistema.');
    // A custom browser that was removed.
    ui.hooks.browserChoice = { kind: 'custom', path: '/opt/gone/brave', name: 'brave' };
    await ui.app.loadBrowserChoice();
    ui.hooks.goneBrowsers = ['/opt/gone/brave'];
    await ui.app.openExternal(`${BEACON}/x`, { kind: 'beacon', server: BEACON });
    expect(ui.$('#notice').textContent).toContain('No se encontró brave');
    // Links that fail the rule are never opened.
    expect(await ui.app.openExternal('https://evil.example/', { kind: 'beacon', server: BEACON })).toBe(false);
    ui.app.destroy();
  });

  it('when no browser opens, the link is copied instead (without secrets)', async () => {
    const ui = await signedIn({ locale: 'es' });
    ui.hooks.openFails = true;
    expect(await ui.app.openExternal(`${BEACON}/dashboard?token=secret&tab=1`, { kind: 'beacon', server: BEACON })).toBe(false);
    expect(ui.hooks.copied).toEqual([`${BEACON}/dashboard?tab=1`]);
    expect(ui.$('#notice').textContent).toBe('No se pudo abrir el navegador — enlace copiado.');
    ui.hooks.copyFails = true;
    await ui.app.openExternal(`${BEACON}/dashboard`, { kind: 'beacon', server: BEACON });
    expect(ui.$('#notice').textContent).toBe('No se pudo abrir el navegador.');
    ui.app.destroy();
  });

  it('links the webview opens by itself (target=_blank, window.open) and plain anchors go through openExternal', async () => {
    const ui = await signedIn();
    onHttpsBeacon(ui);
    ui.hooks.openExternal(`${BEACON}/dashboard/tasks/T-9`);
    ui.hooks.openExternal('https://help.example/guide');
    ui.hooks.openExternal('http://insecure.example/');
    const anchor = document.createElement('a');
    anchor.href = 'https://help.example/anchor';
    anchor.target = '_blank';
    ui.root.append(anchor);
    anchor.click();
    const local = document.createElement('a');
    local.href = '#top';
    ui.root.append(local);
    local.click();
    await tick();
    expect(ui.hooks.opened).toEqual([`${BEACON}/dashboard/tasks/T-9`, 'https://help.example/guide', 'https://help.example/anchor']);
    ui.app.destroy();
  });

  it('the Store listing is a help link; without one the Apps page of Beacon', async () => {
    const ui = await signedIn({ channel: 'store', storeUrl: 'https://apps.microsoft.com/detail/9N' });
    ui.app.openStore();
    await tick();
    expect(ui.hooks.opened).toEqual(['https://apps.microsoft.com/detail/9N']);
    ui.app.destroy();
  });
});

describe('Copy link', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1, taskUrls: { 'T-101': `${BEACON}/dashboard/tasks/T-101` } });
  });

  it('a copy button next to My time and the running task link, and a context menu on every Beacon link', async () => {
    const ui = await signedIn({ locale: 'es' });
    onHttpsBeacon(ui);
    ui.click('#copy-my-time');
    await tick();
    expect(ui.hooks.copied).toEqual([`${BEACON}/dashboard/tasks/time`]);
    expect(ui.$('#notice').textContent).toBe('Enlace copiado.');
    expect(ui.$('#copy-my-time').getAttribute('aria-label')).toBe('Copiar el enlace a Mi tiempo');
    // The toast is announced (status region), never focused.
    expect(ui.$('#status').getAttribute('aria-live')).toBe('polite');
    expect(document.activeElement?.id).not.toBe('notice');

    await ui.app.start({ ...ui.app.tasks[0], url: `${BEACON}/dashboard/tasks/T-101` });
    onHttpsBeacon(ui);
    expect(ui.$('#timer-copy-link')).not.toBeNull();
    ui.click('#timer-copy-link');
    await tick();
    expect(ui.hooks.copied.at(-1)).toBe(`${BEACON}/dashboard/tasks/T-101`);

    // Right-click on a Beacon link: Open / Copy link, keyboard navigable, Escape closes.
    ui.$('#open-beacon').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 20 }));
    expect(ui.$('#link-menu').getAttribute('role')).toBe('menu');
    expect(document.activeElement?.id).toBe('link-menu-open');
    ui.$('#link-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.id).toBe('link-menu-copy');
    ui.$('#link-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement?.id).toBe('link-menu-open');
    ui.$('#link-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    ui.$('#link-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(ui.$('#link-menu')).toBeNull();
    ui.$('#open-beacon').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    ui.click('#link-menu-copy');
    await tick();
    expect(ui.hooks.copied.at(-1)).toBe(`${BEACON}/dashboard`);
    expect(ui.$('#link-menu')).toBeNull();
    ui.$('#open-beacon').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    ui.click('#link-menu-open');
    await tick();
    expect(ui.hooks.opened.at(-1)).toBe(`${BEACON}/dashboard`);
    // A click elsewhere closes it; links that fail the rule get no menu.
    ui.$('#open-beacon').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    ui.click('#search');
    expect(ui.$('#link-menu')).toBeNull();
    ui.app.openLinkMenu('https://evil.example/', { kind: 'beacon', server: BEACON }, 0, 0);
    expect(ui.$('#link-menu')).toBeNull();
    // Nothing is copied when the clipboard refuses.
    ui.hooks.copyFails = true;
    const before = ui.hooks.copied.length;
    await ui.app.copyLink(`${BEACON}/dashboard`);
    expect(ui.hooks.copied.length).toBe(before);
    ui.app.destroy();
  });

  it('the sign-in page has Open again and Copy link', async () => {
    await env.control('config', { deviceInterval: 1, verificationUri: `${env.url}/device` });
    const ui = mount({ locale: 'es' });
    await ui.app.init();
    const done = ui.app.connect(env.url);
    await tick();
    expect(ui.hooks.opened).toHaveLength(1);
    ui.click('#open-again');
    ui.click('#copy-device-link');
    await tick();
    expect(ui.hooks.opened).toHaveLength(2);
    expect(ui.hooks.copied[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/device/);
    expect(ui.hooks.copied[0]).not.toContain('code=');
    // 0.12.1: the same validated page as selectable text, the hint under Copy link, "Enlace copiado." in the status line.
    expect(ui.$('#device-url').textContent).toBe(ui.hooks.copied[0]);
    expect(ui.$('#device-browser-hint').textContent).toBe('Ábrelo en el navegador donde tienes la sesión de Beacon.');
    expect(ui.$('#copy-device-link').textContent).toContain('Copiar enlace');
    expect(ui.$('#status').getAttribute('aria-live')).toBe('polite');
    expect(ui.$('#status').textContent).toContain('Enlace copiado.');
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent ?? '' });
    await done;
    ui.app.destroy();
  });
});

describe('Settings → Open Beacon in', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('lists the system default, the detected browsers and Custom…, and stores the choice on this computer', async () => {
    const ui = await signedIn({ locale: 'es' });
    ui.hooks.browsers = [
      { id: 'win:brave', name: 'Brave' },
      { id: 'win:firefox.exe', name: 'Mozilla Firefox' },
    ];
    ui.app.show('settings');
    await tick();
    const select = ui.$<HTMLSelectElement>('#browser');
    expect(ui.$('label[for="browser"]').textContent).toBe('Abrir Beacon en');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Navegador predeterminado del sistema', 'Brave', 'Mozilla Firefox', 'Personalizado…']);
    expect(select.value).toBe('system');
    select.value = 'detected:win:brave';
    select.dispatchEvent(new Event('change'));
    await tick();
    // Kept by the host, not in the window's storage.
    expect(ui.hooks.browserChoice).toEqual({ kind: 'detected', id: 'win:brave', name: 'Brave' });
    expect(localStorage.getItem('time-track-desktop')).not.toContain('win:brave');
    expect(ui.$<HTMLSelectElement>('#browser').value).toBe('detected:win:brave');

    // Custom…: cancelled keeps the choice; refused says why; picked shows the path.
    await ui.app.chooseBrowser('custom');
    expect(ui.app.browserChoice).toEqual({ kind: 'detected', id: 'win:brave', name: 'Brave' });
    ui.hooks.pickError = 'not an exe';
    await ui.app.chooseBrowser('custom');
    expect(ui.$('#browser-message').textContent).toContain('.exe en Windows');
    ui.hooks.pickError = null;
    ui.hooks.pickResult = { kind: 'custom', path: 'C:\\Tools\\Brave\\brave.exe', name: 'brave' };
    await ui.app.chooseBrowser('custom');
    expect(ui.$('#browser-message')).toBeNull();
    expect(ui.$<HTMLSelectElement>('#browser').value).toBe('custom-current');
    expect(ui.$('#browser-path').textContent).toBe('C:\\Tools\\Brave\\brave.exe');
    await ui.app.chooseBrowser('custom-current');
    await ui.app.chooseBrowser('detected:unknown');
    expect(ui.app.browserChoice.kind).toBe('custom');
    expect(ui.hooks.browserChoice.kind).toBe('custom');
    await ui.app.chooseBrowser('system');
    expect(ui.app.browserChoice).toEqual(SYSTEM_BROWSER);
    expect(ui.hooks.browserChoice).toEqual(SYSTEM_BROWSER);
    ui.app.destroy();
  });

  it('opening a link sends only the URL; the host answers with the browser it keeps (GC-L1)', async () => {
    const ui = await signedIn();
    const calls: unknown[][] = [];
    const open = ui.platform.openExternal.bind(ui.platform);
    ui.platform.openExternal = (...args: Parameters<typeof open>) => {
      calls.push(args);
      return open(...args);
    };
    ui.hooks.browserChoice = { kind: 'custom', path: '/opt/b/brave', name: 'brave' };
    await ui.app.loadBrowserChoice();
    onHttpsBeacon(ui);
    expect(await ui.app.openExternal(`${BEACON}/dashboard`, { kind: 'beacon', server: BEACON })).toBe(true);
    expect(calls).toEqual([[`${BEACON}/dashboard`]]);
    // A detected browser that is gone is refused by the host and the setting shows what the host still has.
    ui.hooks.browsers = [];
    await ui.app.chooseBrowser('detected:win:gone');
    expect(ui.app.browserChoice).toEqual({ kind: 'custom', path: '/opt/b/brave', name: 'brave' });
    // Listed in Settings a moment ago, uninstalled since: the host refuses it.
    ui.app.browsers = [{ id: 'win:gone', name: 'Gone' }];
    await ui.app.chooseBrowser('detected:win:gone');
    expect(ui.app.browserChoice).toEqual({ kind: 'custom', path: '/opt/b/brave', name: 'brave' });
    // A host that cannot say is the system default.
    ui.platform.getBrowser = async () => {
      throw new Error('no');
    };
    await ui.app.loadBrowserChoice();
    expect(ui.app.browserChoice).toEqual(SYSTEM_BROWSER);
    // "Clear local data" resets the host's choice too.
    ui.hooks.browserChoice = { kind: 'detected', id: 'win:brave', name: 'Brave' };
    await ui.app.clearLocalData();
    expect(ui.hooks.browserChoice).toEqual(SYSTEM_BROWSER);
    ui.platform.setBrowser = async () => {
      throw new Error('no');
    };
    ui.app.browserChoice = { kind: 'detected', id: 'win:brave', name: 'Brave' };
    await ui.app.clearLocalData();
    expect(ui.app.browserChoice).toEqual(SYSTEM_BROWSER);
    ui.app.destroy();
  });

  it('a chosen browser that is no longer installed is marked, with a small notice', async () => {
    const ui = await signedIn();
    ui.hooks.browserChoice = { kind: 'detected', id: 'desktop:brave-browser.desktop', name: 'Brave' };
    await ui.app.loadBrowserChoice();
    ui.hooks.browsers = [{ id: 'desktop:firefox.desktop', name: 'Firefox' }];
    ui.app.show('settings');
    // Before the list arrives the stored name is shown as is.
    expect(ui.$<HTMLSelectElement>('#browser').selectedOptions[0].textContent).toBe('Brave');
    await tick();
    expect(ui.$<HTMLSelectElement>('#browser').selectedOptions[0].textContent).toBe('Brave (not found)');
    expect(ui.$('#browser-missing').textContent).toBe('Brave is no longer installed here: links open in the system default browser.');
    ui.app.destroy();
  });

  it('a host that cannot list browsers still offers the default and Custom…', async () => {
    const ui = await signedIn();
    ui.platform.listBrowsers = async () => {
      throw new Error('no');
    };
    await ui.app.loadBrowsers();
    expect(ui.app.browsers).toEqual([]);
    ui.app.destroy();
  });
});

describe('empty states', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('every locale has a line, an action and alt text for each state; poses fall back until their art exists', () => {
    for (const locale of MESSAGE_LOCALES) {
      expect(PIN_HINT[locale]).not.toBe('');
      for (const state of EMPTY_STATES) {
        const text = EMPTY_TEXTS[locale][state];
        expect(text.line.length, `${locale}.${state}`).toBeLessThan(110);
        expect(text.action).not.toBe('');
        expect(text.alt).not.toBe('');
      }
    }
    expect(EMPTY_TEXTS.es.pinned.action).toBe('Fija una tarea');
    expect(EMPTY_TEXTS.es.recent.action).toBe('Inicia un temporizador');
    expect(EMPTY_TEXTS.es.tasks.action).toBe('Abrir las tareas en Beacon');
    // The owner's art (thumbtack, stopwatch, clipboard), with a dark-theme variant with a light outer stroke.
    expect(poseFile(EMPTY_POSES.pinned)).toBe('pose-empty-pinned');
    expect(poseFile(EMPTY_POSES.recent)).toBe('pose-empty-recent');
    expect(poseFile(EMPTY_POSES.tasks)).toBe('pose-empty-tasks');
    const pair = emptyArt(EMPTY_POSES.recent, 'alt', 'empty-art');
    const [light, dark] = [...pair.querySelectorAll('img')];
    expect(light.getAttribute('srcset')).toBe('mascot/pose-empty-recent.webp 1x, mascot/pose-empty-recent@2x.webp 2x');
    expect(dark.getAttribute('srcset')).toBe('mascot/pose-empty-recent-dark.webp 1x, mascot/pose-empty-recent-dark@2x.webp 2x');
    expect(light.getAttribute('alt')).toBe('alt');
    expect(light.getAttribute('aria-hidden')).toBeNull();
    // Without their own art: the fallback poses, the same picture in both themes.
    const none = new Set<string>();
    expect(poseFile(EMPTY_POSES.pinned, none)).toBe('pose-peek-3');
    expect(poseFile(EMPTY_POSES.recent, none)).toBe('pose-focus');
    expect(poseFile(EMPTY_POSES.tasks, none)).toBe('pose-teamwork');
    const fallback = emptyArt(EMPTY_POSES.tasks, '', 'empty-art', none);
    expect([...fallback.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['mascot/pose-teamwork.webp', 'mascot/pose-teamwork.webp']);
    expect(quickEmptyState(2, false)).toBeNull();
    expect(quickEmptyState(0, true)).toBe('pinned');
    expect(quickEmptyState(0, false)).toBe('recent');
  });

  it('the three states share one slot and run their action', async () => {
    const ui = await signedIn({ locale: 'es' });
    onHttpsBeacon(ui);
    ui.app.entries = [];
    ui.app.state.pinned = [];
    ui.app.state.lastTask = null;
    ui.app.render();
    expect(ui.$('#quick-empty').getAttribute('data-empty')).toBe('recent');
    expect(ui.$('#quick-empty img.theme-light').getAttribute('alt')).toBe('El robot con un cronómetro en la mano');
    ui.click('#quick-empty-action');
    expect(document.activeElement?.id).toBe('search');

    ui.app.state.lastTask = { id: 'T-101', title: 'Old' };
    ui.app.render();
    expect(ui.$('#quick-empty').getAttribute('data-empty')).toBe('pinned');
    ui.click('#quick-empty-action');
    expect(ui.$('#notice').textContent).toBe(PIN_HINT.es);
    expect(ui.$('#list-section').classList.contains('pin-hint')).toBe(true);
    expect(document.activeElement?.classList.contains('pin')).toBe(true);

    ui.app.tasks = [];
    ui.app.render();
    expect(ui.$('#quick-empty')).toBeNull();
    expect(ui.$('#tasks-empty').getAttribute('data-empty')).toBe('tasks');
    ui.click('#tasks-empty-action');
    await tick();
    expect(ui.hooks.opened).toEqual([`${BEACON}/dashboard/tasks`]);
    // The friendly-message language decides (the Beacon user's when known).
    ui.app.me = { ...ui.app.me!, locale: 'de' } as typeof ui.app.me;
    ui.app.render();
    expect(ui.$('#tasks-empty').textContent).toContain('Aufgaben in Beacon öffnen');
    ui.app.destroy();
  });
});
