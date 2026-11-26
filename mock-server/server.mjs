#!/usr/bin/env node
/**
 * Mock of the TimeTrackBundle 1.10.0 client API, contract v0.3 (docs/CLIENT-API.md of nowo-tech/TimeTrackBundle), plus
 * Beacon's desktop updater route and the 1.14 meetings route (`POST /__mock/config {"meetings": {...}}`, contract §22). `POST /__mock/config {"apiVersion": "1.9"}` turns it into a 1.9 server (no `features`
 * / `limits`, `startedAt` / `endedAt` ignored, no `reassign`). Zero dependencies. Used by the unit / e2e tests and for local development:
 *
 *   node mock-server/server.mjs            # http://127.0.0.1:8787
 *   PORT=9000 node mock-server/server.mjs
 *
 * Demo account: ada@example.com / app-password-123
 *
 * Test-only control endpoints live under /__mock/* (reset, config, state, device approval).
 * The server keeps a log of every request path, query and body so tests can assert that
 * the clients never send URLs, window titles or idle state.
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CHAT_PREFIX, CHAT_SCOPES, createChatMock } from './chat.mjs';

const PREFIX = '/api/time-track';
const ALL_SCOPES = ['timer:read', 'timer:write', 'tasks:read', 'entries:read'];
/** TimeTrack 1.14 (contract §22.7): explicit grant only, refused as unknown by a server with `meetingsScope: false`. */
const MEETINGS_SCOPE = 'meetings:read';
const MEETING_PARAMS = new Set(['from', 'to', 'tz', 'limit']);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const SOURCES = new Set(['extension', 'desktop', 'web']);
const IDLE_ACTIONS = new Set(['keep', 'discard', 'split', 'reassign']);
const IDLE_THEN = new Set(['continue', 'stop', 'switch']);
const CLOCK_SKEW_SECONDS = 120;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

