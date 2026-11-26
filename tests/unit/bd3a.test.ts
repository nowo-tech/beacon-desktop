// @vitest-environment happy-dom
// BD-3a: `X-Beacon-Context` on the time API (single Personal retry for reads), required time fields on start / stop
// (owner Q5), the organization switch with a running timer (Q4) and the mini timer (Q2), against the in-process mock
// Beacon (TimeTrack 2.1 subjects / activity types, 2.2 context policy) with the browser platform's fake host.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TimeTrackApi } from '../../src/api/client';
import { browserMiniClient, browserPlatform, type BrowserMiniHooks } from '../../src/platform';
import { Shell } from '../../src/shell/shell';
import { DesktopApp } from '../../src/ui/app';
import { clockText, MiniTimer, type MiniView } from '../../src/ui/miniWindow';
import {
  allocationFeatures,
  allocationOf,
  asksOnStart,
  asksOnStop,
  groupActivities,
  inheritedActivity,
  isAllocationRequired,
  MAX_TASK_ACTIVITIES,
  meContexts,
  missingFields,
  rememberTaskActivity,
  sanitizeAskOn,
  sanitizeTaskActivities,
  taskActivityKey,
  taskSubjectTypes,
} from '../../src/lib/allocation';
import { loadLocal } from '../../src/lib/settings';
import type { Me } from '../../src/api/types';
import { nodeFetch, startMock, until } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());
beforeEach(async () => {
  localStorage.clear();
  await env.control('reset', {});
  await env.control('config', { deviceInterval: 1 });
});

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ORG2 = 'org:7b1f2a9f-2c3d-4e4f-9a01-b2c3d4e5f6a7';

type Request = { method: string; path: string; body: string; context: string | null };
async function requests(): Promise<Request[]> {
  return ((await env.control('state')) as { requests: Request[] }).requests;
}

