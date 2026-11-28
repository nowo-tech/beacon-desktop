// The TaskBoard client API v1 (BD-3b) against the mock TaskBoard (mock-server/tasks.mjs): the chained `tasks` device
// flow, reads, writes with If-Match and Idempotency-Key, refusals; the parsers on malformed input; the pure helpers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, TimeTrackApi } from '../../src/api/client';
import { isModuleForbidden, TasksApi, TasksApiError } from '../../src/tasks/api';
import { apiToDateInput, dateInputToApi, dayAfter, dayDiff, daysToNextWeek, dueInfo, duration, groupMine, localDate, parseDuration, parseQuickAdd, priorityLabel, taskRef } from '../../src/tasks/format';
import { tasksText } from '../../src/tasks/i18n';
import { parseBoard, parseCard, parseChanges, parseColumn, parseComments, parseDetail, parseMe, parsePerson, parseTaskPage, parseText, type TaskCard } from '../../src/tasks/types';
import { runDeviceFlow } from '../../src/lib/deviceFlow';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const t = tasksText('en');

async function tasksToken(): Promise<{ token: string; body: Record<string, unknown> }> {
  const timeApi = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', fetchImpl: nodeFetch });
  const time = (await runDeviceFlow(timeApi, { clientName: 'test', sleep, onCode: async (code) => void (await env.control('device/approve', { userCode: code.userCode })) })).token;
  const api = new TimeTrackApi({ baseUrl: env.url, source: 'desktop', token: time, fetchImpl: nodeFetch });
  const result = await runDeviceFlow(
    { deviceCode: (name) => api.tasksDeviceCode(name), deviceToken: (code) => api.deviceToken(code) },
    { clientName: 'Beacon Desktop', sleep, onCode: async (code) => void (await env.control('device/approve', { userCode: code.userCode })) },
  );
  const state = (await env.control('state')) as { requests: { path: string; body: string }[] };
  return { token: result.token, body: JSON.parse(state.requests.filter((item) => item.path.endsWith('device/code')).at(-1)?.body ?? '{}') };
}