/** Tenant contexts (the same keys as the chat mock): TimeTrackBundle 2.2 `client_api.context` (BD-3a). */
const TIME_CONTEXTS = [
  { key: 'personal', label: 'Personal' },
  { key: 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6', label: 'Lumen Works' },
  { key: 'org:7b1f2a9f-2c3d-4e4f-9a01-b2c3d4e5f6a7', label: 'Harbor Studio' },
];
/** TimeTrackBundle 2.1 activity types and subjects of the demo (spec 256), used when `config.allocation` is set. */
const ACTIVITY_TYPES = [
  { key: 'dev', label: 'Development', group: 'Delivery' },
  { key: 'review', label: 'Code review', group: 'Delivery' },
  { key: 'meeting', label: 'Meeting', group: 'Coordination' },
  { key: 'support', label: 'Customer support', group: 'Coordination' },
];
const SUBJECTS = [
  { type: 'customer', id: '42', label: 'Fernhill Retail', hint: 'Bristol' },
  { type: 'customer', id: '43', label: 'Orbita Logistics', hint: 'Valencia' },
  { type: 'customer', id: '44', label: 'Acme Corporation', hint: 'Austin' },
];

const USERS = [
  { id: 1, email: 'ada@example.com', password: 'app-password-123', displayName: 'Ada Lovelace' },
  // A second account for "another person signs in on this computer" (device/approve {"userId": 2}).
  { id: 2, email: 'grace@example.com', password: 'app-password-456', displayName: 'Grace Hopper' },
];

const TASKS = [
  { id: 'T-101', title: 'Write onboarding guide', boardId: 'docs', boardTitle: 'Documentation' },
  { id: 'T-102', title: 'Review pull request queue', boardId: 'eng', boardTitle: 'Engineering' },
  { id: 'T-103', title: 'Customer call: Acme quarterly review', boardId: 'sales', boardTitle: 'Sales' },
  { id: 'T-104', title: 'Fix invoice rounding bug', boardId: 'eng', boardTitle: 'Engineering' },
  { id: 'T-105', title: 'Plan sprint 42', boardId: 'eng', boardTitle: 'Engineering' },
  { id: 'T-106', title: 'Translate help center to Spanish', boardId: 'docs', boardTitle: 'Documentation' },
  { id: 'T-107', title: 'Update privacy notice', boardId: 'legal', boardTitle: 'Legal' },
  { id: 'T-108', title: 'Design system audit', boardId: 'design', boardTitle: 'Design' },
];

// T-900 exists on a real server but the demo user may not track it: like a missing task it answers 403 task_forbidden.

function freshState() {
  return {
    tokens: new Map(),
    timers: new Map(),
    entries: new Map(),
    devices: new Map(),
    idleDecisions: [],
    requests: [],
    config: {
      workingHours: null,
      // `GET me.daysOff` as proposed for TimeTrackBundle ([{date, kind: 'holiday' | 'vacation', label?}]); null = absent.
      daysOff: null,
      // `GET me.locale` (TimeTrackBundle 1.11); null = absent.
      locale: null,
      deviceInterval: 5,
      tokenScopes: [...ALL_SCOPES],
      failNext: null,
      latencyMs: 0,
      // Beacon updater answer: null = 204 (up to date), else {version, notes, pub_date, url, signature, min_supported_version?}.
      update: null,
      // Oldest supported client version: `minSupportedVersion` on GET me, `X-Min-Supported-Version` on the updater.
      minSupportedVersion: null,
      // Overrides the verification URI returned by device/code (tests of the desktop's same-host check).
      verificationUri: null,
      // `url` per task id on `tasks` and on timers started afterwards (Beacon's TaskProvider bridge); null = omitted,
      // as in TimeTrackBundle 1.9.x. Tests use it for the clients' same-origin check of "Open in Beacon".
      taskUrls: null,
      // Extra context per task id on `tasks` and timers (e.g. {projectTitle}), as proposed for Beacon's bridge.
      taskExtras: null,
      // API routes answering an empty 404 (e.g. ['device/code'] = a Beacon without device sign-in, ['me'] = not Beacon).
      notFound: [],
      // Lifetime of device codes in seconds (0 = expired at the first poll).
      deviceExpiresIn: 600,
      // '1.10' (contract v0.3) or '1.9' (contract v0.2).
      apiVersion: '1.10',
      // client_api.backdate.max_seconds (0 = backdating off).
      backdateMaxSeconds: 86400,
      allowReassign: true,
      // 1.10.x: `note` on `keep` (features.idle_keep_note).
      keepNote: false,
      idleCheck: { enabled: true, threshold_minutes: 10, answer_timeout_minutes: 5 },
      // limits.idle_check.user_can_disable; null = key absent.
      userCanDisable: null,
      // TimeTrack 1.14 meetings: null = an older server (no `features.meetings`, `me/meetings` 404). Else
      // {status: 'connected' | 'not_connected' | 'needs_reconnect' | 'syncing', refreshAfterSeconds, calendarsUrl,
      //  list: [meeting as in GET me/meetings]}; `enabled: false` = the 1.14 server with the feature off.
      meetings: null,
      // `meetings:read` is a known scope (1.14+); false = device/code refuses it like an older server.
      meetingsScope: true,
      // Extra generated tasks after the eight above (T-201 "Sample task 1", …): a long list for the scrolling tests.
      extraTasks: 0,
      // TimeTrackBundle 2.2 context policy (BD-3a): null = none (the header is ignored); else {required, refuse: [keys]}
      // (`403 context_forbidden` for a refused key, `400 context_required` without a header when required).
      contextPolicy: null,
      // TimeTrackBundle 2.1 subjects and activity types: null = a 2.0 server; else {requireActivityType, subjects: bool}.
      allocation: null,
      // Tasks listed per context ({context: [task ids]}); null = every task in every context.
      contextTasks: null,
    },
  };
}

function token() {
  return randomBytes(32).toString('base64url');
}

function userCode() {
  let code = '';
  for (const byte of randomBytes(8)) {
    code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return code;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export function createMockServer(options = {}) {
  let state = freshState();
  const chat = createChatMock({ send: (...args) => send(...args), error: (...args) => error(...args) });
  const allowedOrigins = options.allowedOrigins ?? null; // null = echo any origin (dev / tests)

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins === null || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Beacon-Context');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After, Content-Disposition, X-Min-Supported-Version');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function send(res, status, body, headers = {}) {
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(status).end(JSON.stringify(body));
  }

  function error(res, status, code, message, headers) {
    send(res, status, { error: code, message }, headers);
  }

  function auth(req, res, scope) {
    const header = req.headers.authorization ?? '';
    const session = header.startsWith('Bearer ') ? state.tokens.get(header.slice(7).trim()) : undefined;
    if (!session || session.expiresAt < Date.now()) {
      error(res, 401, 'invalid_token', 'The access token is missing, expired or revoked.');
      return null;
    }
    // Contract v0.5: only a `time` token opens the time API.
    if ((session.family ?? 'time') !== 'time') {
      error(res, 403, 'insufficient_scope', 'Only a time token opens this API.');
      return null;
    }
    if (scope && !session.scopes.includes(scope)) {
      error(res, 403, 'insufficient_scope', `The token lacks the ${scope} scope.`);
      return null;
    }
    return session;
  }

  function issue(userId, clientType, scopes = state.config.tokenScopes, family = 'time') {
    const value = token();
    const expiresAt = Date.now() + 30 * 24 * 3600 * 1000;
    state.tokens.set(value, { userId, clientType, scopes: [...scopes], expiresAt, family });
    return { token: value, expiresAt: new Date(expiresAt).toISOString(), scopes: [...scopes], scopeFamily: family };
  }

  function allTasks() {
    const extra = Math.max(0, Math.min(Number(state.config.extraTasks) || 0, 200));
    return [...TASKS, ...Array.from({ length: extra }, (_, i) => ({ id: `T-${201 + i}`, title: `Sample task ${i + 1}`, boardId: 'misc', boardTitle: 'Miscellaneous' }))];
  }

  function withUrl(item, taskId) {
    const url = state.config.taskUrls?.[taskId];
    const extras = state.config.taskExtras?.[taskId] ?? {};
    return url === undefined ? { ...item, ...extras } : { ...item, ...extras, url };
  }

  function startTimer(userId, taskId, note, source, origin = null) {
    const task = allTasks().find((t) => t.id === taskId);
    const timer = withUrl(
      {
        id: randomUUID(),
        taskId: task.id,
        taskTitle: task.title,
        boardId: task.boardId,
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: null,
        clientType: source,
        metadata: note || origin ? { ...(note ? { note } : {}), ...(origin ? { origin } : {}) } : null,
      },
      task.id,
    );
    state.timers.set(userId, timer);
    return timer;
  }

  function stopTimer(userId, note, at = new Date()) {
    const timer = state.timers.get(userId);
    if (!timer) {
      return null;
    }
    state.timers.delete(userId);
    const startedAt = new Date(timer.startedAt);
    const entry = {
      id: randomUUID(),
      taskId: timer.taskId,
      taskTitle: timer.taskTitle,
      boardId: timer.boardId,
      startedAt: timer.startedAt,
      endedAt: at.toISOString(),
      durationSeconds: Math.max(0, Math.round((at.getTime() - startedAt.getTime()) / 1000)),
      source: timer.clientType,
      metadata: note ? { note } : timer.metadata,
      ...(state.config.allocation !== null ? { subject: timer.subject ?? null, activityType: timer.activityType ?? null } : {}),
    };
    const list = state.entries.get(userId) ?? [];
    list.push(entry);
    state.entries.set(userId, list);
    return entry;
  }

  const v110 = () => state.config.apiVersion !== '1.9';
  const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
  /** The 1.14 meetings feature is on for the demo user. */
  const meetingsOn = () => v110() && state.config.meetings !== null && state.config.meetings.enabled !== false;
  /** `GET me` additions of 1.14 (absent on an older server). */
  function meetingsOfMe() {
    if (state.config.meetings === null || !v110()) return {};
    const config = state.config.meetings;
    return {
      meetings: meetingsOn() ? { status: config.status ?? 'connected', refreshAfterSeconds: config.refreshAfterSeconds ?? 300 } : null,
      links: { calendars: config.calendarsUrl ?? null },
    };
  }

  /** Strict-enough RFC 3339 check (the bundle uses one parser for every client time). */
  function parseTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : new Date(Math.floor(date.getTime() / 1000) * 1000);
  }

  function result(requested, applied, clamped, reason) {
    return { requested: requested.toISOString(), applied: applied.toISOString(), clamped, reason };
  }

  /** Contract v0.3 §4.2. */
  function clampStart(userId, requested) {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const max = state.config.backdateMaxSeconds;
    if (max === 0) return result(requested, now, true, 'disabled');
    if (requested.getTime() > now.getTime() + CLOCK_SKEW_SECONDS * 1000) return result(requested, now, true, 'future');
    if (requested > now) return result(requested, now, false, null);
    const ends = (state.entries.get(userId) ?? []).map((e) => Date.parse(e.endedAt));
    const lastEnd = ends.length > 0 ? Math.max(...ends) : null;
    const floor = now.getTime() - max * 1000;
    const lower = lastEnd !== null && lastEnd > now.getTime() ? now.getTime() : Math.max(floor, lastEnd ?? -Infinity);
    if (requested.getTime() >= lower) return result(requested, requested, false, null);
    return result(requested, new Date(lower), true, lastEnd !== null && lastEnd >= floor ? 'overlap' : 'max_backdate');
  }

  /** Contract v0.3 §4.4. */
  function clampStop(timer, requested) {
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const start = new Date(timer.startedAt);
    if (state.config.backdateMaxSeconds === 0) return result(requested, now, true, 'disabled');
    if (requested.getTime() > now.getTime() + CLOCK_SKEW_SECONDS * 1000) return result(requested, now, true, 'future');
    if (requested > now) return result(requested, now, false, null);
    if (requested < start) return result(requested, start, true, 'before_start');
    return result(requested, requested, false, null);
  }

  function validTask(body) {
    return typeof body.taskId === 'string' && allTasks().some((t) => t.id === body.taskId);
  }

  function validSource(body, res) {
    if ('metadata' in body) {
      error(res, 400, 'metadata_not_allowed', 'Free metadata is not accepted.');
      return false;
    }
    if (body.source !== undefined && !SOURCES.has(body.source)) {
      error(res, 400, 'invalid_request', 'Unknown source.');
      return false;
    }
    return true;
  }

  /** Applies `{subject?, activityTypeKey?}` of a write to `timer` (2.1); returns an error answer or null. */
  function allocateOn(res, timer, body) {
    if (state.config.allocation === null) return null;
    if (body.activityTypeKey !== undefined) {
      const type = ACTIVITY_TYPES.find((item) => item.key === body.activityTypeKey);
      if (!type) return error(res, 422, 'activity_type_unknown', 'Unknown activity type.');
      timer.activityType = { key: type.key, label: type.label };
    }
    if (body.subject === null) timer.subject = null;
    else if (body.subject !== undefined) {
      const subject = SUBJECTS.find((item) => item.type === body.subject?.type && item.id === body.subject?.id);
      if (!subject) return error(res, 403, 'subject_forbidden', 'Subject not found.');
      timer.subject = { type: subject.type, id: subject.id, label: subject.label, url: null };
    }
    return null;
  }

  /** TimeTrackBundle 2.2 context policy: the header check of every request (null = go on). */
  function contextRefused(req, res) {
    const policy = state.config.contextPolicy;
    // Authentication comes first (an unauthenticated request answers 401, the connect preflight relies on it).
    if (policy === null || !(req.headers.authorization ?? '').startsWith('Bearer ')) return null;
    const header = req.headers['x-beacon-context'];
    if (header === undefined) return policy.required ? error(res, 400, 'context_required', 'X-Beacon-Context is required.') : null;
    if (!TIME_CONTEXTS.some((item) => item.key === header) || (policy.refuse ?? []).includes(header)) return error(res, 403, 'context_forbidden', 'You may not use this context.');
    return null;
  }

  async function api(req, res, route, url, body) {
    if (!['POST login', 'POST logout', 'POST device/code', 'POST device/token'].includes(`${req.method} ${route}`) && contextRefused(req, res) !== null) return;
    switch (`${req.method} ${route}`) {
      case 'POST login': {
        const user = USERS.find((u) => u.email === body.username && u.password === body.password);
        if (!body.username || !body.password) {
          return error(res, 400, 'invalid_request', 'username and password are required.');
        }
        if (!user) {
          return error(res, 401, 'invalid_credentials', 'Invalid credentials.');
        }
        return send(res, 200, issue(user.id, body.clientType ?? 'extension'));
      }
      case 'POST logout': {
        const header = req.headers.authorization ?? '';
        state.tokens.delete(header.slice(7).trim());
        return send(res, 204);
      }
      case 'GET me': {
        const session = auth(req, res);
        if (!session) return;
        const user = USERS.find((u) => u.id === session.userId);
        const backdate = state.config.backdateMaxSeconds > 0;
        const idle = state.config.idleCheck;
        return send(res, 200, {
          userId: user.id,
          identifier: user.email,
          displayName: user.displayName,
          scopes: session.scopes,
          workingHours: state.config.workingHours,
          ...(state.config.daysOff !== null ? { daysOff: state.config.daysOff } : {}),
          ...(state.config.locale !== null ? { locale: state.config.locale } : {}),
          ...(state.config.minSupportedVersion ? { minSupportedVersion: state.config.minSupportedVersion } : {}),
          ...meetingsOfMe(),
          ...(state.config.contextPolicy !== null
            ? { contexts: TIME_CONTEXTS.filter((item) => !(state.config.contextPolicy.refuse ?? []).includes(item.key)), context: req.headers['x-beacon-context'] ?? null }
            : {}),
          ...(v110()
            ? {
                features: {
                  task_details: true,
                  start_backdate: backdate,
                  stop_backdate: backdate,
                  idle_reassign: state.config.allowReassign,
                  idle_check: idle.enabled,
                  ...(state.config.keepNote ? { idle_keep_note: true } : {}),
                  workday: false,
                  monitoring: false,
                  ...(meetingsOn() ? { meetings: true } : state.config.meetings !== null ? { meetings: false } : {}),
                  ...(state.config.allocation !== null
                    ? {
                        subjects: state.config.allocation.subjects === false ? [] : [{ type: 'customer', label: 'Customer', allowsTask: true }],
                        activityTypes: true,
                        requireAllocation: false,
                        requireActivityType: state.config.allocation.requireActivityType === true,
                      }
                    : {}),
                },
                limits: {
                  backdate: { max_seconds: state.config.backdateMaxSeconds, clock_skew_seconds: CLOCK_SKEW_SECONDS },
                  idle_check: {
                    threshold_minutes: idle.threshold_minutes,
                    answer_timeout_minutes: idle.answer_timeout_minutes,
                    ...(state.config.userCanDisable !== null ? { user_can_disable: state.config.userCanDisable } : {}),
                  },
                },
              }
            : {}),
        });
      }
      case 'GET tasks': {
        if (!auth(req, res, 'tasks:read')) return;
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 50);
        const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
        // BD-3a: `contextTasks` ({context: [task ids]}) lists only those tasks in that context, as Beacon's filter does.
        const only = state.config.contextTasks?.[req.headers['x-beacon-context'] ?? 'personal'] ?? null;
        const tasks = allTasks().filter(
          (t) => (only === null || only.includes(t.id)) && (search === '' || t.title.toLowerCase().includes(search) || t.id.toLowerCase() === search),
        );
        return send(res, 200, { tasks: tasks.slice(offset, offset + limit).map((t) => withUrl(t, t.id)) });
      }
      case 'GET timer': {
        const session = auth(req, res, 'timer:read');
        if (!session) return;
        const timer = state.timers.get(session.userId);
        return timer ? send(res, 200, { timer }) : send(res, 204);
      }
      case 'POST timer/start': {
        const session = auth(req, res, 'timer:write');
        if (!session || !validSource(body, res)) return;
        if (!validTask(body)) {
          return error(res, 403, 'task_forbidden', 'You may not track time on this task.');
        }
        const startedAt = v110() && body.startedAt !== undefined ? parseTime(body.startedAt) : undefined;
        if (startedAt === null) {
          return error(res, 400, 'invalid_request', 'startedAt must be an RFC 3339 date-time.');
        }
        if (state.timers.has(session.userId)) {
          return error(res, 409, 'timer_running', 'A timer is already running.');
        }
        const clamp = startedAt !== undefined ? clampStart(session.userId, startedAt) : null;
        const probe = {};
        if (allocateOn(res, probe, body) !== null) return;
        const timer = startTimer(session.userId, body.taskId, body.note, body.source ?? session.clientType);
        if (state.config.allocation !== null) Object.assign(timer, { subject: probe.subject ?? null, activityType: probe.activityType ?? null });
        if (clamp !== null) timer.startedAt = clamp.applied;
        return send(res, 201, clamp !== null ? { timer, startedAtResult: clamp } : { timer });
      }
      case 'POST timer/stop': {
        const session = auth(req, res, 'timer:write');
        if (!session) return;
        const endedAt = v110() && body.endedAt !== undefined ? parseTime(body.endedAt) : undefined;
        if (endedAt === null) {
          return error(res, 400, 'invalid_request', 'endedAt must be an RFC 3339 date-time.');
        }
        const timer = state.timers.get(session.userId);
        if (timer && state.config.allocation !== null) {
          const draft = { ...timer };
          if (allocateOn(res, draft, body) !== null) return;
          // 2.1: a refused stop writes nothing and the timer keeps running.
          if (state.config.allocation.requireActivityType && !draft.activityType) return send(res, 409, { error: 'activity_type_required', message: 'Choose an activity type before you stop the timer.', timer });
          Object.assign(timer, { subject: draft.subject ?? null, activityType: draft.activityType ?? null });
        }
        const clamp = timer && endedAt !== undefined ? clampStop(timer, endedAt) : null;
        const entry = stopTimer(session.userId, body.note, clamp !== null ? new Date(clamp.applied) : undefined);
        if (!entry) return error(res, 404, 'no_active_timer', 'No active timer.');
        return send(res, 200, clamp !== null ? { entry, endedAtResult: clamp } : { entry });
      }
      case 'POST timer/switch': {
        const session = auth(req, res, 'timer:write');
        // 1.14 (Q-B22): "Track the meeting" is the only metadata a switch accepts.
        const meeting = state.config.meetings !== null && body.metadata?.origin === 'meeting' && Object.keys(body.metadata).length === 1;
        if (!session || !validSource(meeting ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'metadata')) : body, res)) return;
        if (!validTask(body)) {
          return error(res, 403, 'task_forbidden', 'You may not track time on this task.');
        }
        const probe = {};
        if (allocateOn(res, probe, body) !== null) return;
        const entry = stopTimer(session.userId, body.note) ?? null;
        const timer = startTimer(session.userId, body.taskId, undefined, body.source ?? session.clientType, meeting ? 'meeting' : null);
        if (state.config.allocation !== null) Object.assign(timer, { subject: probe.subject ?? null, activityType: probe.activityType ?? null });
        return send(res, 201, { entry, timer });
      }
      case 'POST timer/allocate': {
        const session = auth(req, res, 'timer:write');
        if (!session) return;
        if (state.config.allocation === null) return error(res, 404, 'not_found', 'Unknown endpoint.');
        const timer = state.timers.get(session.userId);
        if (!timer) return error(res, 404, 'no_active_timer', 'No active timer.');
        if (allocateOn(res, timer, body) !== null) return;
        return send(res, 200, { timer });
      }
      case 'GET activity-types': {
        if (!auth(req, res, 'tasks:read')) return;
        if (state.config.allocation === null) return error(res, 404, 'not_found', 'Unknown endpoint.');
        return send(res, 200, { scopeKey: null, activityTypes: state.config.allocation.noActivityTypes ? [] : ACTIVITY_TYPES });
      }
      case 'GET subjects/search': {
        if (!auth(req, res, 'tasks:read')) return;
        if (state.config.allocation === null) return error(res, 404, 'not_found', 'Unknown endpoint.');
        const type = url.searchParams.get('type') ?? '';
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(type) || q.length > 100) return error(res, 400, 'invalid_request', 'Invalid search.');
        return send(res, 200, { subjects: SUBJECTS.filter((item) => item.type === type && (q === '' || item.label.toLowerCase().includes(q))).map((item) => ({ ...item, url: null })) });
      }
      case 'POST timer/discard-idle': {
        const session = auth(req, res, 'timer:write');
        if (!session) return;
        const from = new Date(body.from);
        const to = new Date(body.to);
        const reassign = body.action === 'reassign';
        if (!IDLE_ACTIONS.has(body.action) || (reassign && (!v110() || !state.config.allowReassign)) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
          return error(res, 400, 'invalid_request', 'from < to and a known action are required.');
        }
        if (reassign && (typeof body.taskId !== 'string' || body.taskId.trim() === '' || (body.then !== undefined && !IDLE_THEN.has(body.then)))) {
          return error(res, 400, 'invalid_request', 'taskId is required and then must be continue|stop|switch.');
        }
        if (reassign && !validTask(body)) {
          return error(res, 403, 'task_forbidden', 'You may not track time on this task.');
        }
        const timer = state.timers.get(session.userId);
        if (!timer) {
          return error(res, 404, 'no_active_timer', 'No active timer.');
        }
        if (reassign && body.taskId === timer.taskId) {
          return error(res, 400, 'invalid_request', 'use keep or split for the same task');
        }
        if (from < new Date(timer.startedAt) || to > new Date(Date.now() + 1000)) {
          return error(res, 400, 'invalid_request', 'from must be >= the timer start and to <= now.');
        }
        state.idleDecisions.push({
          userId: session.userId,
          from: body.from,
          to: body.to,
          action: body.action,
          ...(reassign ? { taskId: body.taskId, then: body.then ?? 'continue', note: body.note ?? null } : {}),
          ...(body.action === 'keep' && state.config.keepNote && typeof body.note === 'string' ? { note: body.note.trim().slice(0, 500) } : {}),
        });
        const reassignedKey = v110() ? { reassigned: null } : {};
        if (body.action === 'keep') {
          return send(res, 200, { entry: null, timer, ...reassignedKey });
        }
        const { taskId, clientType } = timer;
        const entry = from.getTime() > new Date(timer.startedAt).getTime() || !reassign ? stopTimer(session.userId, undefined, from) : (state.timers.delete(session.userId), null);
        if (body.action === 'discard') {
          return send(res, 200, { entry, timer: null, ...reassignedKey });
        }
        if (reassign) {
          startTimer(session.userId, body.taskId, body.note, body.source ?? clientType);
          state.timers.get(session.userId).startedAt = from.toISOString();
          const reassigned = stopTimer(session.userId, body.note, to);
          const then = body.then ?? 'continue';
          const next = then === 'stop' ? null : startTimer(session.userId, then === 'switch' ? body.taskId : taskId, undefined, clientType);
          if (next) next.startedAt = to.toISOString();
          return send(res, 200, { entry, reassigned, timer: next });
        }
        const restarted = startTimer(session.userId, taskId, undefined, clientType);
        restarted.startedAt = to.toISOString();
        return send(res, 200, { entry, timer: restarted, ...reassignedKey });
      }
      case 'GET entries': {
        const session = auth(req, res, 'entries:read');
        if (!session) return;
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 100);
        const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
        const newestFirst = [...(state.entries.get(session.userId) ?? [])].reverse();
        return send(res, 200, { entries: newestFirst.slice(offset, offset + limit), limit, offset });
      }
      case 'GET export': {
        const session = auth(req, res, 'entries:read');
        if (!session) return;
        const entries = state.entries.get(session.userId) ?? [];
        const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
        const from = (url.searchParams.get('from') ?? '').slice(0, 10);
        const to = (url.searchParams.get('to') ?? '').slice(0, 10);
        const filename = `time-entries-${from}-${to}.${format}`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (format === 'json') {
          return send(res, 200, { entries });
        }
        const rows = ['id,taskId,taskTitle,startedAt,endedAt,durationSeconds,source'];
        for (const e of entries) {
          rows.push([e.id, e.taskId, `"${e.taskTitle.replaceAll('"', '""')}"`, e.startedAt, e.endedAt, e.durationSeconds, e.source].join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.writeHead(200).end(`${rows.join('\n')}\n`);
        return;
      }
      case 'GET me/meetings': {
        const session = auth(req, res, MEETINGS_SCOPE);
        if (!session) return;
        if (!meetingsOn()) return error(res, 404, 'not_found', 'Unknown endpoint.', NO_STORE);
        for (const key of url.searchParams.keys()) {
          if (!MEETING_PARAMS.has(key)) return send(res, 400, { error: 'unknown_parameter', field: key }, NO_STORE);
        }
        const bound = (name, fallback) => {
          const raw = url.searchParams.get(name);
          if (raw === null) return fallback;
          return RFC3339.test(raw) ? new Date(raw) : null;
        };
        const from = bound('from', new Date());
        if (from === null) return send(res, 400, { error: 'invalid_datetime', field: 'from' }, NO_STORE);
        const to = bound('to', new Date(from.getTime() + 24 * 3600_000));
        if (to === null) return send(res, 400, { error: 'invalid_datetime', field: 'to' }, NO_STORE);
        if (to <= from || to - from > 14 * 24 * 3600_000) return send(res, 400, { error: 'invalid_range', field: 'to' }, NO_STORE);
        const config = state.config.meetings;
        const meetings = (config.list ?? [])
          .filter((item) => Date.parse(item.start) < to.getTime() && Date.parse(item.end) > from.getTime())
          .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
        return send(
          res,
          200,
          {
            from: from.toISOString(),
            to: to.toISOString(),
            tz: url.searchParams.get('tz') ?? 'UTC',
            generatedAt: new Date().toISOString(),
            sync: { status: config.status ?? 'connected', lastSyncAt: null, refreshAfterSeconds: config.refreshAfterSeconds ?? 300 },
            truncated: false,
            meetings,
          },
          { ...NO_STORE, Vary: 'Authorization' },
        );
      }
      case 'POST device/code': {
        // Contract v0.5: `family` (time by default; `chat` with chat scopes); a Bearer of a token the device holds
        // chains the request (only that token's owner may approve it).
        const family = body.family ?? 'time';
        const known = family === 'chat' ? CHAT_SCOPES : state.config.meetingsScope ? [...ALL_SCOPES, MEETINGS_SCOPE] : ALL_SCOPES;
        const scopes = body.scopes ?? [...ALL_SCOPES];
        if (!['time', 'chat'].includes(family) || !Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !known.includes(scope))) {
          return error(res, 400, 'invalid_scope', 'Unknown or empty scope list.');
        }
        let chainedTo = null;
        if (req.headers.authorization !== undefined) {
          const holder = state.tokens.get(req.headers.authorization.replace(/^Bearer\s+/, ''));
          if (!holder) return error(res, 401, 'invalid_token', 'The access token is missing, expired or revoked.');
          chainedTo = holder.userId;
        }
        state.chatDeviceRequests = (state.chatDeviceRequests ?? 0) + (family === 'chat' ? 1 : 0);
        const deviceCode = token();
        const code = userCode();
        const host = req.headers.host ?? '127.0.0.1';
        state.devices.set(deviceCode, {
          userCode: code,
          clientName: String(body.clientName ?? 'Unknown device'),
          clientType: body.clientType ?? 'desktop',
          approved: null,
          scopes,
          family,
          chainedTo,
          expiresAt: Date.now() + (state.config.deviceExpiresIn ?? 600) * 1000,
          used: false,
          lastPollAt: 0,
        });
        const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
        return send(res, 200, {
          deviceCode,
          userCode: shown,
          expiresIn: state.config.deviceExpiresIn ?? 600,
          interval: state.config.deviceInterval,
          verificationUri: state.config.verificationUri ?? `http://${host}/device`,
          verificationUriComplete: `${state.config.verificationUri ?? `http://${host}/device`}?code=${shown}`,
          scopeFamily: family,
        });
      }
      case 'POST device/token': {
        const device = state.devices.get(body.deviceCode);
        if (!device || device.used || device.expiresAt < Date.now()) {
          return error(res, 400, 'expired_token', 'The device code expired.');
        }
        const now = Date.now();
        const tooFast = now - device.lastPollAt < state.config.deviceInterval * 1000 * 0.8;
        device.lastPollAt = now;
        if (device.approved === null) {
          return tooFast
            ? error(res, 400, 'slow_down', 'Polling too fast.')
            : error(res, 400, 'authorization_pending', 'Waiting for the user to approve.');
        }
        if (device.approved === false) {
          state.devices.delete(body.deviceCode);
          return error(res, 400, 'access_denied', 'The user denied the request.');
        }
        device.used = true;
        const owner = device.userId ?? USERS[0].id;
        if (device.chainedTo !== null && device.chainedTo !== undefined && device.chainedTo !== owner) {
          return error(res, 400, 'access_denied', 'Another user approved a chained request.');
        }
        return send(res, 200, issue(owner, device.clientType, device.scopes, device.family ?? 'time'));
      }
      case 'POST heartbeat':
        return error(res, 410, 'deprecated', 'heartbeat is deprecated; clients must not send idle state.');
      default: {
        // Beacon route time_track_client_updater: /api/time-track/updates/desktop/{target}/{arch}/{current_version}
        const match = /^GET updates\/desktop\/([\w-]+)\/([\w-]+)\/([\w.+-]+)$/.exec(`${req.method} ${route}`);
        if (match) {
          if (!auth(req, res)) return;
          const update = state.config.update;
          const min = state.config.minSupportedVersion ? { 'X-Min-Supported-Version': state.config.minSupportedVersion } : {};
          if (!update || update.version === match[3]) {
            return send(res, 204, undefined, min);
          }
          return send(res, 200, update, min);
        }
        return error(res, 404, 'not_found', 'Unknown endpoint.');
      }
    }
  }
  function approveDevice(code, approve, userId) {
    for (const device of state.devices.values()) {
      if (!device.used && device.userCode === String(code).toUpperCase().replace(/[^A-Z]/g, '')) {
        device.approved = approve;
        device.userId = userId;
        return true;
      }
    }
    return false;
  }

  async function control(req, res, route, body) {
    switch (`${req.method} ${route}`) {
      case 'POST reset':
        state = freshState();
        chat.reset();
        return send(res, 204);
      case 'POST chat/post':
        return send(res, 200, chat.post(body));
      case 'GET chat/state':
        return send(res, 200, chat.state());
      case 'POST config':
        state.config = { ...state.config, ...body };
        return send(res, 200, state.config);
      case 'GET state':
        return send(res, 200, {
          idleDecisions: state.idleDecisions,
          requests: state.requests,
          timers: Object.fromEntries(state.timers),
          entries: Object.fromEntries(state.entries),
          tokens: state.tokens.size,
        });
      case 'POST token/revoke':
        state.tokens.clear();
        return send(res, 204);
      case 'POST device/approve':
        return approveDevice(body.userCode, body.approve !== false, USERS.some((u) => u.id === body.userId) ? body.userId : undefined) ? send(res, 204) : error(res, 404, 'not_found', 'Unknown code.');
      // Finished entries of the demo user ({entries: [{taskId, startedAt, endedAt}]}), for the week / today views.
      case 'POST entries/seed': {
        const list = state.entries.get(USERS[0].id) ?? [];
        for (const item of body.entries ?? []) {
          const task = TASKS.find((t) => t.id === item.taskId) ?? { id: item.taskId, title: item.taskId, boardId: null };
          const from = new Date(item.startedAt);
          const to = new Date(item.endedAt);
          list.push({
            id: randomUUID(),
            taskId: task.id,
            taskTitle: task.title,
            boardId: task.boardId,
            startedAt: from.toISOString(),
            endedAt: to.toISOString(),
            durationSeconds: Math.round((to.getTime() - from.getTime()) / 1000),
            source: 'web',
            metadata: null,
          });
        }
        list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
        state.entries.set(USERS[0].id, list);
        return send(res, 204);
      }
      case 'POST timer/backdate': {
        for (const timer of state.timers.values()) {
          timer.startedAt = new Date(new Date(timer.startedAt).getTime() - Number(body.seconds ?? 0) * 1000).toISOString();
        }
        return send(res, 204);
      }
      default:
        return error(res, 404, 'not_found', 'Unknown control endpoint.');
    }
  }

  function devicePage(res, message = '') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    res.writeHead(200).end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect a device (mock)</title>
