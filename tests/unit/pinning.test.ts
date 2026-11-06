// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, TimeTrackApi } from '../../src/api/client';
import { describeError, isUntrustedCertificate, UNTRUSTED_CERTIFICATE } from '../../src/lib/errors';
import { type NativeRequest, type NativeResponse, nativeFetch, SIGN_IN_WAIT } from '../../src/lib/nativeFetch';
import { browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import en from '../../src/i18n/en.json';
import es from '../../src/i18n/es.json';
import { nodeFetch, startMock } from './helpers';

/** What the Rust command rejects with on a pin mismatch (src-tauri/src/pinning.rs, PinMismatch). */
const MISMATCH = `${UNTRUSTED_CERTIFICATE}: unexpected certificate for beacon.nowo.tech (pin set v1)`;

const b64 = (text: string) => btoa(text);

describe('nativeFetch (beacon_fetch bridge)', () => {
  it('sends method, headers and body, and builds the Response from the base64 body', async () => {
    const sent: NativeRequest[] = [];
    const fetchImpl = nativeFetch(async (request) => {
      sent.push(request);
      return { status: 200, statusText: 'OK', headers: [['content-type', 'application/json'], ['x-min-supported-version', '0.3.0']], body: b64('{"ok":true}') };
    });
    const response = await fetchImpl('https://beacon.nowo.tech/api/time-track/me', {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer t' },
      body: '{"a":1}',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://beacon.nowo.tech/api/time-track/me', method: 'POST', body: '{"a":1}', auth: true });
    // The token never crosses the bridge: `Authorization` only marks the request, Rust sets the header.
    expect(Object.fromEntries(sent[0].headers.map(([name, value]) => [name.toLowerCase(), value]))).toEqual({ accept: 'application/json' });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.headers.get('X-Min-Supported-Version')).toBe('0.3.0');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('defaults to GET without body, accepts URL objects and keeps binary bodies', async () => {
    const sent: NativeRequest[] = [];
    const fetchImpl = nativeFetch(async (request) => {
      sent.push(request);
      return { status: 200, statusText: 'OK', headers: [], body: btoa(String.fromCharCode(0, 255, 7)) };
    });
    const response = await fetchImpl(new URL('https://beacon.nowo.tech/x'));
    expect(sent[0]).toEqual({ url: 'https://beacon.nowo.tech/x', method: 'GET', headers: [], body: null, auth: false });
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 7]);
  });

  it('gives null-body statuses no body and keeps error statuses', async () => {
    const answers: NativeResponse[] = [
      { status: 204, statusText: 'No Content', headers: [], body: '' },
      { status: 401, statusText: 'Unauthorized', headers: [], body: b64('{"error":"invalid_token"}') },
    ];
    const fetchImpl = nativeFetch(async () => answers.shift() as NativeResponse);
    const empty = await fetchImpl('https://beacon.nowo.tech/a');
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
    const unauthorized = await fetchImpl('https://beacon.nowo.tech/b');
    expect(unauthorized.ok).toBe(false);
    expect(await unauthorized.json()).toEqual({ error: 'invalid_token' });
  });

  it('turns the command rejection (a string) into an Error, and keeps Errors as they are', async () => {
    await expect(nativeFetch(() => Promise.reject(MISMATCH))('https://beacon.nowo.tech/a')).rejects.toThrow(MISMATCH);
    const original = new Error('boom');
    await expect(nativeFetch(() => Promise.reject(original))('https://beacon.nowo.tech/a')).rejects.toBe(original);
  });

  it('refuses inputs the bridge cannot carry', async () => {
    const fetchImpl = nativeFetch(async () => ({ status: 200, statusText: 'OK', headers: [], body: '' }));
    await expect(fetchImpl({ url: 'https://x' } as unknown as Request)).rejects.toThrow('Only URL inputs');
    await expect(fetchImpl('https://x', { method: 'POST', body: new Blob(['x']) })).rejects.toThrow('Only string bodies');
  });

  it('a pin mismatch reaches the API client as a network ApiError carrying the marker', async () => {
    const api = new TimeTrackApi({ baseUrl: 'https://beacon.nowo.tech', source: 'desktop', token: 't', fetchImpl: nativeFetch(() => Promise.reject(MISMATCH)) });
    const error = await api.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetwork).toBe(true);
    expect(isUntrustedCertificate(error)).toBe(true);
  });
});

describe('error mapping of a pin mismatch', () => {
  const ctx = { stage: 'action' as const, server: 'https://beacon.nowo.tech', version: '0.5.0', now: new Date('2026-11-05T10:00:00Z') };

  it('is its own error, fail closed: retry and copy, no "continue anyway"', () => {
    const view = describeError(new ApiError(0, 'network_error', MISMATCH), ctx);
    expect(view).toMatchObject({ id: 'untrusted_certificate', title: 'errUntrustedTitle', text: 'errUntrustedText', actions: ['retry', 'copy'], params: { host: 'beacon.nowo.tech' } });
    expect(view.details).toContain('code: network_error');
    expect(view.details).toContain(MISMATCH);
    // The connect flow gets the same message.
    expect(describeError(new ApiError(0, 'network_error', MISMATCH), { ...ctx, stage: 'preflight' }).id).toBe('untrusted_certificate');
  });

  it('other network errors stay "unreachable"; non-network errors never match', () => {
    expect(describeError(new ApiError(0, 'network_error', 'connection refused'), ctx).id).toBe('unreachable');
    expect(isUntrustedCertificate(new ApiError(500, 'server_error', MISMATCH))).toBe(false);
    expect(isUntrustedCertificate(new Error(MISMATCH))).toBe(false);
    expect(isUntrustedCertificate(null)).toBe(false);
  });

  it('has the exact Spanish wording and an English one', () => {
    expect(es.errUntrustedTitle).toBe('La conexión con Beacon no es de confianza (certificado inesperado)');
    expect(en.errUntrustedTitle).toBe('The connection to Beacon is not trusted (unexpected certificate)');
    for (const key of ['errUntrustedText', 'connPinned', 'connNotPinned', 'connPinExpired'] as const) {
      expect(en[key]).toContain('{host}');
      expect(es[key]).toContain('{host}');
    }
  });
});

describe('app: pin mismatch and the Settings line', () => {
  let env: Awaited<ReturnType<typeof startMock>>;
  const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    env = await startMock();
  });
  afterAll(() => env.mock.close());
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  async function signedIn(platform = browserPlatform('0.5.0', nodeFetch)) {
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const app = new DesktopApp(root, platform, { storage: localStorage, locale: 'es', sleep: () => new Promise((resolve) => setTimeout(resolve, 5)), searchDelayMs: 5 });
    const $ = (selector: string) => root.querySelector(selector) as HTMLElement | null;
    await app.init();
    const done = app.connect(env.url);
    await tick();
    await env.control('device/approve', { userCode: $('#user-code')?.textContent });
    await done;
    expect(app.view).toBe('main');
    return { app, platform, $ };
  }

  it('a pin mismatch while signed in is an error, never offline mode, and nothing is queued', async () => {
    const ui = await signedIn();
    (ui.platform as { fetch: typeof fetch }).fetch = nativeFetch(() => Promise.reject(MISMATCH));
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    expect(ui.app.offline).toBe(false);
    expect(ui.app.queue.size).toBe(0);
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.$('#error-title')?.textContent).toBe('La conexión con Beacon no es de confianza (certificado inesperado)');
    ui.app.destroy();
  });

  it('shows how the connection is protected in Settings', async () => {
    const ui = await signedIn();
    const host = new URL(env.url).host;
    // Unknown (plain browser): nothing.
    ui.app.show('settings');
    await tick();
    expect(ui.$('#connection-security')).toBeNull();
    const cases = [
      { status: 'pinned', text: `Conexión segura: ${host} se verifica con las claves de certificado incluidas en la app (conjunto 3).` },
      { status: 'unpinned', text: `Conexión no fijada: ${host} se comprueba solo con la validación TLS estándar.` },
      { status: 'expired', text: 'La fijación de certificados de esta versión ha caducado' },
    ] as const;
    for (const { status, text } of cases) {
      ui.platform.hooks.connectionSecurity = { status, pinSetVersion: 3 };
      ui.app.show('main');
      ui.app.show('settings');
      await tick();
      expect(ui.$('#connection-security')?.dataset.status).toBe(status);
      expect(ui.$('#connection-security')?.textContent).toContain(text);
    }
    // Loopback development server: nothing.
    ui.platform.hooks.connectionSecurity = { status: 'local', pinSetVersion: 3 };
    ui.app.show('main');
    ui.app.show('settings');
    await tick();
    expect(ui.$('#connection-security')).toBeNull();
    // The host cannot tell: nothing.
    ui.platform.connectionSecurity = () => Promise.reject(new Error('no'));
    ui.app.show('main');
    ui.app.show('settings');
    await tick();
    expect(ui.$('#connection-security')).toBeNull();
    ui.app.destroy();
  });

  it('binds the server before signing in and again at start-up; signing out unbinds it (FY-L1)', async () => {
    const platform = browserPlatform('0.5.0', nodeFetch);
    const ui = await signedIn(platform);
    expect(platform.hooks.boundServer).toBe(env.url);
    // Signed in: another server cannot be bound until sign-out.
    await expect(platform.bindServer('https://other.example')).rejects.toThrow('sign out first');
    await expect(platform.beginSignIn(env.url)).rejects.toThrow('sign out first');
    ui.app.destroy();
    // Restart: unbound in Rust until the UI binds the saved server.
    platform.hooks.boundServer = null;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const again = new DesktopApp(root, platform, { storage: localStorage, locale: 'es', sleep: () => Promise.resolve(), searchDelayMs: 5 });
    await again.init();
    expect(again.view).toBe('main');
    expect(platform.hooks.boundServer).toBe(env.url);
    await again.logout();
    expect(platform.hooks.boundServer).toBeNull();
    again.destroy();
  });

  it('a saved server changed to another origin is refused and the token is dropped, never sent there (GM-M1)', async () => {
    const platform = browserPlatform('0.5.0', nodeFetch);
    const ui = await signedIn(platform);
    ui.app.destroy();
    const saved = JSON.parse(localStorage.getItem('time-track-desktop') ?? '{}') as { session: { server: string } };
    saved.session.server = 'https://attacker.example';
    localStorage.setItem('time-track-desktop', JSON.stringify(saved));
    platform.hooks.boundServer = null;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const again = new DesktopApp(root, platform, { storage: localStorage, locale: 'es', sleep: () => Promise.resolve(), searchDelayMs: 5 });
    await again.init();
    expect(again.view).toBe('login');
    expect(platform.hooks.boundServer).toBeNull();
    expect(await platform.secretGet()).toBeNull();
    // The notice points to Beacon to revoke the old device (GM-D-2).
    expect(root.querySelector('#notice')?.textContent).toContain('puedes revocarlo allí');
    // A new sign-in is possible again.
    await platform.beginSignIn(env.url);
    again.destroy();
  });

  it('declining the native "Sign in to …?" confirmation goes back to the sign-in view without an error (GM-D-1)', async () => {
    const platform = browserPlatform('0.5.0', nodeFetch);
    platform.hooks.declineSignIn = true;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const app = new DesktopApp(root, platform, { storage: localStorage, locale: 'es', sleep: () => Promise.resolve(), searchDelayMs: 5 });
    await app.init();
    await app.connect(env.url);
    expect(platform.hooks.signInConfirmations).toEqual([env.url]);
    expect(app.view).toBe('login');
    expect(root.querySelector('#error-title')).toBeNull();
    expect(platform.hooks.boundServer).toBeNull();
    expect(await platform.secretGet()).toBeNull();
    app.destroy();
  });

  it('right after a decline the host shows no dialog: the app says to wait (GM-D2-1)', async () => {
    const platform = browserPlatform('0.5.0', nodeFetch);
    platform.beginSignIn = () => Promise.reject(SIGN_IN_WAIT);
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const app = new DesktopApp(root, platform, { storage: localStorage, locale: 'es', sleep: () => Promise.resolve(), searchDelayMs: 5 });
    await app.init();
    await app.connect(env.url);
    expect(app.view).toBe('login');
    expect(root.querySelector('#error-title')).toBeNull();
    expect(root.querySelector('#notice')?.textContent).toContain('Espera un poco');
    app.destroy();
  });

  it('a token without a saved session is dropped so that signing in works', async () => {
    const platform = browserPlatform('0.5.0', nodeFetch);
    const ui = await signedIn(platform);
    ui.app.destroy();
    localStorage.clear();
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const again = new DesktopApp(root, platform, { storage: localStorage, locale: 'es', sleep: () => Promise.resolve(), searchDelayMs: 5 });
    await again.init();
    expect(again.view).toBe('login');
    expect(await platform.secretGet()).toBeNull();
    again.destroy();
  });

  it('a saved server this build refuses to bind sends the user to sign in', async () => {
    const platform = browserPlatform('0.5.0', nodeFetch);
    const ui = await signedIn(platform);
    ui.app.destroy();
    platform.bindServer = () => Promise.reject(new Error('invalid URL'));
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const again = new DesktopApp(root, platform, { storage: localStorage, locale: 'es', sleep: () => Promise.resolve(), searchDelayMs: 5 });
    await again.init();
    expect(again.view).toBe('login');
    again.destroy();
  });

  it('an expired pin set shows a card in the main view and one desktop notification per pin set (FY-I1)', async () => {
    const platform = browserPlatform('0.5.0', nodeFetch);
    platform.hooks.connectionSecurity = { status: 'expired', pinSetVersion: 1 };
    const ui = await signedIn(platform);
    await tick();
    expect(ui.$('#pin-expired-title')?.textContent).toBe('Actualiza TimeTrack: la fijación de certificados ha caducado');
    expect(ui.$('#pin-expired-text')?.textContent).toContain('actualiza la app');
    expect(platform.hooks.notifications).toHaveLength(1);
    expect(platform.hooks.notifications[0]).toContain('la fijación de certificados ha caducado');
    expect(ui.app.state.settings.pinExpiryNotified).toBe(1);
    ui.$('#pin-expired-ok')?.click();
    expect(ui.$('#pin-expired')).toBeNull();
    // Again (a restart): the card comes back, the notification does not.
    await ui.app.checkPinExpiry();
    expect(ui.$('#pin-expired')).not.toBeNull();
    expect(platform.hooks.notifications).toHaveLength(1);
    // A failing notification never breaks the check.
    platform.hooks.connectionSecurity = { status: 'expired', pinSetVersion: 2 };
    platform.notify = () => Promise.reject(new Error('no notifications'));
    await ui.app.checkPinExpiry();
    expect(ui.app.state.settings.pinExpiryNotified).toBe(2);
    ui.app.destroy();
  });

  it('a pinned or unpinned server shows no expiry card', async () => {
    const platform = browserPlatform('0.5.0', nodeFetch);
    platform.hooks.connectionSecurity = { status: 'pinned', pinSetVersion: 1 };
    const ui = await signedIn(platform);
    await tick();
    expect(ui.$('#pin-expired')).toBeNull();
    expect(platform.hooks.notifications).toHaveLength(0);
    ui.app.destroy();
  });
});