describe('TaskBoard client API v1 (mock)', () => {
  let api: TasksApi;
  beforeAll(async () => {
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
    const connected = await tasksToken();
    expect(connected.body).toMatchObject({ family: 'tasks', scopes: ['task-board:read', 'task-board:write'] });
    api = new TasksApi({ baseUrl: env.url, token: connected.token, context: ORG, fetchImpl: nodeFetch });
  });

  it('reads me, boards, a board, its columns, my tasks, a task, comments, people and changes', async () => {
    const me = await api.me();
    expect(me.scopes).toContain('task-board:write');
    expect(me.contexts.map((item) => item.label)).toEqual(['Personal', 'Lumen Works', 'Harbor Studio']);
    expect(me.limits.columnPageSize).toBe(30);
    const { boards } = await api.boards();
    expect(boards.map((item) => item.title)).toEqual(['Envelope v2', 'Website relaunch']);
    const board = await api.board('b-envelope');
    expect(board?.columns.map((column) => column.icon)).toEqual(['📝', '🚧', '👀', '✅']);
    expect(board?.people.map((person) => person.name)).toContain('Maya Okafor');
    expect(board?.counts?.open).toBeGreaterThan(0);
    const todo = await api.boardTasks('b-envelope', { column: 'env-todo', limit: 2 });
    expect(todo.tasks).toHaveLength(2);
    expect(todo.nextCursor).not.toBeNull();
    const rest = await api.boardTasks('b-envelope', { column: 'env-todo', cursor: todo.nextCursor });
    expect(rest.tasks).toHaveLength(1);
    expect((await api.boardTasks('b-envelope', { assignee: 'me' })).tasks.every((task) => task.assignees.some((person) => person.id === 'u-ada'))).toBe(true);
    const mine = await api.myTasks('all', localDate(new Date()));
    expect(mine.tasks.length).toBeGreaterThan(2);
    expect((await api.myTasks('review', localDate(new Date()))).tasks.map((task) => task.title)).toEqual(['Envelope v2 kick-off notes']);
    const detail = await api.task('t-141');
    expect(detail?.checklists[0].items.map((item) => item.title)).toEqual(['Benchmarks green', 'Docs updated']);
    expect(detail?.description?.[0]).toMatchObject({ type: 'paragraph' });
    expect(detail?.links).toHaveLength(2);
    expect(detail?.links[1]).toEqual({ visible: false });
    expect((await api.comments('t-141'))[0].author?.name).toBe('Maya Okafor');
    expect((await api.people('b-envelope')).length).toBe(4);
    const first = await api.changes(null);
    expect(first.reset).toBe(true);
    await env.control('tasks/touch', { taskId: 't-142', title: 'Benchmark guardrails in CI (renamed)' });
    const next = await api.changes(first.nextCursor);
    expect(next.changes).toEqual([{ taskId: 't-142', boardId: 'b-envelope', revision: 2 }]);
    await expect(api.task('../etc')).rejects.toMatchObject({ code: 'invalid_id' });
    await expect(api.task('t-150')).rejects.toMatchObject({ status: 404 }); // another context's task
  });

  it('writes with If-Match (409 conflict, 428 without) and Idempotency-Key; a policy refusal carries its message', async () => {
    const task = (await api.task('t-143')) as NonNullable<Awaited<ReturnType<TasksApi['task']>>>;
    const moved = await api.move(task.id, { columnId: 'env-doing' }, task.revision);
    expect(moved.column?.id).toBe('env-doing');
    expect(moved.revision).toBe(task.revision + 1);
    const stale = api.move(task.id, { columnId: 'env-review' }, task.revision);
    await expect(stale).rejects.toBeInstanceOf(TasksApiError);
    await expect(api.move(task.id, { columnId: 'env-review' }, task.revision)).rejects.toMatchObject({ status: 409, code: 'conflict', details: { currentRevision: moved.revision } });
    await expect(api.move(task.id, { columnId: 'env-todo' }, '*')).rejects.toMatchObject({ status: 428 });
    await env.control('config', { tasksRefuseMove: true });
    await expect(api.move(task.id, { columnId: 'env-review' }, moved.revision)).rejects.toMatchObject({ code: 'transition_refused', details: { policyCode: 'WIP_LIMIT', policyMessage: 'Review takes at most 3 tasks.' } });
    await env.control('config', { tasksRefuseMove: false });
    const patched = await api.patch(task.id, { priority: 'urgent', tags: ['api'], dueAt: '2026-12-01T00:00:00Z', allDay: true, estimateMinutes: 30 }, moved.revision);
    expect(patched).toMatchObject({ priority: 'urgent', tags: ['api'], estimateMinutes: 30 });
    const assigned = await api.member(task.id, 'me', 'assignee', patched.revision);
    expect(assigned.assignees.map((person) => person.id)).toContain('u-ada');
    const unassigned = await api.member(task.id, 'u-ada', 'assignee', assigned.revision, true);
    expect(unassigned.assignees.map((person) => person.id)).not.toContain('u-ada');
    const withItem = await api.addChecklistItem(task.id, 'Release', 'Changelog');
    const item = withItem.checklists[0].items[0];
    const ticked = await api.patchChecklistItem(task.id, item.id, { done: true }, item.revision);
    expect(ticked.checklists[0].items[0].done).toBe(true);
    await expect(api.patchChecklistItem(task.id, item.id, { done: false }, item.revision)).rejects.toMatchObject({ status: 409 });
    // Quick create: a retry with the same key creates one task.
    const created = await api.create({ boardId: 'b-envelope', title: 'From the desktop', assignees: ['me'] }, 'key-1');
    const again = await api.create({ boardId: 'b-envelope', title: 'From the desktop', assignees: ['me'] }, 'key-1');
    expect(again.id).toBe(created.id);
    const writes = (await env.control('tasks/state')) as { writes: { kind: string; ifMatch?: string }[] };
    expect(writes.writes.filter((write) => write.kind === 'create')).toHaveLength(1);
    expect(writes.writes.find((write) => write.kind === 'move')?.ifMatch).toBe(`"${task.revision}"`);
    await expect(api.move(task.id, { columnId: '../x' }, 1)).rejects.toMatchObject({ code: 'invalid_id' });
  });

  it('refusals: module_forbidden keeps the token, read-only scope, context, errors', async () => {
    await env.control('config', { tasksForbidden: true });
    const forbidden = await api.me().catch((error: unknown) => error);
    expect(isModuleForbidden(forbidden)).toBe(true);
    await env.control('config', { tasksForbidden: false });
    expect(isModuleForbidden(new ApiError(403, 'forbidden', 'x'))).toBe(false);
    const other = new TasksApi({ baseUrl: env.url, token: (await api.me()).user === null ? null : 'nope', context: 'org:unknown', fetchImpl: nodeFetch });
    await expect(other.me()).rejects.toMatchObject({ status: 401 });
    api.setContext('org:00000000-0000-4000-8000-000000000000');
    expect(api.currentContext).toBe('org:00000000-0000-4000-8000-000000000000');
    await expect(api.me()).rejects.toMatchObject({ status: 403, code: 'context_forbidden' });
    api.setContext('bad key!');
    expect(api.currentContext).toBeNull();
    await expect(api.me()).rejects.toMatchObject({ status: 400, code: 'context_required' });
    api.setContext(ORG);
    await env.control('config', { tasksFailNext: { status: 429, error: 'rate_limited', retryAfter: 7 } });
    await expect(api.me()).rejects.toMatchObject({ status: 429, retryAfter: 7 });
    await expect(new TasksApi({ baseUrl: env.url, token: null, context: null }).me()).rejects.toMatchObject({ status: 401 });
    const broken = new TasksApi({ baseUrl: 'https://beacon.example', token: 'x', context: ORG, fetchImpl: async () => new Response('not json', { status: 200 }) });
    await expect(broken.me()).rejects.toMatchObject({ code: 'invalid_response' });
    const down = new TasksApi({ baseUrl: 'https://beacon.example', token: 'x', context: ORG, fetchImpl: async () => Promise.reject(new Error('offline')) });
    await expect(down.me()).rejects.toMatchObject({ code: 'network_error' });
    const odd = new TasksApi({ baseUrl: 'https://beacon.example', token: 'x', context: ORG, fetchImpl: async () => new Response('{"error":"Not A Code"}', { status: 500 }) });
    await expect(odd.me()).rejects.toMatchObject({ code: 'server_error' });
    const empty = new TasksApi({ baseUrl: 'https://beacon.example', token: 'x', context: ORG, fetchImpl: async () => new Response('{}', { status: 200 }) });
    await expect(empty.patch('t-1', {}, 1)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await empty.board('b-1')).toBeNull();
    expect(await empty.people('b-1')).toEqual([]);
    expect((await empty.boards()).boards).toEqual([]);
  });
});

