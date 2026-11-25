// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { preflight } from '../../src/lib/preflight';
import { hostOf, prepareServerUrl } from '../../src/lib/serverUrl';
import { computeTotals, formatHoursMinutes, recentTasks, startOfWeek, taskContext, todayByTask } from '../../src/lib/summary';
import { h, patch } from '../../src/ui/dom';
import { icon } from '../../src/ui/icons';

const entry = (taskId: string, from: string, to: string) => ({ id: `${taskId}-${from}`, taskId, taskTitle: `Task ${taskId}`, startedAt: from, endedAt: to, durationSeconds: 0 });

describe('server address', () => {
  it('adds https://, strips Beacon paths and trailing slashes', () => {
    expect(prepareServerUrl(' beacon.example.com ')).toEqual({ ok: true, url: 'https://beacon.example.com' });
    expect(prepareServerUrl('https://beacon.example.com/dashboard/tasks/time')).toEqual({ ok: true, url: 'https://beacon.example.com' });
    expect(prepareServerUrl('https://example.com/beacon/login')).toEqual({ ok: true, url: 'https://example.com/beacon' });
    expect(prepareServerUrl('https://example.com/beacon/')).toEqual({ ok: true, url: 'https://example.com/beacon' });
    expect(prepareServerUrl('http://127.0.0.1:8787/device')).toEqual({ ok: true, url: 'http://127.0.0.1:8787' });
    expect(prepareServerUrl('beacon.example.com:8443/api/time-track/me')).toEqual({ ok: true, url: 'https://beacon.example.com:8443' });
  });

  it('explains what is wrong', () => {
    expect(prepareServerUrl('')).toEqual({ ok: false, problem: 'empty' });
    expect(prepareServerUrl('https://')).toEqual({ ok: false, problem: 'invalid' });
    expect(prepareServerUrl('ftp://beacon.example.com')).toEqual({ ok: false, problem: 'invalid' });
    expect(prepareServerUrl('https://a b')).toEqual({ ok: false, problem: 'invalid' });
    expect(prepareServerUrl('https://u:p@beacon.example.com')).toEqual({ ok: false, problem: 'credentials' });
    expect(prepareServerUrl('http://beacon.example.com')).toEqual({ ok: false, problem: 'insecure' });
    expect(hostOf('https://beacon.example.com:8443/x')).toBe('beacon.example.com:8443');
    expect(hostOf(null)).toBe('');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('totals and recents (local, from entries)', () => {
  const now = new Date(2026, 10, 4, 12, 0, 0); // Wednesday 4 Nov 2026, 12:00 local
  it('clips entries to today and this week, with the running timer', () => {
    expect(startOfWeek(now)).toEqual(new Date(2026, 10, 2));
    expect(startOfWeek(new Date(2026, 10, 8, 23))).toEqual(new Date(2026, 10, 2));
    const entries = [
      entry('A', new Date(2026, 10, 4, 9).toISOString(), new Date(2026, 10, 4, 10, 30).toISOString()),
      entry('B', new Date(2026, 10, 3, 23).toISOString(), new Date(2026, 10, 4, 1).toISOString()),
      entry('C', new Date(2026, 10, 1, 10).toISOString(), new Date(2026, 10, 1, 11).toISOString()),
      entry('D', 'bad', 'bad'),
    ];
    const timer = { id: 't', taskId: 'A', taskTitle: 'Task A', startedAt: new Date(2026, 10, 4, 11, 30).toISOString() };
    expect(computeTotals(entries, timer, now)).toEqual({ today: (90 + 60 + 30) * 60, week: (90 + 120 + 30) * 60 });
    expect(computeTotals([], null, now)).toEqual({ today: 0, week: 0 });
    expect(todayByTask(entries, timer, now)).toEqual(new Map([['A', 120 * 60], ['B', 60 * 60]]));
    expect(recentTasks(entries, [{ id: 'B', title: 'Known B', boardTitle: 'Board' }]).map((task) => task.title)).toEqual(['Task A', 'Known B', 'Task C', 'Task D']);
    expect(recentTasks(entries, [], 1)).toHaveLength(1);
  });

  it('formats H:MM and the task context', () => {
    expect(formatHoursMinutes(0)).toBe('0:00');
    expect(formatHoursMinutes(3 * 3600 + 42 * 60 + 59)).toBe('3:42');
    expect(formatHoursMinutes(-5)).toBe('0:00');
    expect(taskContext({ projectTitle: 'Billing', boardTitle: 'Engineering' })).toBe('Billing · Engineering');
    expect(taskContext({ projectTitle: ' ', boardTitle: 'Engineering' })).toBe('Engineering');
    expect(taskContext({})).toBe('');
  });
});

describe('error catalogue', () => {
  const ctx = { stage: 'action' as const, server: 'https://beacon.example.com', version: '0.2.0', now: new Date('2026-11-04T10:00:00Z') };
  it('maps failures to a title, a next step and actions; the raw message goes to the details only', () => {
    expect(describeError(new ApiError(0, 'network_error', 'TLS'), ctx)).toMatchObject({ id: 'unreachable', params: { host: 'beacon.example.com' } });
    expect(describeError(new ApiError(404, 'not_found', 'Not Found'), { ...ctx, stage: 'preflight' })).toMatchObject({ id: 'not_beacon', actions: ['retry', 'help', 'copy'] });
    expect(describeError(new ApiError(405, 'server_error', 'x'), { ...ctx, stage: 'deviceCode' })).toMatchObject({ id: 'no_device_flow', title: 'errNoDeviceFlowTitle' });
    expect(describeError(new ApiError(429, 'rate_limited', 'x'), ctx)).toMatchObject({ id: 'rate_limited', text: 'errRateLimitedText' });
    expect(describeError(new ApiError(429, 'rate_limited', 'x', 2.5), ctx)).toMatchObject({ text: 'errRateLimitedWait', params: { seconds: 3 } });
    expect(describeError(new ApiError(403, 'task_forbidden', 'x'), { ...ctx, task: 'T' })).toMatchObject({ id: 'task_forbidden', params: { task: 'T' } });
    expect(describeError(new ApiError(200, 'invalid_response', 'x'), ctx)).toMatchObject({ id: 'invalid_response' });
    expect(describeError(new ApiError(502, 'server_error', 'Bad gateway'), ctx)).toMatchObject({ id: 'server' });
    // Start at login refused by the host (Tauri rejects with the command's error string).
    expect(describeError('autostart:elevated: TimeTrack runs as administrator', ctx)).toMatchObject({ id: 'autostart_elevated', title: 'errAutostartTitle', text: 'errAutostartElevated', actions: ['copy'] });
    expect(describeError(new Error('autostart:not_installed: x'), ctx)).toMatchObject({ text: 'errAutostartNotInstalled' });
    expect(describeError('autostart:taken: x', ctx)).toMatchObject({ text: 'errAutostartTaken' });
    expect(describeError('autostart:other: x', ctx)).toMatchObject({ id: 'generic' });
    expect(describeError(new ApiError(400, 'invalid_request', 'x'), ctx)).toMatchObject({ id: 'generic' });
    const plain = describeError('boom', { stage: 'action', server: null, version: '0.2.0' });
    expect(plain.id).toBe('generic');
    expect(plain.details).toContain('code: client_error');
    expect(plain.details).toContain('server: -');
    const details = describeError(new ApiError(404, 'not_found', 'Not Found'), ctx).details;
    expect(details).toBe(
      'Beacon Desktop 0.2.0\nserver: https://beacon.example.com\nstage: action\ncode: not_found\nstatus: 404\nmessage: Not Found\nat: 2026-11-04T10:00:00.000Z',
    );
  });
});

describe('connect preflight', () => {
  const answer = (status: number, headers: Record<string, string> = {}) =>
    (async () => ({ status, headers: { get: (name: string) => headers[name] ?? null } })) as unknown as typeof fetch;
  it('accepts 401 / 403 / 2xx, maps 404 / 405 / redirects, 429 and 5xx, network errors', async () => {
    await expect(preflight(answer(401), 'https://b')).resolves.toBeUndefined();
    await expect(preflight(answer(200), 'https://b')).resolves.toBeUndefined();
    await expect(preflight(answer(403), 'https://b')).resolves.toBeUndefined();
    await expect(preflight(answer(404), 'https://b')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(preflight(answer(302), 'https://b')).rejects.toMatchObject({ status: 302 });
    await expect(preflight(answer(0), 'https://b')).rejects.toMatchObject({ status: 404 });
    await expect(preflight(answer(429, { 'Retry-After': '9' }), 'https://b')).rejects.toMatchObject({ status: 429, retryAfter: 9 });
    await expect(preflight(answer(429), 'https://b')).rejects.toMatchObject({ retryAfter: null });
    await expect(preflight(answer(503), 'https://b')).rejects.toMatchObject({ status: 503, code: 'server_error' });
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(preflight(down, 'https://b')).rejects.toMatchObject({ status: 0, code: 'network_error' });
    const odd = (async () => {
      throw 'x';
    }) as unknown as typeof fetch;
    await expect(preflight(odd, 'https://b')).rejects.toMatchObject({ message: 'Network error.' });
  });
});

describe('region patch keeps focus', () => {
  it('restores focus by key or id, with selection, and falls back', () => {
    const region = h('div');
    const other = h('button', { id: 'other' });
    document.body.replaceChildren(region, other);
    patch(region, [h('input', { id: 'field' }), h('button', { key: 'k' })]);
    const field = region.querySelector('input') as HTMLInputElement;
    field.value = 'abc';
    field.focus();
    field.setSelectionRange(1, 2);
    const next = h('input', { id: 'field' });
    next.value = 'abc';
    patch(region, [next]);
    expect(document.activeElement).toBe(next);
    expect([next.selectionStart, next.selectionEnd]).toEqual([1, 2]);
    patch(region, [h('button', { key: 'k' })]);
    patch(region, [h('button', { key: 'k' }, 'again')]);
    (region.querySelector('[data-key="k"]') as HTMLElement).focus();
    patch(region, [h('button', { key: 'k' }, 'third')]);
    expect(document.activeElement?.textContent).toBe('third');
    patch(region, [h('span')], '#other');
    expect(document.activeElement).toBe(other);
    patch(region, [h('span')]);
    expect(document.activeElement).toBe(other);
    region.append(h('button', { id: 'gone' }));
    (region.querySelector('#gone') as HTMLElement).focus();
    patch(region, [], 'missing');
    expect(icon('settings').getAttribute('aria-hidden')).toBe('true');
    expect(icon('stop').querySelector('rect')?.getAttribute('rx')).toBe('2');
    expect(icon('clock').querySelector('circle')?.getAttribute('r')).toBe('9');
  });
});
