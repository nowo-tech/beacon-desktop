import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, TimeTrackApi, normalizeServerUrl, originPattern } from '../../src/api/client';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const api = () => new TimeTrackApi({ baseUrl: env.url, source: 'extension', fetchImpl: nodeFetch });

async function signedIn() {
  const client = api();
  const login = await client.login('ada@example.com', 'app-password-123');
  client.setToken(login.token);
  return client;
}

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());
beforeEach(() => env.control('reset', {}));

describe('normalizeServerUrl', () => {
  it('keeps the origin and path without trailing slash', () => {
    expect(normalizeServerUrl(' https://beacon.example.com/app/ ')).toBe('https://beacon.example.com/app');
    expect(normalizeServerUrl('http://localhost:8000')).toBe('http://localhost:8000');
    expect(originPattern('https://beacon.example.com/app')).toBe('https://beacon.example.com/*');
  });
  it('rejects invalid, insecure and credentialed URLs', () => {
    expect(() => normalizeServerUrl('nope')).toThrow(ApiError);
    expect(() => normalizeServerUrl('http://beacon.example.com')).toThrow(/HTTPS/);
    expect(() => normalizeServerUrl('https://u:p@beacon.example.com')).toThrow(/credentials/);
  });
});

describe('TimeTrackApi against the 1.9.0 mock', () => {
  it('logs in and reads me', async () => {
    const client = api();
    const login = await client.login('ada@example.com', 'app-password-123');
    expect(login.token).toHaveLength(43);
    expect(login.scopes).toEqual(['timer:read', 'timer:write', 'tasks:read', 'entries:read']);
    client.setToken(login.token);
    expect(client.server).toBe(env.url);
    const me = await client.me();
    expect(me).toMatchObject({ identifier: 'ada@example.com', workingHours: null });
  });

  it('maps wrong credentials to invalid_credentials (not a sign-in-again 401)', async () => {
    const error = await api().login('ada@example.com', 'wrong').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_credentials', isUnauthorized: false });
  });

  it('refuses calls without a token and flags 401 as unauthorized', async () => {
    await expect(api().me()).rejects.toMatchObject({ code: 'invalid_token', isUnauthorized: true });
    const client = await signedIn();
    await env.control('token/revoke', {});
    await expect(client.timer()).rejects.toMatchObject({ status: 401, isUnauthorized: true, isNetwork: false });
  });

  it('runs the timer lifecycle: start, switch, stop', async () => {
    const client = await signedIn();
    expect(await client.timer()).toBeNull();
    expect(await client.tasks({ search: ' ' })).toHaveLength(8);
    expect(await client.tasks({ search: 'invoice', limit: 500 })).toEqual([expect.objectContaining({ id: 'T-104' })]);
    const timer = await client.start('T-101', 'draft');
    expect(timer).toMatchObject({ taskId: 'T-101', clientType: 'extension', metadata: { note: 'draft' } });
    await expect(client.start('T-102')).rejects.toMatchObject({ status: 409, code: 'timer_running' });
    const change = await client.switchTask('T-102', 'done');
    expect(change.entry).toMatchObject({ taskId: 'T-101', metadata: { note: 'done' } });
    expect(change.timer).toMatchObject({ taskId: 'T-102' });
    expect((await client.timer())?.taskId).toBe('T-102');
    expect(await client.stop()).toMatchObject({ taskId: 'T-102', source: 'extension' });
    expect(await client.stop()).toBeNull();
    const page = await client.entries({ from: new Date(Date.now() - 3600_000), to: new Date(), limit: 1000, offset: 0 });
    expect(page.entries.map((e) => e.taskId)).toEqual(['T-102', 'T-101']);
    expect(page.limit).toBe(100);
  });

  it('answers 403 task_forbidden for foreign tasks, never sends metadata', async () => {
    const client = await signedIn();
    await expect(client.start('T-900')).rejects.toMatchObject({ status: 403, code: 'task_forbidden' });
    const { requests } = (await env.control('state')) as { requests: { body: string }[] };
    expect(requests.every((r) => !r.body.includes('metadata'))).toBe(true);
  });

  it('sends the idle decision only (keep / split / discard)', async () => {
    const client = await signedIn();
    await client.start('T-101');
    await env.control('timer/backdate', { seconds: 3600 });
    const from = new Date(Date.now() - 1800_000);
    const to = new Date(Date.now() - 600_000);
    expect(await client.discardIdle(from, to, 'keep')).toMatchObject({ entry: null, timer: { taskId: 'T-101' } });
    const split = await client.discardIdle(from, to, 'split');
    expect(split.entry?.endedAt).toBe(from.toISOString());
    expect(split.timer?.startedAt).toBe(to.toISOString());
    const discard = await client.discardIdle(new Date(Date.now() - 300_000), new Date(), 'discard');
    expect(discard).toMatchObject({ timer: null, entry: { taskId: 'T-101' } });
    await expect(client.discardIdle(from, to, 'keep')).rejects.toMatchObject({ status: 404, code: 'no_active_timer' });
  });

  it('exports own entries with the server file name', async () => {
    const client = await signedIn();
    const csv = await client.exportEntries(new Date('2026-11-01'), new Date('2026-11-02'), 'csv');
    expect(csv.filename).toBe('time-entries-2026-11-01-2026-11-02.csv');
    expect(await csv.blob.text()).toContain('id,taskId');
  });

  it('runs the device flow with every polling state', async () => {
    await env.control('config', { deviceInterval: 1 });
    const client = api();
    const code = await client.deviceCode('Work laptop', ['timer:read', 'timer:write']);
    expect(code.userCode).toMatch(/^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
    expect(code.verificationUriComplete).toContain(code.userCode);
    expect(code.interval).toBe(1);
    expect(await client.deviceToken(code.deviceCode)).toEqual({ status: 'pending' });
    expect(await client.deviceToken(code.deviceCode)).toEqual({ status: 'slow_down' });
    await env.control('device/approve', { userCode: code.userCode });
    const approved = await client.deviceToken(code.deviceCode);
    expect(approved).toMatchObject({ status: 'approved', scopes: ['timer:read', 'timer:write'] });
    expect(await client.deviceToken(code.deviceCode)).toEqual({ status: 'expired' });

    const denied = await client.deviceCode('Other');
    await env.control('device/approve', { userCode: denied.userCode, approve: false });
    expect(await client.deviceToken(denied.deviceCode)).toEqual({ status: 'denied' });
    await expect(client.deviceCode('Bad', ['entries:write' as never])).rejects.toMatchObject({ code: 'invalid_scope' });
  });

  it('maps simulated failures: rate limit with Retry-After, invalid_scope while polling, unknown codes', async () => {
    const client = await signedIn();
    await env.control('config', { failNext: { status: 429, error: 'rate_limited', retryAfter: 7 } });
    await expect(client.me()).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 7 });
    await env.control('config', { failNext: { status: 400, error: 'invalid_scope' } });
    expect(await client.deviceToken('x')).toEqual({ status: 'invalid_scope' });
    await env.control('config', { failNext: { status: 500, error: 'Bad Thing!' } });
    await expect(client.me()).rejects.toMatchObject({ status: 500, code: 'server_error', message: 'Simulated Bad Thing!.' });
  });

  it('reports network failures and invalid bodies', async () => {
    const offline = new TimeTrackApi({
      baseUrl: 'https://beacon.example.com',
      source: 'desktop',
      token: 't',
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    await expect(offline.timer()).rejects.toMatchObject({ status: 0, code: 'network_error', isNetwork: true });
    const reply = (status: number, body: string, headers: Record<string, string> = {}) =>
      new TimeTrackApi({
        baseUrl: 'https://beacon.example.com',
        source: 'desktop',
        token: 't',
        fetchImpl: async () => new Response(body === '' ? null : body, { status, statusText: 'X', headers }),
      });
    await expect(reply(200, '{nope').me()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await reply(200, '').timer()).toBeNull();
    await expect(reply(404, 'not json').me()).rejects.toMatchObject({ code: 'not_found', message: 'X' });
    await expect(reply(418, '{}', { 'Retry-After': 'soon' }).me()).rejects.toMatchObject({ code: 'server_error', retryAfter: null });
    await expect(reply(200, '{"token":""}').login('a', 'b')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(reply(200, '{}').deviceCode('x')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(reply(500, '{"error":"oops_x","message":""}').deviceToken('x')).rejects.toMatchObject({ code: 'oops_x', message: 'oops_x' });
    const login = await reply(200, '{"token":"abc"}').login('a', 'b');
    expect(login).toEqual({ token: 'abc', expiresAt: '', scopes: [] });
    const exported = await reply(200, 'a,b').exportEntries(new Date('2026-01-01'), new Date('2026-01-02'), 'json');
    expect(exported.filename).toBe('time-entries-2026-01-01-2026-01-02.json');
  });

  it('logs out (revokes) and forgets the token even when the server fails', async () => {
    const client = await signedIn();
    await client.logout();
    await expect(client.me()).rejects.toMatchObject({ message: 'Not connected.' });
    const failing = new TimeTrackApi({ baseUrl: env.url, source: 'extension', token: 'x', fetchImpl: () => Promise.reject(new Error('down')) });
    await expect(failing.logout()).rejects.toMatchObject({ code: 'network_error' });
  });

  it('reads the desktop updater route: 401 without token, 204 when current, 200 when newer', async () => {
    const client = await signedIn();
    const token = (await client.login('ada@example.com', 'app-password-123')).token;
    const get = (auth?: string) =>
      nodeFetch(`${env.url}/api/time-track/updates/desktop/linux/x86_64/0.1.0`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
    expect((await get()).status).toBe(401);
    expect((await get(token)).status).toBe(204);
    await env.control('config', { update: { version: '0.2.0', notes: '', pub_date: '', url: 'u', signature: 's' } });
    expect((await get(token)).status).toBe(200);
  });
});