describe('TaskBoard parsers', () => {
  const origin = 'https://beacon.example';
  it('drop what is malformed and keep safe defaults', () => {
    expect(parsePerson({ id: '../x', name: 'A' })).toBeNull();
    expect(parsePerson({ id: 'u1', name: '  ' })).toEqual({ id: 'u1', name: '?', initials: '?' });
    expect(parsePerson({ id: 'u1', name: 'Ada Lovelace' })?.initials).toBe('AL');
    expect(parseMe(null)).toMatchObject({ user: null, scopes: [], contexts: [], limits: { pageSize: 100, columnPageSize: 30, changes: 200 } });
    expect(parseMe({ context: { key: 'bad key' }, contexts: [{ key: 'personal' }, 3] }).contexts).toEqual([{ key: 'personal', label: 'personal' }]);
    expect(parseColumn({ id: 'c1', color: 'red; x', icon: 'toolong', type: 'weird' })).toEqual({ id: 'c1', name: '…', color: null, icon: null, type: 'open' });
    expect(parseColumn({ id: 'c1', color: '#AbC', icon: '✅', type: 'done' })).toMatchObject({ color: '#AbC', icon: '✅', type: 'done' });
    expect(parseBoard({ id: 'b1', group: { type: 'folder', id: 'f', label: 'F' }, columns: [{ id: 'c' }, null], permissions: { canCreate: true }, counts: { open: 3, capped: true } })).toMatchObject({ group: { type: 'folder' }, columns: [{ id: 'c' }], canCreate: true, canMove: false, counts: { open: 3, capped: true } });
    expect(parseBoard({ id: 'b1', group: { type: 'weird' } })?.group).toBeNull();
    expect(parseBoard({})).toBeNull();
    expect(parseCard({ id: 't1' })).toBeNull();
    const card = parseCard({ id: 't1', boardId: 'b1', priority: 'odd', column: { id: 'c1', type: 'x' }, subtaskSummary: { total: 2, done: 1 }, tags: ['a', 3, ' '] }) as TaskCard;
    expect(card).toMatchObject({ priority: 'normal', column: { type: 'open' }, subtasks: { total: 2, done: 1 }, checklist: { total: 0, done: 0 }, tags: ['a'] });
    const text = parseText({ format: 'tokens/1', truncated: true, blocks: [{ type: 'heading', tokens: [{ type: 'text', text: 'H' }] }, { type: 'rule' }, { type: 'list', ordered: false, checked: [true, false, null], items: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }], [{ type: 'text', text: 'c' }]] }, { type: 'code', text: 'x' }, { type: 'quote', tokens: [{ type: 'image', visible: true, fileId: 'f' }, { type: 'reference', visible: true, refType: 'issue', id: '7', title: 'Bug', url: '/issues/7' }, { type: 'reference', visible: false, text: 'Content not visible' }] }, 4] }, origin, 'Image');
    expect(text.truncated).toBe(true);
    expect(text.blocks?.[0]).toEqual({ type: 'paragraph', tokens: [{ type: 'text', text: 'H', marks: ['bold'] }] });
    expect(text.blocks?.[1]).toMatchObject({ type: 'list', items: [[{ text: '☑ ' }, { text: 'a' }], [{ text: '☐ ' }, { text: 'b' }], [{ text: 'c' }]] });
    expect(text.blocks?.[3]).toMatchObject({ type: 'quote', tokens: [{ type: 'reference', visible: false, text: 'Image' }, { type: 'reference', visible: true, url: 'https://beacon.example/issues/7' }, { type: 'reference', visible: false }] });
    expect(parseText(null, origin, 'Image')).toEqual({ blocks: null, truncated: false });
    const detail = parseDetail({ task: { id: 't1', boardId: 'b1', parent: { visible: true, id: 'p1', number: 4, title: 'Parent' }, members: [{ user: { id: 'u1', name: 'A' }, role: 'chief' }, { user: null }], checklists: [{ name: '', items: [{ id: 'i1', title: 'x', done: true, revision: 3 }, { id: '../' }] }], links: [{ visible: true, url: 'javascript:alert(1)', title: 'bad' }, { visible: false, title: 'secret' }], webUrl: 'https://evil.example/x', permissions: { canEdit: true } } }, origin, 'Image');
    expect(detail).toMatchObject({ parent: { visible: true, id: 'p1' }, members: [{ role: 'watcher' }], checklists: [{ name: '…', items: [{ id: 'i1', revision: 3 }] }], links: [{ visible: true, url: null }, { visible: false }], webUrl: null, permissions: { canEdit: true, canMove: false } });
    expect(parseDetail({ id: 't1', boardId: 'b1', parent: { visible: false, id: 'leak' }, webUrl: '/dashboard/tasks/t1' }, origin, 'Image')).toMatchObject({ parent: { visible: false }, webUrl: 'https://beacon.example/dashboard/tasks/t1' });
    expect(parseDetail({}, origin, 'Image')).toBeNull();
    expect(parseTaskPage({ tasks: [{ id: 't1', boardId: 'b1' }, {}], nextCursor: '', counts: { overdue: 1 } })).toMatchObject({ tasks: [{ id: 't1' }], nextCursor: null, counts: { overdue: 1, today: 0 } });
    expect(parseChanges({ changes: [{ taskId: 't1', boardId: 'b1', revision: 2 }, { taskId: '../', boardId: 'b' }], reset: true })).toEqual({ changes: [{ taskId: 't1', boardId: 'b1', revision: 2 }], nextCursor: null, reset: true });
    expect(parseComments({ comments: [{ id: 'c1', author: null, body: null }, { id: 3 }] }, origin, 'Image')).toEqual([{ id: 'c1', author: null, body: null, createdAt: '' }]);
  });
});

