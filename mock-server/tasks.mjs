/**
 * Mock of TaskBoard's client API v1 (`/api/task-board/v1`, TaskBoardBundle 3.4.1) for development and e2e: `tasks`
 * family tokens, `X-Beacon-Context` required, boards with typed columns, cards and details as the bundle presents them,
 * my-tasks buckets, `changes` with an opaque cursor, and the writes: quick create (`Idempotency-Key`), field changes,
 * moves and members with `If-Match` (`409 conflict {currentRevision}`, `428`), checklist items with the item's revision.
 * Sample data only; every person and project is fictional.
 *
 * Control (through the main server's /__mock/*): `tasks/state` (writes), `tasks/touch` (someone else changes a task),
 * config `tasksForbidden` (`403 module_forbidden`, TaskBoard 3.5), `tasksFailNext`, `tasksRefuseMove` (a transition
 * policy refusal), `tasksLogout` (`missing` = a server before TaskBoard 3.7.0 (404), `unavailable` = 409 with
 * `Retry-After`, `error` = 500; else 204).
 */
import { randomUUID } from 'node:crypto';

export const TASKS_PREFIX = '/api/task-board/v1';
export const TASKS_SCOPES = ['task-board:read', 'task-board:write'];

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ORG2 = 'org:7b1f2a9f-2c3d-4e4f-9a01-b2c3d4e5f6a7';
const CONTEXTS = [
  { key: 'personal', label: 'Personal' },
  { key: ORG, label: 'Lumen Works' },
  { key: ORG2, label: 'Harbor Studio' },
];

const PEOPLE = {
  me: { id: 'u-ada', name: 'Ada Lovelace', initials: 'AL', avatarUrl: null },
  maya: { id: 'u-maya', name: 'Maya Okafor', initials: 'MO', avatarUrl: null },
  leo: { id: 'u-leo', name: 'Leo Brandt', initials: 'LB', avatarUrl: null },
  sofia: { id: 'u-sofia', name: 'Sofía Marín', initials: 'SM', avatarUrl: null },
};

const COLUMNS = (prefix) => [
  { id: `${prefix}-todo`, name: 'To do', color: '#64748b', icon: '📝', type: 'open', humansOnly: false },
  { id: `${prefix}-doing`, name: 'In progress', color: '#d97706', icon: '🚧', type: 'custom', humansOnly: false },
  { id: `${prefix}-review`, name: 'Review', color: '#2563eb', icon: '👀', type: 'custom', humansOnly: true },
  { id: `${prefix}-done`, name: 'Done', color: '#16a34a', icon: '✅', type: 'done', humansOnly: false },
];

const KEY = /^[A-Za-z0-9_.:-]{1,255}$/;
const text = (value, marks) => ({ type: 'text', text: value, marks: marks ?? [] });
const doc = (...blocks) => ({ format: 'tokens/1', blocks });

function day(offset) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return new Date(date.getTime() + offset * 86_400_000).toISOString().replace('.000Z', 'Z');
}

