// The session token stays in Rust (src-tauri/src/secret.rs): the Tauri bridge (src/platform-tauri.ts) never asks for
// it, never sends it and only ever holds SESSION_HANDLE. `invoke` is mocked with a fake Rust side that follows the
// same rules as net.rs / secret.rs, backed by the mock server.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeTrackApi } from '../../src/api/client';
import { runDeviceFlow } from '../../src/lib/deviceFlow';
import { type NativeRequest, type NativeResponse, SESSION_HANDLE } from '../../src/lib/nativeFetch';
import { nodeFetch, startMock } from './helpers';

const calls: { command: string; args: unknown }[] = [];
let rust: (command: string, args: Record<string, unknown>) => Promise<unknown> = async () => undefined;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    return rust(command, args);
  },
}));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.5.1' }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({}),
  availableMonitors: async () => [],
  currentMonitor: async () => null,
  PhysicalPosition: class {},
  PhysicalSize: class {},
}));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: async () => false, requestPermission: async () => 'denied', sendNotification: () => undefined }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: async () => undefined }));

const { tauriPlatform } = await import('../../src/platform-tauri');

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** The Rust side of net.rs / secret.rs over the mock server: keychain in `keychain.token`. */
function fakeRust(keychain: { token: string | null }) {
  return async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (command) {
      case 'secret_status':
        return keychain.token !== null;
      case 'secret_delete':
        keychain.token = null;
        return undefined;
      case 'beacon_bind':
        return undefined;
      case 'beacon_fetch': {
        const request = args.request as NativeRequest;
        const headers: Record<string, string> = Object.fromEntries(request.headers.filter(([name]) => name.toLowerCase() !== 'authorization'));
        if (request.auth) {
          if (keychain.token === null) return { status: 401, statusText: 'Unauthorized', headers: [], body: b64(new TextEncoder().encode('{"error":"invalid_token"}')) };
          headers.Authorization = `Bearer ${keychain.token}`;
        }
        const response = await nodeFetch(request.url, { method: request.method, headers, body: request.body ?? undefined });
        let text = await response.text();
        if (request.method === 'POST' && /\/api\/time-track\/(login|device\/token)$/.test(new URL(request.url).pathname) && response.ok) {
          const json = JSON.parse(text) as { token?: string };
          if (typeof json.token === 'string' && json.token !== '') {
            keychain.token = json.token;
            json.token = SESSION_HANDLE;
          }
          text = JSON.stringify(json);
        }
        return { status: response.status, statusText: response.statusText, headers: [['content-type', 'application/json']], body: b64(new TextEncoder().encode(text)) } satisfies NativeResponse;
      }
      default:
        return undefined;
    }
  };
}

describe('Tauri bridge: the session token never reaches the webview', () => {
  beforeEach(() => {
    calls.length = 0;
    rust = async () => undefined;
  });

  it('asks only whether a token is stored and holds the handle in its place', async () => {
    const platform = tauriPlatform();
    rust = async (command) => command === 'secret_status';
    expect(await platform.secretGet()).toBe(SESSION_HANDLE);
    rust = async () => false;
    expect(await platform.secretGet()).toBeNull();
    expect(calls.map((call) => call.command)).toEqual(['secret_status', 'secret_status']);
  });

  it('never sends a token to Rust: secretSet takes the handle only, and calls nothing', async () => {
    const platform = tauriPlatform();
    await platform.secretSet(SESSION_HANDLE);
    await expect(platform.secretSet('a-real-token')).rejects.toThrow('sign-in answer only');
    expect(calls).toEqual([]);
    await platform.secretDelete();
    expect(calls).toEqual([{ command: 'secret_delete', args: {} }]);
  });

  it('the updater commands get the server only', async () => {
    const platform = tauriPlatform();
    rust = async (command) => (command === 'check_update' ? { status: 'up_to_date', min_supported_version: null } : undefined);
    await platform.checkUpdate('https://beacon.nowo.tech', SESSION_HANDLE);
    await platform.installUpdate('https://beacon.nowo.tech', SESSION_HANDLE);
    expect(calls).toEqual([
      { command: 'check_update', args: { server: 'https://beacon.nowo.tech' } },
      { command: 'install_update', args: { server: 'https://beacon.nowo.tech' } },
    ]);
  });

  it('an authenticated API call crosses as `auth: true` without any Authorization header', async () => {
    const platform = tauriPlatform();
    rust = async () => ({ status: 200, statusText: 'OK', headers: [], body: btoa('{"identifier":"ana"}') });
    const api = new TimeTrackApi({ baseUrl: 'https://beacon.nowo.tech', source: 'desktop', token: SESSION_HANDLE, fetchImpl: platform.fetch });
    await api.me();
    await api.deviceCode('TimeTrack desktop').catch(() => undefined);
    const [me, code] = calls.map((call) => (call.args as { request: NativeRequest }).request);
    expect(me).toMatchObject({ url: 'https://beacon.nowo.tech/api/time-track/me', method: 'GET', auth: true });
    expect(code).toMatchObject({ method: 'POST', auth: false });
    for (const request of [me, code]) expect(request.headers.some(([name]) => name.toLowerCase() === 'authorization')).toBe(false);
    expect(JSON.stringify(calls)).not.toContain(SESSION_HANDLE);
  });

  describe('sign-in, calls and sign-out against the mock server', () => {
    let env: Awaited<ReturnType<typeof startMock>>;

    beforeAll(async () => {
      env = await startMock();
    });
    afterAll(() => env.mock.close());

    it('the token from device/token stays in the fake keychain; the webview never sees it', async () => {
      await env.control('reset', {});
      await env.control('config', { deviceInterval: 1 });
      const keychain: { token: string | null } = { token: null };
      rust = fakeRust(keychain);
      const platform = tauriPlatform();
      const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', fetchImpl: platform.fetch });
      const login = await runDeviceFlow(api, {
        clientName: 'TimeTrack desktop (test)',
        sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
        onCode: async (code) => void (await env.control('device/approve', { userCode: code.userCode })),
      });
      expect(login.token).toBe(SESSION_HANDLE);
      expect(keychain.token).toMatch(/^.{20,}$/);
      // The app's sign-in sequence (ui/app.ts): store, then authenticated calls with the handle.
      await platform.secretSet(login.token);
      api.setToken(await platform.secretGet());
      expect((await api.me()).identifier).toBeTruthy();
      // Nothing that crossed the bridge, either way, carried the real token.
      const real = keychain.token as string;
      expect(JSON.stringify(calls)).not.toContain(real);
      // Sign-out: revoked with the token Rust adds, then deleted; further calls are 401 without a request.
      await api.logout();
      await platform.secretDelete();
      expect(keychain.token).toBeNull();
      expect(await platform.secretGet()).toBeNull();
    });
  });
});