async function token(): Promise<string> {
  const login = (await (await nodeFetch(`${env.url}/api/time-track/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ada@example.com', password: 'app-password-123', clientType: 'desktop' }) })).json()) as { token: string };
  return login.token;
}

describe('time API context (X-Beacon-Context, BD-3a)', () => {
  it('sends the context on every request and nothing without one', async () => {
    const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: await token(), fetchImpl: nodeFetch, context: ORG });
    expect(api.currentContext).toBe(ORG);
    await api.me();
    await api.tasks();
    await api.start('T-101');
    await api.stop();
    const sent = (await requests()).filter((item) => item.path.startsWith('/api/time-track/') && !item.path.endsWith('login'));
    expect(sent.map((item) => item.context)).toEqual([ORG, ORG, ORG, ORG]);
    const plain = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: await token(), fetchImpl: nodeFetch, context: 'bad key!' });
    expect(plain.currentContext).toBeNull();
    await plain.me();
    expect((await requests()).at(-1)?.context).toBeNull();
  });

  it('retries a read once in Personal after 403 context_forbidden, never a write', async () => {
    await env.control('config', { contextPolicy: { required: true, refuse: [ORG2] } });
    const refused: string[] = [];
    const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: await token(), fetchImpl: nodeFetch, context: ORG2, onContextRefused: (key) => refused.push(key) });
    const me = await api.me();
    expect(refused).toEqual([ORG2]);
    expect(api.currentContext).toBe('personal');
    expect(meContexts(me as Me)).toEqual({ contexts: [{ key: 'personal', label: 'Personal' }, { key: ORG, label: 'Lumen Works' }], context: 'personal' });
    const reads = (await requests()).filter((item) => item.path.endsWith('/me'));
    expect(reads.map((item) => item.context)).toEqual([ORG2, 'personal']);
    // A write in a refused context fails (its time would otherwise land in another organization).
    const writer = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: await token(), fetchImpl: nodeFetch, context: ORG2, onContextRefused: (key) => refused.push(key) });
    await expect(writer.start('T-101')).rejects.toMatchObject({ status: 403, code: 'context_forbidden' });
    expect(writer.currentContext).toBe('personal');
    expect((await requests()).filter((item) => item.path.endsWith('timer/start')).length).toBe(1);
    // Personal is never retried, and another 403 (task_forbidden) never switches context.
    const personal = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: await token(), fetchImpl: nodeFetch, context: ORG });
    await expect(personal.start('T-900')).rejects.toMatchObject({ code: 'task_forbidden' });
    expect(personal.currentContext).toBe(ORG);
    // No header while the host requires one.
    const none = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: await token(), fetchImpl: nodeFetch });
    await expect(none.me()).rejects.toMatchObject({ status: 400, code: 'context_required' });
  });

  it('reads activity types, searches subjects, allocates and sends allocations (TimeTrack 2.1)', async () => {
    await env.control('config', { allocation: { requireActivityType: true } });
    const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: await token(), fetchImpl: nodeFetch, context: 'personal' });
    expect((await api.activityTypes()).map((item) => item.key)).toEqual(['dev', 'review', 'meeting', 'support']);
    expect((await api.searchSubjects('customer', 'orb')).map((item) => item.label)).toEqual(['Orbita Logistics']);
    await expect(api.searchSubjects('Bad Type', '')).rejects.toBeInstanceOf(ApiError);
    expect(await api.allocate({ activityTypeKey: 'dev' })).toBeNull();
    const started = await api.startAt('T-101', { allocation: { activityTypeKey: 'review', subject: { type: 'customer', id: '42' } } });
    expect(started.timer.activityType).toEqual({ key: 'review', label: 'Code review' });
    expect((await api.allocate({ subject: null, activityTypeKey: 'Bad key' }))?.subject).toBeNull();
    const switched = await api.switchTask('T-102', undefined, { allocation: { activityTypeKey: 'meeting' } });
    expect(switched.timer?.activityType?.key).toBe('meeting');
    await expect(api.allocate({ activityTypeKey: 'nope' })).rejects.toMatchObject({ code: 'activity_type_unknown' });
    const sent = (await requests()).filter((item) => item.path.endsWith('timer/allocate')).map((item) => JSON.parse(item.body) as unknown);
    // A malformed key is never sent.
    expect(sent[1]).toEqual({ subject: null });
    // A stop without the required activity type is refused, the timer keeps running.
    await api.allocate({ activityTypeKey: 'dev' });
    await env.control('config', { allocation: { requireActivityType: true } });
    const page = await api.stopAt({ allocation: { activityTypeKey: 'dev' } });
    expect(page.entry?.taskId).toBe('T-102');
    await api.start('T-103');
    await expect(api.stopAt()).rejects.toMatchObject({ status: 409, code: 'activity_type_required' });
    expect(await api.timer()).not.toBeNull();
  });
});

describe('required fields helpers (Q5)', () => {
  const me = { features: { subjects: [{ type: 'customer', label: 'Customer', allowsTask: true }, { type: 'project', label: 'Project', allowsTask: false }, { type: 'Bad', label: 'x' }], activityTypes: true, requireActivityType: true, requireAllocation: false } } as unknown as Me;

  it('reads the features defensively and mirrors the server rule', () => {
    const features = allocationFeatures(me);
    expect(features.subjects.map((item) => item.type)).toEqual(['customer', 'project']);
    expect(taskSubjectTypes(features).map((item) => item.type)).toEqual(['customer']);
    expect(allocationFeatures(null)).toEqual({ subjects: [], activityTypes: false, requireAllocation: false, requireActivityType: false });
    expect(allocationFeatures({ features: { subjects: 'x' } } as unknown as Me).subjects).toEqual([]);
    expect(missingFields(features, { taskId: 'T-1', activityType: null })).toEqual({ activityType: true, subject: false });
    expect(missingFields(features, { taskId: 'T-1', activityType: { key: 'dev', label: 'Dev' } })).toEqual({ activityType: false, subject: false });
    expect(missingFields({ ...features, requireAllocation: true }, { taskId: '', subject: null })).toEqual({ activityType: true, subject: true });
    expect(missingFields(features, null)).toEqual({ activityType: false, subject: false });
    expect(isAllocationRequired('activity_type_required') && isAllocationRequired('allocation_required') && !isAllocationRequired('forbidden')).toBe(true);
  });

  it('asks on stop by default, on start or both when chosen', () => {
    expect(sanitizeAskOn(undefined)).toBe('stop');
    expect(sanitizeAskOn('both')).toBe('both');
    expect(sanitizeAskOn('later')).toBe('stop');
    expect([asksOnStart('stop'), asksOnStop('stop'), asksOnStart('start'), asksOnStop('start'), asksOnStart('both'), asksOnStop('both')]).toEqual([false, true, true, false, true, true]);
    const state = loadLocal(localStorage);
    expect(state.settings.askOn).toBe('stop');
    expect(state.settings.inheritActivity).toBe(true);
    expect(state.taskActivities).toEqual({});
  });

  it('remembers the last activity type per context and task, bounded', () => {
    const key = taskActivityKey(ORG, 'T-1');
    expect(key).toBe(`${ORG}|T-1`);
    expect(taskActivityKey(null, 'T-1')).toBe('personal|T-1');
    let map = rememberTaskActivity({}, key, 'dev');
    expect(map).toEqual({ [key]: 'dev' });
    expect(rememberTaskActivity(map, key, 'dev')).toBe(map);
    expect(rememberTaskActivity(map, key, 'Bad Key')).toBe(map);
    expect(rememberTaskActivity(map, key, null)).toBe(map);
    for (let i = 0; i < MAX_TASK_ACTIVITIES + 5; i++) map = rememberTaskActivity(map, taskActivityKey(ORG, `T-${i + 2}`), 'review');
    expect(Object.keys(map).length).toBe(MAX_TASK_ACTIVITIES);
    expect(map[key]).toBeUndefined();
    expect(sanitizeTaskActivities({ 'a|b': 'dev', nopipe: 'dev', 'c|d': 5 })).toEqual({ 'a|b': 'dev' });
    expect(sanitizeTaskActivities([1])).toEqual({});
    const offered = [{ key: 'dev', label: 'Dev' }];
    expect(inheritedActivity(true, { [key]: 'dev' }, key, offered)).toBe('dev');
    expect(inheritedActivity(true, { [key]: 'gone' }, key, offered)).toBeNull();
    expect(inheritedActivity(false, { [key]: 'dev' }, key, offered)).toBeNull();
    expect(inheritedActivity(true, { [key]: 'dev' }, key, null)).toBe('dev');
    expect(inheritedActivity(true, {}, key, offered)).toBeNull();
    expect(allocationOf('dev', { type: 'customer', id: '42', label: 'Fernhill' })).toEqual({ activityTypeKey: 'dev', subject: { type: 'customer', id: '42' } });
    expect(allocationOf(null, { type: 'customer', label: 'Hidden', hidden: true })).toEqual({});
    expect(groupActivities([{ key: 'a', label: 'A', group: 'G' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C', group: 'G' }]).map((group) => [group.group, group.items.map((item) => item.key)])).toEqual([
      ['G', ['a', 'c']],
      [null, ['b']],
    ]);
    expect(meContexts({ contexts: [{ key: 'personal', label: 'Personal' }, { key: 'bad key', label: 'x' }], context: 7 } as unknown as Me)).toEqual({ contexts: [{ key: 'personal', label: 'Personal' }], context: null });
  });
});

function mount(platform = browserPlatform('0.1.0', nodeFetch)) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const shell = new Shell(root, platform, { locale: 'en', storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, {
    storage: localStorage,
    locale: 'en',
    onRender: () => shell.onAppRender(),
    beforeSignOut: () => shell.chat.revokeOnServer(),
    askAllocation: (request) => shell.askAllocation(request),
    onContextRefused: (context) => void shell.timeContextRefused(context),
    contextLabel: () => shell.contextLabel(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
  });
  shell.attach(app);
  shell.freshSignIn = true;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  return { root, platform, shell, app, $ };
}

async function signedIn() {
  const ui = mount();
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
  await done;
  await until(() => !ui.app.busy, 'the time module');
  return ui;
}

const dialogOpen = () => (document.querySelector('#alloc-dialog') as HTMLDialogElement | null)?.open === true;

async function chooseActivity(ui: ReturnType<typeof mount>, key: string) {
  await until(() => !ui.$<HTMLSelectElement>('#alloc-activity').disabled, 'the activity types');
  const select = ui.$<HTMLSelectElement>('#alloc-activity');
  select.value = key;
  select.dispatchEvent(new Event('change'));
}

function submit(ui: ReturnType<typeof mount>) {
  ui.$<HTMLFormElement>('#alloc-dialog form').dispatchEvent(new Event('submit', { cancelable: true }));
}

async function startTask(ui: ReturnType<typeof mount>, id: string) {
  const task = ui.app.tasks.find((item) => item.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  await ui.app.start(task);
}

describe('required fields in the app (Q5)', () => {
  it('asks on stop, keeps the timer on Cancel, stops with the chosen type and inherits it next time', async () => {
    await env.control('config', { allocation: { requireActivityType: true } });
    const ui = await signedIn();
    expect(ui.app.allocationFeatures().requireActivityType).toBe(true);
    await startTask(ui, 'T-104');
    expect(ui.app.state.activeTimer?.taskId).toBe('T-104');
    expect(ui.app.stopMissing()).toEqual({ activityType: true, subject: false });
    // Cancel: nothing is sent, the timer keeps running.
    const cancelled = ui.app.stop();
    await until(dialogOpen, 'the fields dialog');
    expect(ui.$('#alloc-title').textContent).toBe('Stop timer');
    expect(ui.$('.alloc-policy').textContent).toContain('requires an activity type');
    expect(ui.platform.hooks.broughtForward).toBeGreaterThan(0);
    ui.$<HTMLButtonElement>('#alloc-cancel').click();
    expect(await cancelled).toBe('cancelled');
    expect(ui.app.state.activeTimer).not.toBeNull();
    expect((await requests()).some((item) => item.path.endsWith('timer/stop'))).toBe(false);
    // Submitting empty shows the error (only after the submit), then a choice saves.
    const stopping = ui.app.stop();
    await until(dialogOpen, 'the fields dialog');
    await until(() => !ui.$<HTMLSelectElement>('#alloc-activity').disabled, 'the activity types');
    expect(ui.$('#alloc-activity').getAttribute('aria-invalid')).toBe('false');
    expect(ui.$('#alloc-activity-row').classList.contains('invalid')).toBe(false);
    submit(ui);
    expect(ui.$('#alloc-activity-row').classList.contains('invalid')).toBe(true);
    expect(ui.$('#alloc-activity').getAttribute('aria-invalid')).toBe('true');
    expect(ui.$('#alloc-activity').getAttribute('aria-describedby')).toBe('alloc-activity-err');
    expect(dialogOpen()).toBe(true);
    await chooseActivity(ui, 'review');
    expect(ui.$('#alloc-activity').getAttribute('aria-invalid')).toBe('false');
    // The optional subject: search, keyboard pick.
    const input = ui.$<HTMLInputElement>('#alloc-subject');
    input.value = 'fern';
    input.dispatchEvent(new Event('input'));
    await until(() => document.querySelector('#alloc-subject-0') !== null, 'the subject results');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(input.value).toBe('Fernhill Retail');
    submit(ui);
    expect(await stopping).toBe('stopped');
    const stop = (await requests()).filter((item) => item.path.endsWith('timer/stop')).at(-1);
    expect(JSON.parse(stop?.body ?? '{}')).toMatchObject({ activityTypeKey: 'review', subject: { type: 'customer', id: '42' } });
    expect(ui.app.state.taskActivities[taskActivityKey('personal', 'T-104')]).toBe('review');
    // Next start on T-104 inherits "review" and asks nothing on stop.
    await startTask(ui, 'T-104');
    const start = (await requests()).filter((item) => item.path.endsWith('timer/start')).at(-1);
    expect(JSON.parse(start?.body ?? '{}').activityTypeKey).toBe('review');
    expect(ui.app.stopMissing().activityType).toBe(false);
    expect(await ui.app.stop()).toBe('stopped');
    expect(dialogOpen()).toBe(false);
  });

  it('asks on start when chosen, asks before a switch, and answers a refused stop (409)', async () => {
    await env.control('config', { allocation: { requireActivityType: true, subjects: false } });
    const ui = await signedIn();
    ui.app.setAllocationSetting({ askOn: 'start', inheritActivity: false });
    const starting = startTask(ui, 'T-101');
    await until(dialogOpen, 'the start dialog');
    expect(ui.$('#alloc-title').textContent).toBe('Start "Write onboarding guide"');
    expect(document.querySelector('#alloc-subject')).toBeNull();
    await chooseActivity(ui, 'dev');
    submit(ui);
    await starting;
    expect(ui.app.state.activeTimer?.activityType?.key).toBe('dev');
    // Cancel on start: nothing starts.
    ui.app.setAllocationSetting({ askOn: 'both' });
    const switching = startTask(ui, 'T-102');
    await until(dialogOpen, 'the start dialog');
    ui.$<HTMLButtonElement>('#alloc-cancel').click();
    await switching;
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    // The server refuses a stop the app did not expect (asks on start only, a timer started on the web).
    ui.app.setAllocationSetting({ askOn: 'start' });
    await env.control('config', { allocation: { requireActivityType: true, subjects: false } });
    const timer = ui.app.state.activeTimer;
    if (timer === null) throw new Error('no timer');
    timer.activityType = null;
    const api = ui.app.timeApi();
    await api?.allocate({ subject: null });
    // Locally the timer has a type, on the server it is cleared below through a fresh start.
    await api?.stop();
    await api?.start('T-103');
    ui.app.state.activeTimer = { ...(await api?.timer())!, activityType: { key: 'dev', label: 'Development' } };
    const refused = ui.app.stop();
    await until(dialogOpen, 'the dialog after the 409');
    await chooseActivity(ui, 'support');
    submit(ui);
    expect(await refused).toBe('stopped');
    const stops = (await requests()).filter((item) => item.path.endsWith('timer/stop'));
    expect(JSON.parse(stops.at(-1)?.body ?? '{}').activityTypeKey).toBe('support');
    // Switching away from a running timer without a type (asks on stop): the closing entry is allocated first.
    ui.app.setAllocationSetting({ askOn: 'stop' });
    await api?.start('T-105');
    ui.app.state.activeTimer = (await api?.timer())!;
    const swapping = startTask(ui, 'T-106');
    await until(dialogOpen, 'the switch dialog');
    expect(ui.$('#alloc-title').textContent).toBe('Save this entry before switching');
    expect(ui.$('#alloc-submit').textContent).toContain('Save and switch');
    await chooseActivity(ui, 'meeting');
    submit(ui);
    await swapping;
    const allocate = (await requests()).filter((item) => item.path.endsWith('timer/allocate')).at(-1);
    expect(JSON.parse(allocate?.body ?? '{}')).toEqual({ activityTypeKey: 'meeting' });
    expect(ui.app.state.activeTimer?.taskId).toBe('T-106');
  });

  it('shows offline and empty states for activity types and retries', async () => {
    await env.control('config', { allocation: { requireActivityType: true, noActivityTypes: true } });
    const ui = await signedIn();
    await startTask(ui, 'T-104');
    const stopping = ui.app.stop();
    await until(dialogOpen, 'the fields dialog');
    await until(() => ui.$('#alloc-activity-help').textContent?.includes('No activity types') === true, 'the empty state');
    expect(ui.$<HTMLSelectElement>('#alloc-activity').disabled).toBe(true);
    ui.$<HTMLButtonElement>('#alloc-cancel').click();
    expect(await stopping).toBe('cancelled');
    await env.control('config', { allocation: { requireActivityType: true }, failNext: { status: 429, error: 'rate_limited', retryAfter: 7 } });
    ui.app.setContext('personal');
    ui.app.setContext(ORG);
    ui.app.setContext('personal');
    const again = ui.app.stop();
    await until(dialogOpen, 'the fields dialog');
    await until(() => ui.$('#alloc-activity-help').textContent?.includes('Try again in 7 s') === true, 'the 429 state');
    ui.$<HTMLButtonElement>('#alloc-activity-retry').click();
    await chooseActivity(ui, 'dev');
    submit(ui);
    expect(await again).toBe('stopped');
  });
});

describe('organization switch with a running timer (Q4)', () => {
  it('asks the fields and the switch in one dialog; Cancel keeps both; time-only contexts come from GET me', async () => {
    await env.control('config', { allocation: { requireActivityType: true }, contextPolicy: { required: true, refuse: [] } });
    localStorage.setItem('beacon-desktop-shell', JSON.stringify({ context: ORG }));
    const ui = await signedIn();
    expect(ui.app.context).toBe(ORG);
    await until(() => ui.shell.contexts.length === 3, 'the time contexts');
    expect(ui.shell.context).toBe(ORG);
    expect(ui.shell.contextLabel()).toBe('Lumen Works');
    await startTask(ui, 'T-104');
    const switching = ui.shell.switchContext(ORG2);
    await until(dialogOpen, 'the switch dialog');
    expect(ui.$('#alloc-title').textContent).toBe('Stop the timer in Lumen Works and switch?');
    expect(ui.$('.alloc-lead').textContent).toContain('then switch to Harbor Studio');
    expect((document.querySelector('#shell-confirm') as HTMLDialogElement).open).toBe(false);
    ui.$<HTMLButtonElement>('#alloc-cancel').click();
    await switching;
    expect(ui.shell.context).toBe(ORG);
    expect(ui.app.state.activeTimer).not.toBeNull();
    const again = ui.shell.switchContext(ORG2);
    await until(dialogOpen, 'the switch dialog');
    await chooseActivity(ui, 'dev');
    submit(ui);
    await again;
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.shell.context).toBe(ORG2);
    expect(ui.app.context).toBe(ORG2);
    expect(JSON.parse(localStorage.getItem('beacon-desktop-shell') ?? '{}').context).toBe(ORG2);
    const stop = (await requests()).filter((item) => item.path.endsWith('timer/stop')).at(-1);
    expect(stop?.context).toBe(ORG);
    await until(() => !ui.app.busy, 'the reload');
    expect((await requests()).filter((item) => item.path.endsWith('/tasks')).at(-1)?.context).toBe(ORG2);
  });

  it('waits for time recorded offline before switching, and follows a refused context', async () => {
    await env.control('config', { contextPolicy: { required: false, refuse: [] } });
    const ui = await signedIn();
    await until(() => ui.shell.contexts.length === 3, 'the time contexts');
    ui.app.offline = true;
    await ui.shell.switchContext(ORG);
    expect(ui.shell.context).toBe('personal');
    ui.app.offline = false;
    await ui.shell.switchContext(ORG);
    expect(ui.app.context).toBe(ORG);
    await until(() => !ui.app.busy, 'the reload');
    // Beacon revokes Lumen Works: the next read falls back to Personal once and the shell follows.
    await env.control('config', { contextPolicy: { required: false, refuse: [ORG] } });
    await ui.app.refresh();
    expect(ui.app.context).toBe('personal');
    await until(() => ui.shell.context === 'personal', 'the shell to follow');
    expect(ui.$('#shell-live').textContent === '' || ui.$('#shell-live').textContent?.includes('Lumen Works')).toBe(true);
  });
});

describe('mini timer (Q2)', () => {
  it('opens from the title bar and the shortcut, follows the timer, and its buttons act in the main window', async () => {
    const ui = await signedIn();
    expect(ui.$('#tb-mini')).not.toBeNull();
    ui.$<HTMLButtonElement>('#tb-mini').click();
    await until(() => ui.platform.hooks.mini !== null, 'the mini timer');
    expect(ui.shell.miniOpen).toBe(true);
    expect(ui.$('#tb-mini').getAttribute('aria-pressed')).toBe('true');
    expect(ui.platform.hooks.mini).toMatchObject({ running: false, status: 'Not tracking', canStart: false });
    await startTask(ui, 'T-102');
    expect(ui.platform.hooks.mini).toMatchObject({ running: true, task: 'Review pull request queue', status: 'Tracking' });
    ui.platform.hooks.miniAction('stop');
    await until(() => ui.app.state.activeTimer === null, 'the stop from the mini timer');
    await until(() => ui.platform.hooks.mini?.canStart === true, 'resume offered');
    expect(ui.platform.hooks.mini?.labels.startTask).toBe('Resume "Review pull request queue"');
    ui.platform.hooks.miniAction('start');
    await until(() => ui.app.state.activeTimer?.taskId === 'T-102', 'the resume from the mini timer');
    ui.shell.show('chat');
    ui.platform.hooks.miniAction('expand');
    await until(() => ui.shell.module === 'time', 'back to the app');
    ui.platform.hooks.miniAction('closed');
    expect(ui.shell.miniOpen).toBe(false);
    // Ctrl+Shift+M toggles it.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await until(() => ui.shell.miniOpen, 'the shortcut');
    await ui.shell.toggleMini();
    expect(ui.platform.hooks.mini).toBeNull();
    // Settings: the time tracking group.
    ui.$<HTMLButtonElement>('#rail-settings').click();
    expect(ui.$('#shell-settings').textContent).toContain('Ask for required fields');
    ui.$<HTMLButtonElement>('#shell-settings [aria-label="Ask for required fields"] [data-value="both"]').click();
    expect(ui.app.state.settings.askOn).toBe('both');
    ui.$<HTMLButtonElement>(`#shell-settings [aria-label="Use the task's last activity type"] [data-value="off"]`).click();
    expect(ui.app.state.settings.inheritActivity).toBe(false);
    ui.$<HTMLButtonElement>('#settings-mini').click();
    await until(() => ui.shell.miniOpen, 'the mini timer from Settings');
  });

  it('renders the view, ticks without changing its width, and reports keys and buttons', async () => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const hooks: BrowserMiniHooks = { view: null, actions: [] };
    const client = browserMiniClient(hooks);
    let now = Date.parse('2026-11-26T10:00:00Z');
    const mini = new MiniTimer(root, client, () => now);
    client.onView((view) => mini.show(view));
    const view: MiniView = {
      theme: 'dark',
      lang: 'es',
      windowTitle: 'Mini temporizador',
      running: true,
      task: 'Fix invoice rounding bug',
      startedAt: '2026-11-26T08:58:55Z',
      status: 'Tracking · Lumen Works',
      canStart: false,
      busy: false,
      labels: { stop: 'Stop', start: 'Resume', startTask: 'Resume "x"', expand: 'Open Beacon Desktop', close: 'Close', noTask: 'Pick a task', elapsed: 'Elapsed' },
    };
    hooks.setView?.(view);
    expect(document.title).toBe('Mini temporizador');
    expect(document.documentElement.lang).toBe('es');
    expect(root.querySelector('#mini-time')?.textContent).toBe('1:01:05');
    expect(root.querySelector('#mini-hint')?.hasAttribute('hidden')).toBe(true);
    (root.querySelector('#mini-toggle') as HTMLButtonElement).click();
    (root.querySelector('#mini-expand') as HTMLButtonElement).click();
    const key = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    key({ key: 'S', ctrlKey: true, shiftKey: true });
    key({ key: 'm', metaKey: true, shiftKey: true });
    key({ key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.actions).toEqual(['stop', 'expand', 'stop', 'expand', 'close']);
    hooks.setView?.({ ...view, running: false, startedAt: null, canStart: false, task: null });
    expect(root.querySelector('#mini-time')?.textContent).toBe('0:00:00');
    expect((root.querySelector('#mini-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect(root.querySelector('#mini-hint')?.hasAttribute('hidden')).toBe(false);
    key({ key: 's', ctrlKey: true, shiftKey: true });
    hooks.setView?.({ ...view, running: false, startedAt: null, canStart: true });
    key({ key: 's', ctrlKey: true, shiftKey: true });
    hooks.setView?.({ ...view, busy: true });
    key({ key: 's', ctrlKey: true, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.actions.slice(5)).toEqual(['start']);
    now += 60_000;
    expect(clockText('2026-11-26T08:58:55Z', now)).toBe('1:02:05');
    expect(clockText(null, now)).toBe('0:00:00');
    mini.show(null);
    expect(root.querySelector('#mini-time')).toBeNull();
  });
});

describe('chat context memory (audit ZBZ-v-I3)', () => {
  it('does not remember a context whose switch failed for another reason than a 403', async () => {
    let failChat = false;
    const flaky = ((input: string, init?: RequestInit) => (failChat && input.includes('/api/chat/v1/conversations') ? Promise.reject(new Error('offline')) : nodeFetch(input, init))) as typeof fetch;
    const ui = mount(browserPlatform('0.1.0', flaky));
    await ui.app.init();
    const done = ui.app.connect(env.url);
    await until(() => ui.$('#user-code') !== null, 'the device code');
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
    await done;
    ui.$<HTMLButtonElement>('#tab-chat').click();
    ui.$<HTMLButtonElement>('#chat-connect').click();
    await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
    await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
    await until(() => ui.$('.side .conv') !== null, 'the conversations');
    await ui.shell.switchContext(ORG);
    expect(JSON.parse(localStorage.getItem('beacon-desktop-shell') ?? '{}').context).toBe(ORG);
    failChat = true;
    await ui.shell.switchContext(ORG2);
    // Shown (the list failed to load), but not remembered for the next launch.
    expect(ui.shell.context).toBe(ORG2);
    expect(JSON.parse(localStorage.getItem('beacon-desktop-shell') ?? '{}').context).toBe(ORG);
    failChat = false;
    // A context refused by the time API leaves the chat for Personal as well.
    await ui.shell.timeContextRefused(ORG2);
    await until(() => ui.shell.context === 'personal', 'the chat to leave the refused context');
    await ui.shell.timeContextRefused('personal');
  });
});