<body style="font-family:sans-serif;max-width:28rem;margin:3rem auto">
<h1>Connect a device</h1><p>Mock of the host verification page. Enter the code shown by the app.</p>
<p>${message}</p>
<form method="post" action="/device"><input name="userCode" autocomplete="off" required>
<button name="approve" value="1">Approve</button> <button name="approve" value="0">Deny</button></form></body></html>`);
  }

  const server = createServer(async (req, res) => {
    cors(req, res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const raw = req.method === 'POST' ? await readBody(req) : '';
    if (req.method === 'OPTIONS') {
      return send(res, 204);
    }

    if (url.pathname === '/device') {
      if (req.method === 'POST') {
        const form = new URLSearchParams(raw);
        const ok = approveDevice(form.get('userCode') ?? '', form.get('approve') === '1');
        return devicePage(res, ok ? 'Done. You can go back to the app.' : 'Unknown code.');
      }
      return devicePage(res);
    }

    let body = {};
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        return error(res, 400, 'invalid_request', 'Invalid JSON.');
      }
    }

    if (url.pathname.startsWith('/__mock/')) {
      return control(req, res, url.pathname.slice('/__mock/'.length), body);
    }

    if (url.pathname.startsWith(`${CHAT_PREFIX}/`)) {
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, body: raw, origin: req.headers.origin ?? null, context: req.headers['x-beacon-context'] ?? null });
      if (state.config.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, state.config.latencyMs));
      return chat.handle(req, res, url, body, state);
    }

    if (!url.pathname.startsWith(`${PREFIX}/`)) {
      return error(res, 404, 'not_found', 'Unknown endpoint.');
    }

    const route = url.pathname.slice(PREFIX.length + 1);
    state.requests.push({ method: req.method, path: url.pathname, query: url.search, body: raw, origin: req.headers.origin ?? null, context: req.headers['x-beacon-context'] ?? null });

    if (state.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.config.latencyMs));
    }
    if (state.config.notFound.includes(route)) {
      return send(res, 404);
    }
    if (state.config.failNext) {
      const { status, error: code, retryAfter } = state.config.failNext;
      state.config.failNext = null;
      return error(res, status, code, `Simulated ${code}.`, retryAfter ? { 'Retry-After': String(retryAfter) } : {});
    }
    return api(req, res, route, url, body);
  });

  return {
    server,
    listen(port = 8787, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const mock = createMockServer();
  mock.listen(port, host).then(() => {
    console.log(`TimeTrack mock API on http://${host}:${port}${PREFIX} (ada@example.com / app-password-123)`);
  });
}
