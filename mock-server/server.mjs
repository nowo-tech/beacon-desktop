#!/usr/bin/env node
/**
 * Mock of the TimeTrackBundle 1.9.0 client API (docs/CLIENT-API.md of nowo-tech/TimeTrackBundle) plus Beacon's
 * desktop updater route. Zero dependencies. Used by the unit / e2e tests and for local development:
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

const PREFIX = '/api/time-track';
const ALL_SCOPES = ['timer:read', 'timer:write', 'tasks:read', 'entries:read'];
const SOURCES = new Set(['extension', 'desktop', 'web']);
const IDLE_ACTIONS = new Set(['keep', 'discard', 'split']);
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

const USERS = [
  { id: 1, email: 'ada@example.com', password: 'app-password-123', displayName: 'Ada Lovelace' },
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
      deviceInterval: 5,
      tokenScopes: [...ALL_SCOPES],
      failNext: null,
      latencyMs: 0,
      // Beacon updater answer: null = 204 (up to date), else {version, notes, pub_date, url, signature, min_supported_version?}.
      update: null,
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
  const allowedOrigins = options.allowedOrigins ?? null; // null = echo any origin (dev / tests)

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins === null || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After, Content-Disposition');
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
    if (scope && !session.scopes.includes(scope)) {
      error(res, 403, 'insufficient_scope', `The token lacks the ${scope} scope.`);
      return null;
    }
    return session;
  }

  function issue(userId, clientType, scopes = state.config.tokenScopes) {
    const value = token();
    const expiresAt = Date.now() + 30 * 24 * 3600 * 1000;
    state.tokens.set(value, { userId, clientType, scopes: [...scopes], expiresAt });
    return { token: value, expiresAt: new Date(expiresAt).toISOString(), scopes: [...scopes] };
  }

  function startTimer(userId, taskId, note, source) {
    const task = TASKS.find((t) => t.id === taskId);
    const timer = {
      id: randomUUID(),
      taskId: task.id,
      taskTitle: task.title,
      boardId: task.boardId,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: null,
      clientType: source,
      metadata: note ? { note } : null,
    };
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
    };
    const list = state.entries.get(userId) ?? [];
    list.push(entry);
    state.entries.set(userId, list);
    return entry;
  }

  function validTask(body) {
    return typeof body.taskId === 'string' && TASKS.some((t) => t.id === body.taskId);
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

  async function api(req, res, route, url, body) {
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
        return send(res, 200, {
          userId: user.id,
          identifier: user.email,
          displayName: user.displayName,
          scopes: session.scopes,
          workingHours: state.config.workingHours,
        });
      }
      case 'GET tasks': {
        if (!auth(req, res, 'tasks:read')) return;
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 50);
        const offset = Number(url.searchParams.get('offset') ?? 0) || 0;
        const tasks = TASKS.filter(
          (t) => search === '' || t.title.toLowerCase().includes(search) || t.id.toLowerCase() === search,
        );
        return send(res, 200, { tasks: tasks.slice(offset, offset + limit) });
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
        if (state.timers.has(session.userId)) {
          return error(res, 409, 'timer_running', 'A timer is already running.');
        }
        return send(res, 201, { timer: startTimer(session.userId, body.taskId, body.note, body.source ?? session.clientType) });
      }
      case 'POST timer/stop': {
        const session = auth(req, res, 'timer:write');
        if (!session) return;
        const entry = stopTimer(session.userId, body.note);
        return entry ? send(res, 200, { entry }) : error(res, 404, 'no_active_timer', 'No active timer.');
      }
      case 'POST timer/switch': {
        const session = auth(req, res, 'timer:write');
        if (!session || !validSource(body, res)) return;
        if (!validTask(body)) {
          return error(res, 403, 'task_forbidden', 'You may not track time on this task.');
        }
        const entry = stopTimer(session.userId, body.note) ?? null;
        const timer = startTimer(session.userId, body.taskId, undefined, body.source ?? session.clientType);
        return send(res, 201, { entry, timer });
      }
      case 'POST timer/discard-idle': {
        const session = auth(req, res, 'timer:write');
        if (!session) return;
        const from = new Date(body.from);
        const to = new Date(body.to);
        if (!IDLE_ACTIONS.has(body.action) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
          return error(res, 400, 'invalid_request', 'from < to and action keep|discard|split are required.');
        }
        const timer = state.timers.get(session.userId);
        if (!timer) {
          return error(res, 404, 'no_active_timer', 'No active timer.');
        }
        if (from < new Date(timer.startedAt) || to > new Date(Date.now() + 1000)) {
          return error(res, 400, 'invalid_request', 'from must be >= the timer start and to <= now.');
        }
        state.idleDecisions.push({ userId: session.userId, from: body.from, to: body.to, action: body.action });
        if (body.action === 'keep') {
          return send(res, 200, { entry: null, timer });
        }
        const { taskId, clientType } = timer;
        const entry = stopTimer(session.userId, undefined, from);
        if (body.action === 'discard') {
          return send(res, 200, { entry, timer: null });
        }
        const restarted = startTimer(session.userId, taskId, undefined, clientType);
        restarted.startedAt = to.toISOString();
        return send(res, 200, { entry, timer: restarted });
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
      case 'POST device/code': {
        const scopes = body.scopes ?? [...ALL_SCOPES];
        if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => !ALL_SCOPES.includes(scope))) {
          return error(res, 400, 'invalid_scope', 'Unknown or empty scope list.');
        }
        const deviceCode = token();
        const code = userCode();
        const host = req.headers.host ?? '127.0.0.1';
        state.devices.set(deviceCode, {
          userCode: code,
          clientName: String(body.clientName ?? 'Unknown device'),
          clientType: body.clientType ?? 'desktop',
          approved: null,
          scopes,
          expiresAt: Date.now() + 600_000,
          used: false,
          lastPollAt: 0,
        });
        const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
        return send(res, 200, {
          deviceCode,
          userCode: shown,
          expiresIn: 600,
          interval: state.config.deviceInterval,
          verificationUri: `http://${host}/device`,
          verificationUriComplete: `http://${host}/device?code=${shown}`,
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
        return send(res, 200, issue(USERS[0].id, device.clientType, device.scopes));
      }
      case 'POST heartbeat':
        return error(res, 410, 'deprecated', 'heartbeat is deprecated; clients must not send idle state.');
      default: {
        // Beacon route time_track_client_updater: /api/time-track/updates/desktop/{target}/{arch}/{current_version}
        const match = /^GET updates\/desktop\/([\w-]+)\/([\w-]+)\/([\w.+-]+)$/.exec(`${req.method} ${route}`);
        if (match) {
          if (!auth(req, res)) return;
          const update = state.config.update;
          if (!update || update.version === match[3]) {
            return send(res, 204);
          }
          return send(res, 200, update);
        }
        return error(res, 404, 'not_found', 'Unknown endpoint.');
      }
    }
  }
  function approveDevice(code, approve) {
    for (const device of state.devices.values()) {
      if (!device.used && device.userCode === String(code).toUpperCase().replace(/[^A-Z]/g, '')) {
        device.approved = approve;
        return true;
      }
    }
    return false;
  }

  async function control(req, res, route, body) {
    switch (`${req.method} ${route}`) {
      case 'POST reset':
        state = freshState();
        return send(res, 204);
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
        return approveDevice(body.userCode, body.approve !== false) ? send(res, 204) : error(res, 404, 'not_found', 'Unknown code.');
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

    if (!url.pathname.startsWith(`${PREFIX}/`)) {
      return error(res, 404, 'not_found', 'Unknown endpoint.');
    }

    const route = url.pathname.slice(PREFIX.length + 1);
    state.requests.push({ method: req.method, path: url.pathname, query: url.search, body: raw, origin: req.headers.origin ?? null });

    if (state.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.config.latencyMs));
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