function seed() {
  const boards = [
    { id: 'b-envelope', context: ORG, title: 'Envelope v2', icon: '✉️', group: { type: 'folder', id: 'f-eng', label: 'Engineering' }, columns: COLUMNS('env'), people: ['me', 'maya', 'leo', 'sofia'] },
    { id: 'b-website', context: ORG, title: 'Website relaunch', icon: '🌐', group: { type: 'folder', id: 'f-mkt', label: 'Marketing' }, columns: COLUMNS('web'), people: ['me', 'sofia'] },
    { id: 'b-harbor', context: ORG2, title: 'Studio ops', icon: null, group: null, columns: COLUMNS('hb'), people: ['me'] },
    { id: 'b-personal', context: 'personal', title: 'Personal', icon: null, group: null, columns: COLUMNS('pe'), people: ['me'] },
  ];
  let number = 140;
  const task = (board, column, title, extra = {}) => ({
    id: `t-${++number}`,
    number,
    boardId: board,
    columnId: column,
    title,
    priority: 'normal',
    color: null,
    tags: [],
    startAt: null,
    dueAt: null,
    allDay: true,
    assignees: [],
    reviewers: [],
    estimateMinutes: null,
    timeSpentMinutes: 0,
    archived: false,
    revision: 1,
    updatedAt: new Date().toISOString(),
    description: null,
    checklist: [],
    comments: [],
    subtasks: { total: 0, done: 0 },
    waitingForMe: false,
    ...extra,
  });
  const tasks = [
    task('b-envelope', 'env-todo', 'Streaming parser for envelopes', { priority: 'high', tags: ['parser', 'perf'], dueAt: day(0), assignees: ['me'], estimateMinutes: 240, timeSpentMinutes: 95, description: doc({ type: 'paragraph', tokens: [text('Parse the envelope header as a stream, keep the body '), text('lazy', ['bold']), text('.')] }, { type: 'list', ordered: false, checked: [true, false], items: [[text('Header tokenizer')], [text('Chunk boundaries')]] }), checklist: [{ id: 'ci-1', checklist: 'Release', title: 'Benchmarks green', done: true, revision: 2 }, { id: 'ci-2', checklist: 'Release', title: 'Docs updated', done: false, revision: 1 }], comments: [{ id: 'c-1', author: 'maya', body: doc({ type: 'paragraph', tokens: [text('The 4-byte case still fails on chunk boundaries.')] }), createdAt: new Date(Date.now() - 3_600_000).toISOString() }] }),
    task('b-envelope', 'env-todo', 'Benchmark guardrails in CI', { tags: ['ci'], dueAt: day(-2), assignees: ['me'], priority: 'urgent' }),
    task('b-envelope', 'env-todo', 'Retry header on 429 answers', { assignees: ['leo'], dueAt: day(3) }),
    task('b-envelope', 'env-doing', 'UTF-8 fixtures with 4-byte emoji', { assignees: ['me'], dueAt: day(1), tags: ['tests'], estimateMinutes: 90 }),
    task('b-envelope', 'env-doing', 'Rollback plan for the release', { assignees: ['sofia'], priority: 'low' }),
    task('b-envelope', 'env-review', 'Envelope v2 kick-off notes', { assignees: ['maya'], reviewers: ['me'], waitingForMe: true }),
    task('b-envelope', 'env-done', 'Header tokenizer', { assignees: ['me'], timeSpentMinutes: 180 }),
    task('b-website', 'web-todo', 'New hero images', { assignees: ['sofia'], dueAt: day(5) }),
    task('b-website', 'web-doing', 'Pricing page copy', { assignees: ['me'] }),
    task('b-harbor', 'hb-todo', 'Standup at 9:30', { assignees: ['me'], dueAt: day(0) }),
    task('b-personal', 'pe-todo', 'Dentist on Friday', { assignees: ['me'], dueAt: day(2) }),
  ];
  return { boards, tasks, changes: [], seq: 0, keys: new Map(), writes: [], logouts: [], number };
}