describe('tasks helpers', () => {
  it('dates, due labels and My tasks groups follow the local date', () => {
    expect(localDate(new Date(2026, 10, 27, 23, 30))).toBe('2026-11-27');
    expect(dayDiff('2026-11-26T00:00:00Z', '2026-11-27', true)).toBe(-1);
    expect(dayDiff('nope', '2026-11-27', true)).toBeNull();
    expect(dueInfo({ dueAt: '2026-11-27T00:00:00Z', allDay: true }, '2026-11-27', t, 'en')).toEqual({ label: 'Today', tone: 'today', diff: 0 });
    expect(dueInfo({ dueAt: '2026-11-28T00:00:00Z', allDay: true }, '2026-11-27', t, 'en')?.label).toBe('Tomorrow');
    expect(dueInfo({ dueAt: '2026-11-26T00:00:00Z', allDay: true }, '2026-11-27', t, 'en')).toMatchObject({ label: 'Yesterday', tone: 'over' });
    expect(dueInfo({ dueAt: '2026-12-05T00:00:00Z', allDay: true }, '2026-11-27', t, 'en')?.label).toBe('Dec 5');
    expect(dueInfo({ dueAt: '2026-12-05T10:00:00Z', allDay: false }, '2026-11-27', t, 'en')?.tone).toBe('');
    expect(dueInfo({ dueAt: null, allDay: true }, '2026-11-27', t, 'en')).toBeNull();
    expect(dueInfo({ dueAt: 'x', allDay: true }, '2026-11-27', t, 'en')).toBeNull();
    const card = (id: string, dueAt: string | null) => ({ id, dueAt, allDay: true }) as TaskCard;
    const groups = groupMine([card('a', '2026-11-20T00:00:00Z'), card('b', '2026-11-27T00:00:00Z'), card('c', '2026-12-01T00:00:00Z'), card('d', null)], '2026-11-27');
    expect(Object.values(groups).map((items: TaskCard[]) => items.map((item) => item.id))).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(dateInputToApi('2026-12-01')).toBe('2026-12-01T00:00:00Z');
    expect(dateInputToApi('')).toBeNull();
    expect(apiToDateInput({ dueAt: '2026-12-01T00:00:00Z', allDay: true })).toBe('2026-12-01');
    expect(apiToDateInput({ dueAt: null, allDay: true })).toBe('');
    expect(apiToDateInput({ dueAt: '2026-12-01T10:00:00Z', allDay: false })).toMatch(/^2026-12-01$/);
  });

  it('parses the quick-add syntax', () => {
    expect(parseQuickAdd('Fix retry header !high #api #API @tomorrow ~2h', '2026-11-27')).toEqual({ title: 'Fix retry header', priority: 'high', tags: ['api'], dueAt: '2026-11-28T00:00:00Z', estimateMinutes: 120 });
    expect(parseQuickAdd('Call @today ~45m !LOW', '2026-11-27')).toEqual({ title: 'Call', priority: 'low', tags: [], dueAt: '2026-11-27T00:00:00Z', estimateMinutes: 45 });
    expect(parseQuickAdd('Email bob@example.com about #1', '2026-11-27')).toMatchObject({ title: 'Email bob@example.com about', tags: ['1'] });
    expect(parseQuickAdd('   ', '2026-11-27').title).toBe('');
  });

  it('accepts the Spanish quick-add words in both locales (UXA-18)', () => {
    expect(parseQuickAdd('Preparar demo !alta #demo @mañana ~1h30', '2026-11-27')).toEqual({ title: 'Preparar demo', priority: 'high', tags: ['demo'], dueAt: '2026-11-28T00:00:00Z', estimateMinutes: 90 });
    expect(parseQuickAdd('Llamar @hoy !URGENTE', '2026-11-27')).toMatchObject({ title: 'Llamar', priority: 'urgent', dueAt: '2026-11-27T00:00:00Z' });
    expect(parseQuickAdd('Revisar !baja @manana', '2026-11-30')).toMatchObject({ title: 'Revisar', priority: 'low', dueAt: '2026-12-01T00:00:00Z' });
    expect(parseQuickAdd('Plan !normal', '2026-11-27').priority).toBe('normal');
    // Unknown words, units-less estimates and e-mail addresses stay in the title.
    expect(parseQuickAdd('Ship it !soon @someday ~5 people', '2026-11-27')).toEqual({ title: 'Ship it !soon @someday ~5 people', priority: null, tags: [], dueAt: null, estimateMinutes: null });
    expect(parseQuickAdd('Fix it ~0h', '2026-11-27')).toMatchObject({ title: 'Fix it ~0h', estimateMinutes: null });
  });

  it('parses durations as people type them (UXA-17)', () => {
    const cases: [string, number | null][] = [
      ['4h', 240], ['4 h', 240], ['90m', 90], ['90 min', 90], ['1h30', 90], ['1h 30m', 90], ['1 h 30 min', 90], ['1.5h', 90], ['1,5 h', 90], ['1:30', 90], ['240', 240], ['0', 0], ['45 MIN', 45],
      ['', null], ['soon', null], ['1.5h30', null], ['h', null], ['1:75', null], ['-2h', null], ['2d', null], ['100001', null], ['99999h', null],
    ];
    for (const [text, minutes] of cases) expect([text, parseDuration(text)]).toEqual([text, minutes]);
    // What the field shows parses back to the same minutes.
    for (const minutes of [5, 45, 60, 95, 240, 1500]) expect(parseDuration(duration(minutes))).toBe(minutes);
  });

  it('due date shortcuts: a day from today, next week is next Monday', () => {
    expect(dayAfter('2026-11-27', 0)).toBe('2026-11-27T00:00:00Z');
    expect(dayAfter('2026-12-31', 1)).toBe('2027-01-01T00:00:00Z');
    // 2026-11-27 is a Friday, 2026-11-30 a Monday, 2026-11-29 a Sunday.
    expect(daysToNextWeek('2026-11-27')).toBe(3);
    expect(daysToNextWeek('2026-11-30')).toBe(7);
    expect(daysToNextWeek('2026-11-29')).toBe(1);
  });

  it('labels', () => {
    expect(taskRef({ number: 12, id: 'abcdef12' })).toBe('#12');
    expect(taskRef({ number: null, id: 'abcdef12' })).toBe('abcdef');
    expect(['urgent', 'high', 'normal', 'low'].map((priority) => priorityLabel(priority as 'low', t))).toEqual(['Urgent', 'High', 'Normal', 'Low']);
    expect(duration(45)).toBe('45 min');
    expect(duration(120)).toBe('2 h');
    expect(duration(95)).toBe('1 h 35 min');
    expect(tasksText('es')('moved', { task: '#1', column: 'Hecho' })).toBe('#1 movida a Hecho');
  });
});
