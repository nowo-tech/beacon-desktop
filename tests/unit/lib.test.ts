import { describe, expect, it } from 'vitest';
import en from '../../src/i18n/en.json';
import es from '../../src/i18n/es.json';
import { TimeTrackApi } from '../../src/api/client';
import { DeviceFlowError, runDeviceFlow } from '../../src/lib/deviceFlow';
import { IdleMonitor, clampPeriod } from '../../src/lib/idle';
import { createTranslator } from '../../src/lib/i18n';
import { OfflineQueue } from '../../src/lib/queue';
import { emptyState, hasConsent, loadLocal, recordConsent, saveLocal } from '../../src/lib/settings';
import { compareVersions, isVersion, updateRequired } from '../../src/lib/version';
import { appsPage, safeVerificationUri } from '../../src/lib/urls';
import { withinWorkingHours } from '../../src/lib/workingHours';
import { nodeFetch, startMock } from './helpers';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe('i18n', () => {
  it('has the same keys in en and es', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(createTranslator('es')('offline', { count: 2 })).toContain('2 acción(es)');
  });
});

describe('version', () => {
  it('compares versions and decides on "update required"', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('v0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1', '0.1.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc')).toBe(1);
    expect(compareVersions('1.0.0-a', '1.0.0-b')).toBe(-1);
    expect(compareVersions('1.0.0-b', '1.0.0-a')).toBe(1);
    expect(updateRequired('0.1.0', '0.2.0')).toBe(true);
    expect(updateRequired('0.2.0', '0.2.0')).toBe(false);
    expect(updateRequired('0.1.0', null)).toBe(false);
    expect(updateRequired('0.1.0', '')).toBe(false);
    expect([isVersion('1.2.3'), isVersion('1.2.3-rc.1'), isVersion('1.2'), isVersion(null), isVersion('9.9.9; rm')]).toEqual([true, true, false, false, false]);
  });
});