export function createTasksMock({ send, error }) {
  let data = seed();

  const board = (id) => data.boards.find((item) => item.id === id);
  const column = (b, id) => b.columns.find((item) => item.id === id);
  const person = (key) => PEOPLE[key] ?? Object.values(PEOPLE).find((item) => item.id === key) ?? null;

  const touch = (task) => {
    task.revision += 1;
    task.updatedAt = new Date().toISOString();
    data.seq += 1;
    data.changes.push({ seq: data.seq, taskId: task.id, boardId: task.boardId, revision: task.revision });
  };

  const card = (task) => {
    const b = board(task.boardId);
    const col = column(b, task.columnId);
    const done = task.checklist.filter((item) => item.done).length;
    return {
      id: task.id,
      number: task.number,
      title: task.title,
      boardId: task.boardId,
      column: col ? { id: col.id, name: col.name, icon: col.icon, type: col.type } : null,
      priority: task.priority,
      color: task.color,
      tags: task.tags,
      startAt: task.startAt,
      dueAt: task.dueAt,
      allDay: task.allDay,
      assignees: task.assignees.map(person).filter(Boolean),
      subtaskSummary: task.subtasks,
      checklistSummary: { total: task.checklist.length, done },
      openQuestions: task.waitingForMe ? 1 : 0,
      waitingForMe: task.waitingForMe,
      comments: task.comments.length,
      estimateMinutes: task.estimateMinutes,
      timeSpentMinutes: task.timeSpentMinutes,
      archived: task.archived,
      completed: col?.type === 'done' || col?.type === 'closed',
      revision: task.revision,
      updatedAt: task.updatedAt,
    };
  };

  const detail = (task) => {
    const lists = new Map();
    for (const item of task.checklist) {
      if (!lists.has(item.checklist)) lists.set(item.checklist, { name: item.checklist, items: [] });
      lists.get(item.checklist).items.push({ id: item.id, title: item.title, done: item.done, revision: item.revision });
    }
    return {
      task: {
        ...card(task),
        description: task.description,
        parent: null,
        members: [...task.assignees.map((key) => ({ user: person(key), role: 'assignee' })), ...task.reviewers.map((key) => ({ user: person(key), role: 'reviewer' }))].filter((item) => item.user !== null),
        checklists: [...lists.values()],
        links: [{ visible: true, type: 'url', title: 'Benchmark run 482', url: 'https://example.com/benchmarks/482' }, { visible: false }].slice(0, task.number === 141 ? 2 : 0),
        dependencies: [],
        questions: { open: task.waitingForMe ? 1 : 0, waitingForMe: task.waitingForMe },
        createdBy: PEOPLE.maya,
        updatedBy: PEOPLE.me,
        channel: 'web',
        createdAt: new Date(Date.now() - 86_400_000 * 3).toISOString(),
        permissions: { canEdit: true, canMove: true, canComment: false, canAssign: true, canAsk: false, canTrackTime: true },
        webUrl: null,
      },
    };
  };

  const presentBoard = (b, withDetail) => ({
    id: b.id,
    title: b.title,
    icon: b.icon,
    color: null,
    archived: false,
    group: b.group,
    columns: b.columns,
    permissions: { canCreate: true, canMove: true },
    ...(withDetail ? { counts: { open: data.tasks.filter((task) => task.boardId === b.id && column(b, task.columnId)?.type !== 'done').length, capped: false }, people: b.people.map(person), tags: ['parser', 'perf', 'ci', 'tests'], templates: [] } : {}),
  });

  const tokenOf = (req, state) => {
    const header = req.headers.authorization ?? '';
    const session = header.startsWith('Bearer ') ? state.tokens.get(header.slice(7).trim()) : undefined;
    return session && session.expiresAt >= Date.now() ? session : null;
  };

  const withTag = (res, status, task, headers, extra = {}) => send(res, status, { ...detail(task), ...extra }, { ...headers, ETag: `"${task.revision}"` });

  const ifMatch = (req, res, task) => {
    const value = req.headers['if-match'];
    if (value === undefined) {
      error(res, 428, 'precondition_required', 'If-Match required.');
      return false;
    }
    if (value !== '*' && value !== `"${task.revision}"`) {
      send(res, 409, { ok: false, error: 'conflict', currentRevision: task.revision });
      return false;
    }
    return true;
  };

  return {
    reset() {
      data = seed();
    },
    state: () => ({ writes: data.writes, changes: data.changes.length, logouts: data.logouts }),
    /** The time API's task list includes these (a timer starts on a task of the board). */
    timeTasks: () => data.tasks.map((task) => ({ id: task.id, title: task.title, boardId: task.boardId, boardTitle: board(task.boardId)?.title ?? '' })),
    /** Someone else changes a task (polling picks it up). */
    touch({ taskId, title }) {
      const task = data.tasks.find((item) => item.id === taskId) ?? data.tasks[0];
      if (title !== undefined) task.title = title;
      touch(task);
      return card(task);
    },
    handle(req, res, url, body, state) {
      // TaskBoard 3.7.0 (as ChatKit 2.4.1): revokes the presented tasks token; idempotent, 204 for a revoked, expired or
      // unknown token too, 401 only without a Bearer (audit BDA13-L2).
      if (req.method === 'POST' && url.pathname === `${TASKS_PREFIX}/logout`) {
        const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '').trim();
        const mode = state.config.tasksLogout ?? 'ok';
        data.logouts.push({ mode, known: state.tokens.get(presented)?.family === 'tasks' });
        if (mode === 'missing') return error(res, 404, 'not_found', 'Not found.');
        if (mode === 'unavailable') return send(res, 409, { ok: false, error: 'unavailable' }, { 'Retry-After': '30' });
        if (mode === 'error') return send(res, 500, { ok: false, error: 'server_error' });
        if (presented === '') return error(res, 401, 'invalid_token', 'Missing token.', { 'WWW-Authenticate': 'Bearer' });
        if (state.tokens.get(presented)?.family === 'tasks') state.tokens.delete(presented);
        res.writeHead(204).end();
        return;
      }
      const session = tokenOf(req, state);
      if (session === null) return error(res, 401, 'invalid_token', 'Missing or revoked token.', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      if (session.family !== 'tasks') return error(res, 401, 'invalid_token', 'A tasks token is required.', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      if (state.config.tasksForbidden) return error(res, 403, 'module_forbidden', 'Tasks are off for this account.');
      if (state.config.tasksFailNext) {
        const { status, error: code, retryAfter, ...extra } = state.config.tasksFailNext;
        state.config.tasksFailNext = null;
        return send(res, status, { ok: false, error: code, ...extra }, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
      }
      const context = req.headers['x-beacon-context'];
      if (context === undefined) return error(res, 400, 'context_required', 'Context required.');
      if (!CONTEXTS.some((item) => item.key === context) || (state.config.tasksRefuseContext ?? []).includes(context)) return error(res, 403, 'context_forbidden', 'Context forbidden.');
      const headers = { 'Cache-Control': 'no-store, private' };
      const route = url.pathname.slice(TASKS_PREFIX.length + 1);
      const write = req.method !== 'GET';
      if (write && !session.scopes.includes('task-board:write')) return error(res, 403, 'insufficient_scope', 'Needs task-board:write.');
      const inContext = (b) => b !== undefined && b.context === context;
      const visibleTask = (id) => {
        const task = data.tasks.find((item) => item.id === id);
        return task !== undefined && inContext(board(task.boardId)) && !task.archived ? task : null;
      };
      if (req.method === 'GET' && route === 'me') {
        return send(res, 200, { apiVersion: 1, user: PEOPLE.me, scopes: session.scopes, context: CONTEXTS.find((item) => item.key === context), contexts: CONTEXTS, features: { realtime: false, questions: false, timeTracking: true, taskNumbers: true, templates: false, subtaskDepth: 3, files: false, activity: false, serverLogout: true }, limits: { pageSize: 100, columnPageSize: 30, changes: 200, myTasksScan: 2000 }, enums: { priorities: ['low', 'normal', 'high', 'urgent'], memberRoles: ['assignee', 'reviewer', 'stakeholder', 'watcher'], columnTypes: ['open', 'custom', 'done', 'closed'] } }, headers);
      }
      if (req.method === 'GET' && route === 'my-tasks') {
        const bucket = url.searchParams.get('bucket') ?? 'all';
        const mine = data.tasks.filter((task) => inContext(board(task.boardId)) && !task.archived && column(board(task.boardId), task.columnId)?.type !== 'done');
        const rows = bucket === 'review' ? mine.filter((task) => task.reviewers.includes('me')) : mine.filter((task) => task.assignees.includes('me'));
        rows.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.number - b.number);
        return send(res, 200, { tasks: rows.map(card), nextCursor: null, counts: { overdue: 0, today: 0, upcoming: 0, review: mine.filter((task) => task.reviewers.includes('me')).length } }, headers);
      }
      if (req.method === 'GET' && route === 'boards') {
        return send(res, 200, { boards: data.boards.filter(inContext).map((b) => presentBoard(b, false)), nextCursor: null }, headers);
      }
      if (req.method === 'GET' && route === 'people') {
        const b = board(url.searchParams.get('board'));
        if (!inContext(b)) return error(res, 404, 'not_found', 'Not found.');
        return send(res, 200, { people: b.people.map(person) }, headers);
      }
      if (req.method === 'GET' && route === 'changes') {
        const since = url.searchParams.get('since');
        const from = since === null ? null : Number(Buffer.from(since, 'base64url').toString());
        const next = Buffer.from(String(data.seq)).toString('base64url');
        if (from === null || Number.isNaN(from)) return send(res, 200, { changes: [], nextCursor: next, reset: true }, headers);
        const rows = data.changes.filter((change) => change.seq > from && inContext(board(change.boardId))).map(({ taskId, boardId, revision }) => ({ taskId, boardId, revision }));
        return send(res, 200, { changes: rows, nextCursor: next, reset: false }, headers);
      }
      let match = /^boards\/([A-Za-z0-9_-]+)(\/tasks)?$/.exec(route);
      if (req.method === 'GET' && match) {
        const b = board(match[1]);
        if (!inContext(b)) return error(res, 404, 'not_found', 'Not found.');
        if (match[2] === undefined) return send(res, 200, { board: presentBoard(b, true) }, headers);
        let rows = data.tasks.filter((task) => task.boardId === b.id && !task.archived);
        const col = url.searchParams.get('column');
        if (col !== null) rows = rows.filter((task) => task.columnId === col);
        if (url.searchParams.get('assignee') === 'me') rows = rows.filter((task) => task.assignees.includes('me'));
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 30), 1), 100);
        const offset = Number(url.searchParams.get('cursor') ? Buffer.from(url.searchParams.get('cursor'), 'base64url').toString() : 0) || 0;
        const page = rows.slice(offset, offset + limit);
        return send(res, 200, { tasks: page.map(card), nextCursor: offset + limit < rows.length ? Buffer.from(String(offset + limit)).toString('base64url') : null }, headers);
      }
      if (req.method === 'POST' && route === 'tasks') {
        const key = req.headers['idempotency-key'];
        if (key === undefined || !KEY.test(key)) return error(res, 400, 'invalid_field', 'Idempotency-Key required.');
        const stored = data.keys.get(`${session.userId}|${key}`);
        if (stored !== undefined) return withTag(res, 201, stored, { ...headers, 'Idempotency-Replayed': 'true' });
        const b = board(body.boardId);
        if (!inContext(b)) return error(res, 404, 'not_found', 'Not found.');
        if (typeof body.title !== 'string' || body.title.trim() === '') return send(res, 400, { ok: false, error: 'invalid_field', field: 'title' });
        data.number += 1;
        const task = { id: `t-${data.number}`, number: data.number, boardId: b.id, columnId: body.columnId ?? b.columns[0].id, title: body.title.trim(), priority: body.priority ?? 'normal', color: null, tags: body.tags ?? [], startAt: null, dueAt: body.dueAt ?? null, allDay: body.allDay ?? true, assignees: (body.assignees ?? []).map((who) => (who === 'me' ? 'me' : who)), reviewers: [], estimateMinutes: body.estimateMinutes ?? null, timeSpentMinutes: 0, archived: false, revision: 0, updatedAt: '', description: null, checklist: [], comments: [], subtasks: { total: 0, done: 0 }, waitingForMe: false };
        data.tasks.push(task);
        touch(task);
        data.keys.set(`${session.userId}|${key}`, task);
        data.writes.push({ kind: 'create', key, taskId: task.id });
        return withTag(res, 201, task, headers);
      }
      match = /^tasks\/([A-Za-z0-9_-]+)(?:\/(move|comments|members|checklist-items)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(route);
      if (!match) return error(res, 404, 'not_found', 'Not found.');
      const task = visibleTask(match[1]);
      if (task === null) return error(res, 404, 'not_found', 'Not found.');
      const b = board(task.boardId);
      if (req.method === 'GET' && match[2] === undefined) return withTag(res, 200, task, headers);
      if (req.method === 'GET' && match[2] === 'comments') {
        return send(res, 200, { comments: task.comments.map((comment) => ({ id: comment.id, author: person(comment.author), body: comment.body, createdAt: comment.createdAt, editedAt: null, canEdit: false })), nextCursor: null }, headers);
      }
      if (req.method === 'PATCH' && match[2] === undefined) {
        if (!ifMatch(req, res, task)) return;
        const allowed = ['title', 'description', 'priority', 'color', 'tags', 'dueAt', 'startAt', 'allDay', 'estimateMinutes', 'archived'];
        const unknown = Object.keys(body).find((field) => !allowed.includes(field));
        if (unknown !== undefined) return send(res, 400, { ok: false, error: 'invalid_field', field: unknown });
        Object.assign(task, body);
        touch(task);
        data.writes.push({ kind: 'patch', taskId: task.id, fields: Object.keys(body), ifMatch: req.headers['if-match'] });
        return withTag(res, 200, task, headers);
      }
      if (req.method === 'POST' && match[2] === 'move') {
        const target = column(b, body.columnId);
        if (target === undefined) return send(res, 400, { ok: false, error: 'invalid_field', field: 'columnId' });
        if (target.id !== task.columnId && req.headers['if-match'] === '*') return error(res, 428, 'precondition_required', 'A column change needs the revision.');
        if (!ifMatch(req, res, task)) return;
        if (state.config.tasksRefuseMove) return send(res, 403, { ok: false, error: 'transition_refused', policyCode: 'WIP_LIMIT', message: 'Review takes at most 3 tasks.' });
        task.columnId = target.id;
        touch(task);
        data.writes.push({ kind: 'move', taskId: task.id, columnId: target.id, ifMatch: req.headers['if-match'] });
        return withTag(res, 200, task, headers);
      }
      if ((req.method === 'PUT' || req.method === 'DELETE') && match[2] === 'members' && match[3] !== undefined) {
        if (!ifMatch(req, res, task)) return;
        const who = match[3] === 'me' ? 'me' : (Object.keys(PEOPLE).find((key) => PEOPLE[key].id === match[3]) ?? null);
        if (who === null) return error(res, 404, 'not_found', 'Not found.');
        if (req.method === 'DELETE') {
          task.assignees = task.assignees.filter((key) => key !== who);
          task.reviewers = task.reviewers.filter((key) => key !== who);
        } else if (body.role === 'assignee' && !task.assignees.includes(who)) task.assignees.push(who);
        else if (body.role === 'reviewer' && !task.reviewers.includes(who)) task.reviewers.push(who);
        touch(task);
        data.writes.push({ kind: 'member', method: req.method, taskId: task.id, who });
        return withTag(res, 200, task, headers);
      }
      if (req.method === 'POST' && match[2] === 'checklist-items' && match[3] === undefined) {
        const key = req.headers['idempotency-key'];
        if (key === undefined || !KEY.test(key)) return error(res, 400, 'invalid_field', 'Idempotency-Key required.');
        if (typeof body.title !== 'string' || body.title.trim() === '' || typeof body.checklist !== 'string') return send(res, 400, { ok: false, error: 'invalid_field', field: 'title' });
        const item = { id: `ci-${randomUUID().slice(0, 8)}`, checklist: body.checklist, title: body.title.trim(), done: false, revision: 1 };
        task.checklist.push(item);
        touch(task);
        data.writes.push({ kind: 'checklist-add', taskId: task.id, key });
        return withTag(res, 201, task, headers, { itemId: item.id });
      }
      if (req.method === 'PATCH' && match[2] === 'checklist-items' && match[3] !== undefined) {
        const item = task.checklist.find((entry) => entry.id === match[3]);
        if (item === undefined) return error(res, 404, 'not_found', 'Not found.');
        const value = req.headers['if-match'];
        if (value === undefined) return error(res, 428, 'precondition_required', 'If-Match required.');
        if (value !== `"${item.revision}"`) return send(res, 409, { ok: false, error: 'conflict', currentRevision: item.revision });
        if (typeof body.done === 'boolean') item.done = body.done;
        if (typeof body.title === 'string') item.title = body.title;
        item.revision += 1;
        touch(task);
        data.writes.push({ kind: 'checklist-tick', taskId: task.id, itemId: item.id, done: item.done });
        return withTag(res, 200, task, headers, { itemId: item.id, itemRevision: item.revision });
      }
      return error(res, 404, 'not_found', 'Not found.');
    },
  };
}