describe('verification URI (same host only)', () => {
  const server = 'https://beacon.example.com';
  it('accepts https on the server host', () => {
    expect(safeVerificationUri('https://beacon.example.com/account/time-apps/connect?code=BCDF-GHJK', server)).toBe(
      'https://beacon.example.com/account/time-apps/connect?code=BCDF-GHJK',
    );
    expect(safeVerificationUri('http://127.0.0.1:8787/device', 'http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/device');
  });
  it('rejects other hosts, http, credentials, other schemes and garbage', () => {
    for (const uri of [
      'https://beacon.example.com.evil.net/device',
      'https://evil.example.com/device',
      'http://beacon.example.com/device',
      'https://u:p@beacon.example.com/device',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://beacon.example.com:8443/device',
      'not a url',
      '',
      undefined,
    ]) {
      expect(safeVerificationUri(uri, server)).toBeNull();
    }
    expect(appsPage('https://beacon.example.com/')).toBe('https://beacon.example.com/dashboard/tasks/time/apps');
  });
});

describe('working hours (right to disconnect)', () => {
  const monday10 = new Date(2026, 10, 2, 10, 0);
  const hours = { slots: [{ day: 1, from: '09:00', to: '17:00' }] };
  it('allows when the host publishes none, fails closed on unknown shapes', () => {
    expect(withinWorkingHours(null, monday10)).toBe(true);
    expect(withinWorkingHours(undefined, monday10)).toBe(true);
    expect(withinWorkingHours({ mon: '9-5' }, monday10)).toBe(false);
  });
  it('checks day and time, optionally in a time zone', () => {
    expect(withinWorkingHours(hours, monday10)).toBe(true);
    expect(withinWorkingHours(hours, new Date(2026, 10, 2, 18, 0))).toBe(false);
    expect(withinWorkingHours(hours, new Date(2026, 10, 1, 10, 0))).toBe(false);
    expect(withinWorkingHours({ slots: [{ day: 7, from: '00:00', to: '23:59' }] }, new Date(2026, 10, 1, 10, 0))).toBe(true);
    expect(withinWorkingHours({ slots: [{ day: 1, from: 'x', to: '17:00' }] }, monday10)).toBe(false);
    const utc = { timezone: 'UTC', slots: [{ day: 1, from: '09:00', to: '11:00' }] };
    expect(withinWorkingHours(utc, new Date('2026-11-02T10:00:00Z'))).toBe(true);
    expect(withinWorkingHours({ ...utc, timezone: 'Not/AZone' }, monday10)).toBe(true);
  });
});

describe('idle monitor (local only)', () => {
  it('reports the away period once input resumes', () => {
    const monitor = new IdleMonitor(600);
    const t0 = new Date('2026-11-02T10:00:00Z');
    expect(monitor.observe(30, t0)).toBeNull();
    expect(monitor.observe(700, new Date('2026-11-02T10:10:00Z'))).toBeNull();
    expect(monitor.isIdle).toBe(true);
    expect(monitor.observe(1300, new Date('2026-11-02T10:20:00Z'))).toBeNull();
    const period = monitor.observe(5, new Date('2026-11-02T10:30:00Z'));
    expect(period).toEqual({ from: new Date('2026-11-02T09:58:20Z'), to: new Date('2026-11-02T10:29:55Z') });
    expect(monitor.isIdle).toBe(false);
    monitor.observe(900, t0);
    monitor.reset();
    expect(monitor.isIdle).toBe(false);
    monitor.observe(600, t0);
    expect(monitor.observe(599, new Date(t0.getTime() - 600_000))).toBeNull();
  });
  it('clamps to the timer start and now', () => {
    const now = new Date('2026-11-02T11:00:00Z');
    const period = { from: new Date('2026-11-02T09:00:00Z'), to: new Date('2026-11-02T12:00:00Z') };
    expect(clampPeriod(period, '2026-11-02T10:00:00Z', now)).toEqual({ from: new Date('2026-11-02T10:00:00Z'), to: now });
    expect(clampPeriod(period, '2026-11-02T11:30:00Z', now)).toBeNull();
  });
});

describe('settings and consent', () => {
  it('persists locally with defaults and dated consent', () => {
    const storage = new MemoryStorage();
    expect(loadLocal(storage)).toEqual(emptyState());
    storage.setItem('time-track-desktop', '{broken');
    expect(loadLocal(storage)).toEqual(emptyState());
    const at = new Date('2026-11-02T08:00:00Z');
    const state = recordConsent(emptyState(), 'idleDetection', true, at);
    expect(state.settings.idleDetection).toBe(true);
    expect(state.consents.idleDetection).toEqual({ granted: true, at: at.toISOString(), textVersion: 1 });
    expect(hasConsent(state, 'idleDetection')).toBe(true);
    expect(hasConsent(state, 'notifications')).toBe(false);
    saveLocal(state, storage);
    expect(loadLocal(storage).settings).toMatchObject({ idleDetection: true, idleMinutes: 10, autostart: false });
    expect(hasConsent(recordConsent(state, 'idleDetection', false), 'idleDetection')).toBe(false);
  });
});

describe('device flow and offline queue against the mock', async () => {
  const env = await startMock();
  const api = () => new TimeTrackApi({ baseUrl: env.url, source: 'desktop', fetchImpl: nodeFetch });
  const noSleep = () => Promise.resolve();

  it('polls until approved, honouring slow_down', async () => {
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
    const sleeps: number[] = [];
    const login = await runDeviceFlow(api(), {
      clientName: 'Test',
      sleep: async (ms) => void sleeps.push(ms),
      onCode: async (code) => {
        setTimeout(() => void env.control('device/approve', { userCode: code.userCode }), 20);
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
    });
    expect(login.token).toHaveLength(43);
    expect(sleeps[0]).toBe(1000);
  });

  it('ends on denied, expired, invalid scope and cancel', async () => {
    await env.control('reset', {});
    const denied = runDeviceFlow(api(), {
      clientName: 'Test',
      sleep: noSleep,
      onCode: (code) => env.control('device/approve', { userCode: code.userCode, approve: false }).then(() => undefined),
    });
    await expect(denied).rejects.toMatchObject({ reason: 'denied' });
    let clock = 0;
    const expired = runDeviceFlow(api(), { clientName: 'Test', sleep: async () => void (clock += 700_000), now: () => clock, onCode: () => undefined });
    await expect(expired).rejects.toMatchObject({ reason: 'expired' });
    await expect(runDeviceFlow(api(), { clientName: 'x', scopes: ['nope' as never], onCode: () => undefined })).rejects.toBeInstanceOf(DeviceFlowError);
    const controller = new AbortController();
    controller.abort();
    await expect(runDeviceFlow(api(), { clientName: 'x', sleep: noSleep, signal: controller.signal, onCode: () => undefined })).rejects.toMatchObject({ reason: 'cancelled' });
    await env.control('config', { failNext: { status: 500, error: 'boom' } });
    await expect(runDeviceFlow(api(), { clientName: 'x', onCode: () => undefined })).rejects.toMatchObject({ code: 'boom' });
    await env.control('config', { deviceInterval: 1 });
    let slow = 0;
    const slowFlow = runDeviceFlow(api(), {
      clientName: 'x',
      sleep: async () => {
        slow++;
      },
      onCode: () => undefined,
    });
    // Two immediate polls → pending then slow_down; then approve.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const state = (await env.control('state')) as { requests: { path: string }[] };
    expect(state.requests.some((r) => r.path.endsWith('device/token'))).toBe(true);
    await env.control('reset', {});
    await expect(slowFlow).rejects.toMatchObject({ reason: 'expired' });
    expect(slow).toBeGreaterThan(1);
  });

  it('replays offline actions in order with the original stop time', async () => {
    await env.control('reset', {});
    const client = api();
    client.setToken((await client.login('ada@example.com', 'app-password-123')).token);
    const queue = new OfflineQueue(new MemoryStorage());
    const t = (offset: number) => new Date(Date.now() + offset).toISOString();
    queue.push({ kind: 'start', taskId: 'T-101', taskTitle: 'A', at: t(-60_000) });
    queue.push({ kind: 'switch', taskId: 'T-102', taskTitle: 'B', at: t(-30_000) });
    queue.push({ kind: 'start', taskId: 'T-900', taskTitle: 'Forbidden', at: t(-20_000) });
    queue.push({ kind: 'stop', at: t(60_000) });
    queue.push({ kind: 'stop', at: t(-1000) });
    expect(queue.size).toBe(5);
    const result = await queue.sync(client);
    expect(result.synced).toBe(4);
    expect(result.dropped).toEqual([{ action: expect.objectContaining({ taskId: 'T-900' }), code: 'task_forbidden' }]);
    expect(result.timer).toBeNull();
    expect(queue.size).toBe(0);
    const { entries } = (await env.control('state')) as { entries: Record<string, { taskId: string }[]> };
    expect(Object.values(entries).flat().map((e) => e.taskId)).toEqual(['T-101', 'T-102']);

    await client.start('T-103');
    queue.push({ kind: 'start', taskId: 'T-104', taskTitle: 'D', at: t(0) });
    expect((await queue.sync(client)).timer?.taskId).toBe('T-104');
  });

  it('keeps the queue on network errors and re-throws 401', async () => {
    const queue = new OfflineQueue(new MemoryStorage());
    queue.push({ kind: 'stop', at: new Date().toISOString() });
    const offline = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: 'x', fetchImpl: () => Promise.reject(new Error('offline')) });
    await expect(queue.sync(offline)).rejects.toMatchObject({ code: 'network_error' });
    expect(queue.size).toBe(1);
    await expect(queue.sync(api())).rejects.toMatchObject({ status: 401 });
    expect(queue.list()).toHaveLength(1);
    queue.clear();
    const broken = new MemoryStorage();
    broken.setItem('time-track-desktop.queue', '{');
    expect(new OfflineQueue(broken).list()).toEqual([]);
  });
});

describe('time formatting (shared with the extension)', async () => {
  const { elapsedSeconds, formatBadge, formatElapsed } = await import('../../src/lib/time');
  const { detectLocale } = await import('../../src/lib/i18n');
  it('formats', () => {
    expect(elapsedSeconds('bad')).toBe(0);
    expect(formatElapsed(3725)).toBe('1:02:05');
    expect([formatBadge(59), formatBadge(3900), formatBadge(40000)]).toEqual(['0m', '1h05', '10h+']);
    expect(detectLocale('es')).toBe('es');
    expect(createTranslator('en')('nope' as never)).toBe('nope');
  });
});
