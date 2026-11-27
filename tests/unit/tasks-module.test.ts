// @vitest-environment happy-dom
// The Tasks module (BD-3b) through the DOM against the in-process mock Beacon (TimeTrack + ChatKit + TaskBoard): connect
// tasks, My tasks, the board and the list, moves (keyboard, conflict, policy refusal), the task panel's edits and
// checklists, quick add, a timer from a task, polling through `changes`, and `module_forbidden` hiding the module.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { landingModule, loadShellPrefs, SHELL_KEY, Shell } from '../../src/shell/shell';
import { NOTICE_MS, POLL_HIDDEN_MS, POLL_MINE_MS, POLL_SHOWN_MS } from '../../src/tasks/module';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

async function until(ready: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';

// ---- held requests (audit BDA13-M1 / L4): a request is held until the test releases it, then goes to the mock or gets
// a made-up answer; `offline` makes every later TaskBoard request fail as a network error.
interface Gate {
  match: (url: string, init: RequestInit) => boolean;
  hit: boolean;
  release: () => void;
  held: Promise<void>;
  answer?: () => Response;
}
// Per app instance (an earlier test's app keeps polling and must not take a later test's gate).
let gates: Gate[] = [];
let offline = { on: false };
function hold(match: Gate['match'], answer?: () => Response): Gate {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const gate: Gate = { match, hit: false, release, held, answer };
  gates.push(gate);
  return gate;
}
const route = (url: string) => new URL(url).pathname.replace('/api/task-board/v1/', '');
const isTasks = (url: string) => url.includes('/api/task-board/v1/');
const made = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;
function gatedFetch(): typeof fetch {
  const own: Gate[] = [];
  const down = { on: false };
  gates = own;
  offline = down;
  return (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    // Batch 1's dropped connection (`net.online = false`): every request fails, like the old flakyFetch.
    if (!net.online) throw new Error('offline');
    if (down.on && isTasks(url)) throw new TypeError('network down');
    const gate = own.find((item) => !item.hit && item.match(url, init));
    if (gate !== undefined) {
      gate.hit = true;
      await gate.held;
      if (gate.answer !== undefined) return gate.answer();
    }
    return nodeFetch(input, init);
  }) as unknown as typeof fetch;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/** The network: `online = false` makes every request fail as a dropped connection. */
const net = { online: true };
type Writes = { writes: { kind: string; taskId?: string; ifMatch?: string; done?: boolean; method?: string }[] };
const writes = async () => ((await env.control('tasks/state')) as Writes).writes;

/** A menu button's name: its text without the `aria-hidden` parts (marker, avatar, chevron). */
function accName(selector: string): string {
  const copy = (document.querySelector(selector) as HTMLElement).cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent ?? '';
}

/** Opens a menu button (picker.ts) with a pointer click and picks the item with `value`. */
function pick(trigger: string, value: string): void {
  const button = document.querySelector<HTMLButtonElement>(trigger) as HTMLButtonElement;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const menu = document.getElementById(button.getAttribute('aria-controls') as string) as HTMLElement;
  expect(menu.hidden).toBe(false);
  (menu.querySelector(`[data-value="${value}"]`) as HTMLButtonElement).click();
  expect(menu.hidden).toBe(true);
}

async function connected(locale: 'en' | 'es' = 'en') {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.1.0', gatedFetch());
  const shell = new Shell(root, platform, { locale, storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, { storage: localStorage, locale, onRender: () => shell.onAppRender(), beforeSignOut: () => shell.chat.revokeOnServer(), sleep: () => new Promise((resolve) => setTimeout(resolve, 5)), searchDelayMs: 1 });
  shell.attach(app);
  shell.freshSignIn = true;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  await app.init();
  const done = app.connect(env.url);
  await until(() => $('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  await until(() => shell.root.dataset.bare === 'false', 'the shell');
  // Time-only contexts (no chat): switch to the organization.
  await until(() => document.querySelector(`.ctx-tile[data-context="${ORG}"]`) !== null, 'the organization tiles');
  $<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
  await until(() => shell.context === ORG, 'the organization');
  $<HTMLButtonElement>('#tab-tasks').click();
  $<HTMLButtonElement>('#tasks-connect').click();
  await until(() => $('#tasks-user-code') !== null, 'the tasks code');
  await env.control('device/approve', { userCode: $('#tasks-user-code').textContent });
  await until(() => $('#tasks-mine .row') !== null, 'My tasks');
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  return { root, platform, shell, app, $, key, pick, tasks: shell.tasks as NonNullable<Shell['tasks']> };
}

describe('tasks module', () => {
  beforeEach(async () => {
    net.online = true;
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
  });

  it('connects with the tasks family, lands on My tasks, groups by due date, completes a task', async () => {
    const ui = await connected();
    expect(ui.platform.hooks.tasksConnectBegins).toBe(1);
    const state = (await env.control('state')) as { requests: { path: string; body: string }[] };
    expect(JSON.parse(state.requests.filter((item) => item.path.endsWith('device/code')).at(-1)?.body ?? '{}')).toMatchObject({ family: 'tasks', scopes: ['task-board:read', 'task-board:write'] });
    expect([...document.querySelectorAll('#tasks-mine h2')].map((node) => node.textContent?.replace(/·.*/, '').trim())).toEqual(['Overdue', 'Today', 'Upcoming', 'No date', 'To review']);
    expect(ui.$('#mt-overdue').classList.contains('over')).toBe(true);
    expect(ui.$('#tasks-title').textContent).toBe('My tasks');
    expect(document.querySelectorAll('.rail-tab[role="tab"]')).toHaveLength(3);
    expect(ui.$('#tab-tasks').getAttribute('aria-selected')).toBe('true');
    // Complete: the first done column, with the task's revision.
    const row = document.querySelector<HTMLElement>('#tasks-mine .row') as HTMLElement;
    (row.querySelector('.chk') as HTMLButtonElement).click();
    await until(async () => (await writes()).some((write) => write.kind === 'move'), 'the move');
    expect((await writes()).find((write) => write.kind === 'move')?.ifMatch).toBe('"1"');
    // Ctrl+1..3 follow the prototype's order (Chat, Tasks, Time).
    ui.key({ key: '3', ctrlKey: true });
    expect(ui.shell.module).toBe('time');
    ui.key({ key: '2', ctrlKey: true });
    expect(ui.shell.module).toBe('tasks');
    expect(JSON.parse(localStorage.getItem(SHELL_KEY) ?? '{}').module).toBe('tasks');
  });

  it('board: columns with markers, keyboard moves, a conflict and a policy refusal go back with a notice', async () => {
    const ui = await connected();
    (ui.$('[data-view="board"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('.col .card') !== null, 'the board');
    expect([...document.querySelectorAll('.col-h h2')].map((node) => node.textContent)).toEqual(['To do', 'In progress', 'Review', 'Done']);
    expect(document.querySelector('.col-emoji')?.textContent).toBe('📝');
    // UXA-38: the board switcher is a menu button; its menu groups boards by folder and checks the one shown.
    expect(accName('#tasks-board')).toBe('Board: Envelope v2');
    expect(ui.$('#tasks-board').getAttribute('aria-haspopup')).toBe('menu');
    expect(ui.$('#tasks-board-menu [aria-checked="true"]').dataset.value).toBe('b-envelope');
    expect([...document.querySelectorAll('#tasks-board-menu [role="group"]')].map((node) => node.getAttribute('aria-label'))).toEqual(['Engineering', 'Marketing']);
    const card = document.querySelector<HTMLElement>('.card[data-task="t-141"]') as HTMLElement;
    expect(card.tabIndex).toBe(0);
    expect(card.getAttribute('aria-label')).toContain('#141: Streaming parser for envelopes, priority High, due Today');
    card.focus();
    ui.key({ key: 'ArrowRight', altKey: true }, card);
    await until(() => document.querySelector('.col[data-col="env-doing"] .card[data-task="t-141"]') !== null, 'the moved card');
    await until(async () => (await writes()).some((write) => write.kind === 'move' && write.taskId === 't-141'), 'the move');
    // Someone else changed it: the next move answers 409 and the board reloads.
    await env.control('tasks/touch', { taskId: 't-142' });
    await env.control('tasks/touch', { taskId: 't-142' });
    const stale = document.querySelector<HTMLElement>('.card[data-task="t-142"]') as HTMLElement;
    stale.focus();
    ui.key({ key: 'ArrowRight', altKey: true }, stale);
    await until(() => ui.$('#tasks-banner').textContent?.includes('Changed by someone else') === true, 'the conflict notice');
    await until(() => document.querySelector('.col[data-col="env-todo"] .card[data-task="t-142"]') !== null, 'the card back');
    // The card is put back at once (BDA13-L4); the reload after it brings the other person's revision.
    await until(() => ui.tasks.columns.get('env-todo')?.tasks.find((task) => task.id === 't-142')?.revision === 3, 'the reloaded revision');
    await env.control('config', { tasksRefuseMove: true });
    const again = document.querySelector<HTMLElement>('.card[data-task="t-142"]') as HTMLElement;
    again.focus();
    ui.key({ key: 'ArrowRight', altKey: true }, again);
    await until(() => ui.$('#tasks-banner').textContent?.includes('Review takes at most 3 tasks.') === true, 'the policy message');
    await env.control('config', { tasksRefuseMove: false });
    // The refusal reloads the board: wait until it is drawn again.
    await until(() => document.querySelectorAll('.col[data-col="env-todo"] .card').length === 2, 'the reloaded board');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Arrow keys move between cards and columns; S starts the timer; Enter opens.
    const first = document.querySelector<HTMLElement>('.col[data-col="env-todo"] .card') as HTMLElement;
    first.focus();
    ui.key({ key: 'ArrowDown' }, first);
    expect(document.activeElement).not.toBe(first);
    ui.key({ key: 'ArrowRight' }, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).closest('.col')?.getAttribute('data-col')).toBe('env-doing');
    ui.key({ key: 'ArrowLeft' }, document.activeElement as HTMLElement);
    ui.key({ key: 'ArrowUp' }, document.activeElement as HTMLElement);
    const timerCard = document.activeElement as HTMLElement;
    ui.key({ key: 's' }, timerCard);
    await until(() => ui.app.state.activeTimer !== null, 'the timer');
    expect(ui.app.state.activeTimer?.taskId).toBe(timerCard.dataset.task);
    await until(() => document.querySelector(`.card.live[data-task="${timerCard.dataset.task}"]`) !== null, 'the live card');
    // Markers as colour dots (Settings).
    ui.shell.prefs.markers = 'dots';
    ui.shell.renderChrome();
    expect(document.querySelector('.col-emoji')).toBeNull();
    expect(document.querySelector('.col-dot')).not.toBeNull();
    // Only mine, another board, the list view with its status select.
    (ui.$('[data-key="only-mine"]') as HTMLButtonElement).click();
    await until(() => document.querySelectorAll('.col .card').length === 4 && [...document.querySelectorAll('.col .card')].every((node) => node.querySelector('.facepile [title="Ada Lovelace"]') !== null), 'only mine');
    ui.pick('#tasks-board', 'b-website');
    await until(() => ui.$('#tasks-title').textContent === 'Website relaunch', 'the other board');
    expect(document.activeElement?.id).toBe('tasks-board');
    (ui.$('[data-view="list"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('.tbl tbody tr:not(.tbl-group)') !== null, 'the list');
    // UXA-38: the list's status is a quiet pill with a menu (no native select left).
    expect(document.querySelector('.tbl select')).toBeNull();
    expect(accName('[data-key="status-t-149"]')).toMatch(/^Status of #149: /);
    ui.pick('[data-key="status-t-149"]', 'web-done');
    await until(async () => (await writes()).some((write) => write.kind === 'move' && write.taskId === 't-149'), 'the list move');
    await until(() => ui.$('[data-key="status-t-149"]').textContent?.includes('Done') === true, 'the moved row');
    ui.key({ key: 'Enter' }, card);
  });

  it('task panel: fields, assignee, checklist tick and add, comments; Esc closes', async () => {
    const ui = await connected();
    (document.querySelector('[data-task="t-141"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#task-detail .sub-item') !== null && document.querySelector('#task-detail .comment') !== null, 'the detail');
    expect(ui.$('#task-detail').getAttribute('aria-label')).toBe('Task #141');
    expect(ui.$<HTMLTextAreaElement>('#task-detail .dr-title').value).toBe('Streaming parser for envelopes');
    expect(ui.$('#task-detail .dr-timer b').textContent).toBe('1 h 35 min');
    expect(ui.$('#task-detail').textContent).toContain('The 4-byte case still fails');
    expect(ui.$('#task-detail').textContent).toContain('Benchmark run 482');
    expect(ui.$('#task-detail').textContent).toContain('Content not visible');
    // Title: Enter saves with If-Match.
    const title = ui.$<HTMLTextAreaElement>('#task-detail .dr-title');
    title.value = 'Streaming parser v2';
    title.dispatchEvent(new Event('input'));
    title.dispatchEvent(new Event('change'));
    await until(async () => (await writes()).some((write) => write.kind === 'patch'), 'the title');
    await until(() => ui.$<HTMLTextAreaElement>('#task-detail .dr-title').value === 'Streaming parser v2', 'the saved title');
    // UXA-17: status, priority and assignee are menu buttons with the shell's look.
    expect(document.querySelector('#task-detail select')).toBeNull();
    expect(accName('[data-key="task-status"]')).toBe('Status: To do');
    ui.pick('[data-key="task-priority"]', 'urgent');
    await until(() => accName('[data-key="task-priority"]') === 'Priority: Urgent' && ui.tasks.detail?.priority === 'urgent', 'the priority');
    const due = ui.$<HTMLInputElement>('[data-key="task-due"]');
    due.value = '2026-12-24';
    due.dispatchEvent(new Event('change'));
    await until(() => ui.tasks.detail?.dueAt === '2026-12-24T00:00:00Z', 'the due date');
    // UXA-17: one duration field, shown as on the cards; "1h30" saves 90 minutes, nonsense is refused in place.
    const estimate = () => ui.$<HTMLInputElement>('[data-key="task-estimate"]');
    expect(estimate().value).toBe('4 h');
    const patches = (await writes()).filter((write) => write.kind === 'patch').length;
    estimate().value = 'soon';
    estimate().dispatchEvent(new Event('input'));
    estimate().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(estimate().getAttribute('aria-invalid')).toBe('true');
    expect(ui.$('#task-estimate-hint').textContent).toBe('Use hours and minutes, like 4h, 90m or 1h30.');
    expect((await writes()).filter((write) => write.kind === 'patch')).toHaveLength(patches);
    estimate().value = '1h30';
    estimate().dispatchEvent(new Event('input'));
    estimate().dispatchEvent(new Event('change'));
    await until(() => ui.tasks.detail?.estimateMinutes === 90, 'the estimate');
    await until(() => estimate().value === '1 h 30 min' && estimate().getAttribute('aria-invalid') === null, 'the estimate shown');
    expect(ui.$('#task-estimate-hint').textContent).toBe('Like 4h, 90m or 1h30');
    const tags = ui.$<HTMLInputElement>('[data-key="task-tags"]');
    tags.value = 'parser, perf, release, parser';
    tags.dispatchEvent(new Event('input'));
    tags.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => ui.tasks.detail?.tags.join(',') === 'parser,perf,release', 'the tags');
    expect(ui.$('#task-assignee-menu [aria-checked="true"]').textContent).toContain('You');
    ui.pick('[data-key="task-assignee"]', 'u-maya');
    await until(() => ui.tasks.detail?.assignees.map((person) => person.id).join() === 'u-maya', 'the assignee');
    await until(() => accName('[data-key="task-assignee"]') === 'Assignee: Maya Okafor', 'the assignee shown');
    const second = [...document.querySelectorAll<HTMLButtonElement>('#task-detail .sub-item .chk')][1];
    expect(second.getAttribute('aria-checked')).toBe('false');
    second.click();
    await until(async () => (await writes()).some((write) => write.kind === 'checklist-tick' && write.done === true), 'the tick');
    await until(() => document.querySelectorAll('#task-detail .sub-item .chk[aria-checked="true"]').length === 2, 'two ticked');
    const add = ui.$<HTMLInputElement>('#task-detail .add-item');
    add.value = 'Release notes';
    add.dispatchEvent(new Event('input'));
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => document.querySelectorAll('#task-detail .sub-item').length === 3, 'the new item');
    // Start the timer from the panel; the board marks the task.
    (ui.$('#task-timer') as HTMLButtonElement).click();
    await until(() => ui.app.state.activeTimer?.taskId === 't-141', 'the timer');
    await until(() => ui.$('#task-timer').textContent?.includes('Stop timer') === true, 'the stop button');
    ui.$('#task-detail').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('#task-detail')).toBeNull();
  });

  it('quick add (N, syntax, Ctrl+Enter starts the timer), polling picks up changes, module_forbidden hides the module', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
    try {
      const ui = await connected('es');
      expect(ui.$('#tasks-title').textContent).toBe('Mis tareas');
      ui.key({ key: 'n' });
      expect(document.activeElement?.id).toBe('qa-input');
      const input = ui.$<HTMLInputElement>('#qa-input');
      // UXA-18: Spanish words for the tokens (the English ones work too), shown in the placeholder and help.
      expect(input.placeholder).toContain('!alta');
      expect(input.placeholder).toContain('@mañana');
      expect(ui.$('#qa-help').textContent).toContain('@hoy o @mañana');
      input.value = 'Preparar demo !alta #demo @mañana ~1h30';
      input.dispatchEvent(new Event('input'));
      expect([...document.querySelectorAll('.qa-preview .pill')].map((node) => node.textContent)).toEqual(['Alta', 'Mañana', '1 h 30 min']);
      input.value = 'Revisar !baja';
      input.dispatchEvent(new Event('input'));
      expect(ui.$('.qa-preview').textContent).toBe('Baja');
      input.value = 'Preparar demo !alta #demo @mañana ~2h';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      await until(async () => (await writes()).some((write) => write.kind === 'create'), 'the create');
      await until(() => ui.app.state.activeTimer !== null, 'the timer on the new task');
      await until(() => [...document.querySelectorAll('#tasks-mine .row .t')].some((node) => node.textContent === 'Preparar demo'), 'the new row');
      expect(ui.tasks.mine.find((task) => task.title === 'Preparar demo')).toMatchObject({ priority: 'high', estimateMinutes: 120, tags: ['demo'] });
      expect(input.value).toBe('');
      // Polling: someone renames a task of mine; the next round (60 s on My tasks) shows it.
      expect(ui.tasks.nextPollDelay()).toBe(POLL_MINE_MS);
      await env.control('tasks/touch', { taskId: 't-144', title: 'UTF-8 fixtures (renamed)' });
      await vi.advanceTimersByTimeAsync(POLL_MINE_MS + 10);
      await until(() => [...document.querySelectorAll('#tasks-mine .row .t')].some((node) => node.textContent === 'UTF-8 fixtures (renamed)'), 'the renamed task');
      ui.shell.show('time');
      expect(ui.tasks.nextPollDelay()).toBe(POLL_HIDDEN_MS);
      ui.shell.show('tasks');
      (ui.$('[data-view="board"]') as HTMLButtonElement).click();
      await until(() => document.querySelector('.card') !== null, 'the board');
      expect(ui.tasks.nextPollDelay()).toBe(POLL_SHOWN_MS);
      // module_forbidden: the tab goes, the token stays, Chat is shown.
      await env.control('config', { tasksForbidden: true });
      await vi.advanceTimersByTimeAsync(POLL_SHOWN_MS + 10);
      await until(() => ui.shell.tasksHidden, 'the hidden module');
      expect(document.querySelector('#tab-tasks')).toBeNull();
      expect(ui.shell.module).toBe('chat');
      expect(ui.platform.hooks.tasksToken).not.toBeNull();
      expect(landingModule({ ...loadShellPrefs(undefined), module: 'tasks' }, false, true)).toBe('chat');
      // Back on: the next start shows the tab again.
      await env.control('config', { tasksForbidden: false });
      await ui.tasks.reload();
      expect(ui.shell.tasksHidden).toBe(false);
      expect(document.querySelector('#tab-tasks')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a revoked tasks token disconnects tasks only; Settings disconnects and connects; sign-out forgets everything', async () => {
    const ui = await connected();
    await env.control('config', { tasksFailNext: { status: 401, error: 'invalid_token' } });
    await ui.tasks.reload();
    await until(() => document.querySelector('#tasks-connect') !== null, 'the connect card');
    expect(document.querySelector('#tasks-connect-card .cc-error')?.textContent).toContain('disconnected');
    expect(ui.app.state.session).not.toBeNull();
    ui.$<HTMLButtonElement>('#tasks-connect').click();
    await until(() => ui.$('#tasks-user-code') !== null, 'the code');
    ui.$<HTMLButtonElement>('#tasks-cancel').click();
    expect(document.querySelector('#tasks-connect')).not.toBeNull();
    ui.shell.openSettings();
    (ui.$('#settings-tasks-connect') as HTMLButtonElement).click();
    await until(() => ui.$('#tasks-user-code') !== null, 'the code again');
    await env.control('device/approve', { userCode: ui.$('#tasks-user-code').textContent });
    await until(() => ui.tasks.connected && document.querySelector('#tasks-mine .row') !== null, 'connected again');
    ui.shell.openSettings();
    (ui.$('#shell-settings [aria-label="Column markers"] [data-value="dots"]') as HTMLButtonElement).click();
    expect(ui.shell.prefs.markers).toBe('dots');
    // Disconnect (Account) asks first (UX batch 6).
    (ui.$('#tasks-disconnect') as HTMLButtonElement).click();
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the confirmation');
    expect(ui.$('#shell-confirm-title').textContent).toBe('Disconnect tasks?');
    ui.$<HTMLButtonElement>('#confirm-ok').click();
    await until(() => !ui.tasks.connected, 'disconnected');
    expect(ui.platform.hooks.tasksToken).toBeNull();
    ui.shell.openKeys();
    expect(ui.$('#shell-keys').textContent).toContain('Quick add');
  });

  it('banner (UXA-15): one message at a time, a refusal clears on the next successful write, a 429 on the next answer, dismiss', async () => {
    const ui = await connected();
    const banner = () => ui.$('#tasks-banner');
    (ui.$('[data-view="board"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('.col .card') !== null, 'the board');
    await env.control('config', { tasksRefuseMove: true });
    let card = document.querySelector<HTMLElement>('.card[data-task="t-142"]') as HTMLElement;
    card.focus();
    ui.key({ key: 'ArrowRight', altKey: true }, card);
    await until(() => banner().textContent?.includes('Review takes at most 3 tasks.') === true, 'the refusal');
    expect(banner().hidden).toBe(false);
    expect(banner().className).toBe('tk-banner warn');
    // A later read does not clear it: only a write that goes through does.
    await ui.tasks.reload();
    expect(banner().textContent).toContain('Review takes at most 3 tasks.');
    await env.control('config', { tasksRefuseMove: false });
    await until(() => document.querySelector('.col[data-col="env-todo"] .card[data-task="t-142"]') !== null, 'the card back');
    card = document.querySelector<HTMLElement>('.card[data-task="t-143"]') as HTMLElement;
    card.focus();
    ui.key({ key: 'ArrowRight', altKey: true }, card);
    await until(async () => (await writes()).some((write) => write.kind === 'move' && write.taskId === 't-143'), 'the move');
    await until(() => banner().hidden === true, 'the cleared banner');
    expect(ui.tasks.notice).toBeNull();
    // A 429: "slowing down" until Beacon answers again (not for the whole session).
    await env.control('config', { tasksFailNext: { status: 429, error: 'rate_limited', retryAfter: 1 } });
    await ui.tasks.reload();
    expect(banner().textContent).toContain('Slowing down for a moment');
    expect(ui.tasks.noticeKind).toBe('rate');
    // Offline at the same time: one message, the more severe one, never both joined.
    net.online = false;
    await ui.tasks.reload();
    expect(banner().querySelectorAll('.tb-msg')).toHaveLength(1);
    expect(banner().textContent).toContain('You are offline.');
    expect(banner().textContent).not.toContain('Slowing down');
    net.online = true;
    await ui.tasks.reload();
    await until(() => banner().hidden === true, 'back online and answered');
    expect(ui.tasks.notice).toBeNull();
    // A server error offers Retry and can be dismissed; it stays hidden until the message changes.
    await env.control('config', { tasksFailNext: { status: 500, error: 'server_error' } });
    await ui.tasks.reload();
    expect(banner().className).toBe('tk-banner danger');
    expect(document.querySelector('#tasks-retry')).not.toBeNull();
    (ui.$('#tasks-banner-dismiss') as HTMLButtonElement).focus();
    (ui.$('#tasks-banner-dismiss') as HTMLButtonElement).click();
    expect(banner().hidden).toBe(true);
    expect(document.activeElement?.closest('#tasks-root')).not.toBeNull();
    await ui.tasks.poll();
    expect(banner().hidden).toBe(true);
    // A dismissed notice goes for good.
    await env.control('config', { tasksRefuseMove: true });
    card = document.querySelector<HTMLElement>('.card[data-task="t-142"]') as HTMLElement;
    card.focus();
    ui.key({ key: 'ArrowRight', altKey: true }, card);
    await until(() => banner().textContent?.includes('Review takes at most 3 tasks.') === true && !banner().hidden, 'the refusal again');
    (ui.$('#tasks-banner-dismiss') as HTMLButtonElement).click();
    expect(ui.tasks.notice).toBeNull();
    expect(banner().hidden).toBe(true);
    ui.tasks.dismissBanner();
    expect(banner().hidden).toBe(true);
  });

  it('banner (UXA-15): a notice goes on its own after NOTICE_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
    try {
      const ui = await connected();
      (ui.$('[data-view="board"]') as HTMLButtonElement).click();
      await until(() => document.querySelector('.col .card') !== null, 'the board');
      await env.control('config', { tasksRefuseMove: true });
      const card = document.querySelector<HTMLElement>('.card[data-task="t-142"]') as HTMLElement;
      card.focus();
      ui.key({ key: 'ArrowRight', altKey: true }, card);
      await until(() => ui.$('#tasks-banner').textContent?.includes('Review takes at most 3 tasks.') === true, 'the refusal');
      await vi.advanceTimersByTimeAsync(NOTICE_MS - 500);
      expect(ui.$('#tasks-banner').hidden).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(ui.$('#tasks-banner').hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('menus (UXA-17/38): keyboard open enters the checked item, arrows, Home/End, type-ahead, Esc returns focus, one at a time', async () => {
    const ui = await connected();
    (document.querySelector('[data-task="t-141"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#task-detail .sub-item') !== null, 'the detail');
    const trigger = ui.$<HTMLButtonElement>('[data-key="task-priority"]');
    const menu = ui.$('#task-priority-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect([...menu.querySelectorAll('[role="menuitemradio"]')].map((node) => node.textContent)).toEqual(['Urgent', 'High', 'Normal', 'Low']);
    // Enter / Space: a click with detail 0 enters the menu at the checked item.
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect((document.activeElement as HTMLElement).dataset.value).toBe('high');
    ui.key({ key: 'ArrowDown' }, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('normal');
    ui.key({ key: 'End' }, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('low');
    ui.key({ key: 'ArrowDown' }, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('urgent');
    ui.key({ key: 'ArrowUp' }, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('low');
    ui.key({ key: 'Home' }, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('urgent');
    // Type-ahead; a printable key never reaches the module (N would jump to quick add).
    ui.key({ key: 'n' }, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('normal');
    expect(document.activeElement?.id).not.toBe('qa-input');
    ui.key({ key: 'z' }, document.activeElement as HTMLElement);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('normal');
    // Esc closes the menu only (the panel stays) and focus goes back to the button.
    ui.key({ key: 'Escape' }, document.activeElement as HTMLElement);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('#task-detail')).not.toBeNull();
    // ArrowUp on the button opens at the last item; a pointer click on the open button closes it.
    ui.key({ key: 'ArrowUp' }, trigger);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('low');
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(menu.hidden).toBe(true);
    // A pointer open keeps focus on the button; ArrowDown then enters.
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(menu.hidden).toBe(false);
    expect(document.activeElement).toBe(trigger);
    // Esc with focus still on the button closes the menu, not the panel.
    ui.key({ key: 'Escape' }, trigger);
    expect(menu.hidden).toBe(true);
    expect(document.querySelector('#task-detail')).not.toBeNull();
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    ui.key({ key: 'ArrowDown' }, trigger);
    expect((document.activeElement as HTMLElement).dataset.value).toBe('high');
    // Opening another menu closes this one; a click outside closes that one.
    ui.$<HTMLButtonElement>('[data-key="task-assignee"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    expect(menu.hidden).toBe(true);
    expect(ui.$('#task-assignee-menu').hidden).toBe(false);
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(ui.$('#task-assignee-menu').hidden).toBe(true);
    // A scroll moves an open menu with its button (it stays open); Tab leaves it.
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    document.querySelector('#task-detail .dr-body')?.dispatchEvent(new Event('scroll'));
    expect(menu.hidden).toBe(false);
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    ui.key({ key: 'Tab' }, document.activeElement as HTMLElement);
    expect(menu.hidden).toBe(true);
    // A refresh while a menu is open (a poll, a save) keeps it open, with focus on the same item.
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    ui.key({ key: 'ArrowDown' }, document.activeElement as HTMLElement);
    ui.tasks.render();
    const again = ui.$('#task-priority-menu');
    expect(again).not.toBe(menu);
    expect(again.hidden).toBe(false);
    expect(ui.$('[data-key="task-priority"]').getAttribute('aria-expanded')).toBe('true');
    expect((document.activeElement as HTMLElement).dataset.value).toBe('normal');
    ui.key({ key: 'Escape' }, document.activeElement as HTMLElement);
    expect(again.hidden).toBe(true);
    // Pointer-opened (focus on the button): still open after a refresh.
    ui.$<HTMLButtonElement>('[data-key="task-priority"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    ui.tasks.render();
    expect(ui.$('#task-priority-menu').hidden).toBe(false);
    ui.key({ key: 'Escape' }, ui.$('[data-key="task-priority"]'));
    expect(ui.$('#task-priority-menu').hidden).toBe(true);
    // Picking the current value writes nothing.
    const before = (await writes()).length;
    ui.pick('[data-key="task-priority"]', 'high');
    expect((await writes()).length).toBe(before);
    expect(document.activeElement).toBe(ui.$('[data-key="task-priority"]'));
    // The status menu moves the task.
    ui.pick('[data-key="task-status"]', 'env-doing');
    await until(() => accName('[data-key="task-status"]') === 'Status: In progress', 'the new status');
  });

  it('task panel (UXA-17/40): due date shortcuts, the breadcrumb shows the board, the narrow overflow menu', async () => {
    const ui = await connected();
    (document.querySelector('[data-task="t-141"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#task-detail .sub-item') !== null, 'the detail');
    const chips = () => [...document.querySelectorAll<HTMLButtonElement>('#task-detail .chips .chip')];
    expect(ui.$('#task-detail .chips').getAttribute('aria-label')).toBe('Due date shortcuts');
    expect(chips().map((chip) => chip.textContent)).toEqual(['Today', 'Tomorrow', 'Next week', 'Clear']);
    expect(chips()[0].getAttribute('aria-pressed')).toBe('true');
    const today = new Date();
    const iso = (days: number) => new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + days)).toISOString().slice(0, 10);
    // Today again: nothing to write.
    const before = (await writes()).length;
    chips()[0].click();
    expect((await writes()).length).toBe(before);
    chips()[1].click();
    await until(() => ui.tasks.detail?.dueAt === `${iso(1)}T00:00:00Z`, 'tomorrow');
    await until(() => chips()[1].getAttribute('aria-pressed') === 'true', 'the pressed chip');
    chips()[2].click();
    const weekday = new Date(`${iso(0)}T00:00:00Z`).getUTCDay();
    await until(() => ui.tasks.detail?.dueAt === `${iso((8 - weekday) % 7 || 7)}T00:00:00Z`, 'next Monday');
    expect(new Date(ui.tasks.detail?.dueAt as string).getUTCDay()).toBe(1);
    chips()[3].click();
    await until(() => ui.tasks.detail?.dueAt === null, 'cleared');
    await until(() => chips().length === 3, 'no Clear without a date');
    // UXA-40: "Envelope v2 › #141"; the board name opens the board with the panel kept open.
    expect(ui.$('#task-detail .crumbs').textContent).toBe('Envelope v2›#141');
    expect(ui.$('#task-board-link').getAttribute('aria-label')).toBe('Open the board Envelope v2');
    expect(ui.tasks.prefs.view).toBe('mine');
    ui.$<HTMLButtonElement>('#task-board-link').click();
    await until(() => document.querySelector('.col .card[data-task="t-141"]') !== null, 'the board');
    expect(ui.tasks.prefs.view).toBe('board');
    expect(document.querySelector('#task-detail')).not.toBeNull();
    expect((document.activeElement as HTMLElement).dataset.task).toBe('t-141');
    // On the board already: it only focuses the card.
    ui.$<HTMLButtonElement>('#task-board-link').click();
    expect((document.activeElement as HTMLElement).dataset.task).toBe('t-141');
    // UXA-16: the overflow menu holds Only mine (checkable) and Open in Beacon.
    const more = ui.$<HTMLButtonElement>('#tasks-more');
    expect(more.getAttribute('aria-label')).toBe('More actions');
    expect([...document.querySelectorAll('#tasks-more-menu [role^="menuitem"]')].map((node) => `${node.getAttribute('role')}:${node.textContent}`)).toEqual(['menuitemcheckbox:Only mine', 'menuitem:Open in Beacon']);
    ui.pick('#tasks-more', 'only-mine');
    await until(() => ui.tasks.prefs.onlyMine && ui.$('#tasks-more-menu [data-value="only-mine"]').getAttribute('aria-checked') === 'true', 'only mine');
    expect(ui.$('[data-key="only-mine"]').getAttribute('aria-pressed')).toBe('true');
    ui.pick('#tasks-more', 'open');
    // Through the chat's checked opener since BDA13-I2 (asynchronous).
    await until(() => ui.platform.hooks.chatLinks.length > 0, 'the opened board');
    expect(ui.platform.hooks.chatLinks.at(-1)).toMatch(/\/dashboard\/tasks\/boards\/b-envelope$/);
  });
});

describe('tasks module: answers from before an organization switch (BDA13-M1) and write order (BDA13-L4)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
  });

  /** Switches the app and waits until the Tasks module reloaded there (its own switch comes after the time API's). */
  async function switchTo(ui: Awaited<ReturnType<typeof connected>>, target: string): Promise<void> {
    ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${target}"]`).click();
    await until(() => ui.shell.context === target && ui.tasks.api?.currentContext === target, `the switch to ${target}`);
    await until(() => (ui.tasks.prefs.view === 'mine' ? ui.tasks.mineLoaded : ui.tasks.boardsLoaded), `the tasks of ${target}`);
  }
  const toPersonal = (ui: Awaited<ReturnType<typeof connected>>) => switchTo(ui, 'personal');

  const tasksText = () => document.querySelector('#tasks-root')?.textContent ?? '';

  it('a task opened before the switch never comes back into the new organization (refreshDetail, comments)', async () => {
    const ui = await connected();
    const gate = hold((url, init) => (init.method ?? 'GET') === 'GET' && route(url) === 'tasks/t-141');
    (document.querySelector('[data-task="t-141"]') as HTMLButtonElement).click();
    await until(() => gate.hit, 'the task request');
    await toPersonal(ui);
    expect(ui.tasks.detail).toBeNull();
    gate.release();
    await settle();
    expect(ui.tasks.detail).toBeNull();
    expect(document.querySelector('#task-detail')).toBeNull();
    expect(ui.tasks.comments).toBeNull();
    expect(ui.tasks.boardDetails.has('b-envelope')).toBe(false);
    expect(tasksText()).not.toContain('Streaming parser for envelopes');
  });

  it('a poll answered after the switch keeps the new cursor and loads nothing (poll)', async () => {
    const ui = await connected();
    const cursor = () => (ui.tasks as unknown as { cursor: string | null }).cursor;
    const gate = hold((url) => route(url) === 'changes', () => made(200, { changes: [{ taskId: 't-141', boardId: 'b-envelope', revision: 9 }], nextCursor: 'STALE', reset: true }));
    const polled = ui.tasks.poll();
    await until(() => gate.hit, 'the poll');
    await toPersonal(ui);
    await until(() => cursor() !== null, 'the new cursor');
    const fresh = cursor();
    gate.release();
    await polled;
    await settle();
    expect(cursor()).toBe(fresh);
    expect(cursor()).not.toBe('STALE');
    expect(ui.tasks.mine.some((task) => task.boardId === 'b-envelope')).toBe(false);
  });

  it('a column page answered after the switch is not put into the new board (loadMore)', async () => {
    const ui = await connected();
    (ui.$('[data-view="board"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('.col .card') !== null, 'the board');
    const page = ui.tasks.columns.get('env-todo');
    expect(page).toBeDefined();
    ui.tasks.columns.set('env-todo', { tasks: page?.tasks ?? [], nextCursor: 'more' });
    ui.tasks.render();
    const gate = hold((url) => route(url) === 'boards/b-envelope/tasks' && new URL(url).searchParams.get('cursor') === 'more');
    (document.querySelector('.col[data-col="env-todo"] .col-more') as HTMLButtonElement).click();
    await until(() => gate.hit, 'the next page');
    await toPersonal(ui);
    await until(() => ui.tasks.columns.size > 0, 'the Personal board');
    gate.release();
    await settle();
    expect(ui.tasks.columns.has('env-todo')).toBe(false);
    expect([...ui.tasks.columns.keys()].every((key) => key.startsWith('pe-'))).toBe(true);
    expect(document.querySelector('.col[data-col="env-todo"]')).toBeNull();
  });

  it('a 401 from before the switch keeps the token; a stale 403 neither hides the module nor refuses the new context (call)', async () => {
    const ui = await connected();
    for (const [status, error] of [
      [401, 'invalid_token'],
      [403, 'module_forbidden'],
      [403, 'context_forbidden'],
    ] as const) {
      const gate = hold((url) => route(url) === 'my-tasks', () => made(status, { ok: false, error }));
      const reloaded = ui.tasks.reload();
      await until(() => gate.hit, `the held ${error}`);
      // Away and back: a new generation in the same organization (the answer is still stale).
      await switchTo(ui, ui.shell.context === 'personal' ? ORG : 'personal');
      gate.release();
      await reloaded;
      await settle();
      expect(ui.tasks.connected, error).toBe(true);
      expect(ui.platform.hooks.tasksToken, error).not.toBeNull();
      expect(ui.tasks.forbidden, error).toBe(false);
      expect(ui.shell.tasksHidden, error).toBe(false);
      expect(ui.tasks.contextRefused, error).toBe(false);
      expect(document.querySelector('#tasks-connect'), error).toBeNull();
    }
    // The same answers on a current request still act (nothing weakened): a 401 disconnects tasks.
    const gate = hold((url) => route(url) === 'my-tasks', () => made(401, { ok: false, error: 'invalid_token' }));
    gate.release();
    await ui.tasks.reload();
    expect(gate.hit).toBe(true);
    await until(() => !ui.tasks.connected, 'disconnected');
    expect(ui.platform.hooks.tasksToken).toBeNull();
  });

  it('two quick edits of one task go out one after the other with the fresh revision (no false conflict)', async () => {
    const ui = await connected();
    (document.querySelector('[data-task="t-141"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#task-detail .comment') !== null, 'the detail');
    const gate = hold((url, init) => init.method === 'PATCH' && route(url) === 'tasks/t-141');
    const first = ui.tasks.save({ priority: 'urgent' });
    const second = ui.tasks.save({ estimateMinutes: 90 });
    await until(() => gate.hit, 'the first edit');
    await settle();
    // The second waits for the first answer.
    expect((await writes()).filter((write) => write.kind === 'patch')).toHaveLength(0);
    gate.release();
    await Promise.all([first, second]);
    const patches = (await writes()).filter((write) => write.kind === 'patch' && write.taskId === 't-141');
    expect(patches).toHaveLength(2);
    expect(Number(patches[1].ifMatch?.replaceAll('"', ''))).toBe(Number(patches[0].ifMatch?.replaceAll('"', '')) + 1);
    expect(ui.tasks.detail?.priority).toBe('urgent');
    expect(ui.tasks.detail?.estimateMinutes).toBe(90);
    expect(ui.$('#tasks-banner').textContent).not.toContain('Changed by someone else');
    // Two ticks of one checklist item: the second with the item's new revision.
    await Promise.all([ui.tasks.tick('ci-2', true), ui.tasks.tick('ci-2', false)]);
    const ticks = (await writes()).filter((write) => write.kind === 'checklist-tick');
    expect(ticks.map((write) => write.done)).toEqual([true, false]);
    expect(ui.tasks.detail?.checklists.flatMap((list) => list.items).find((entry) => entry.id === 'ci-2')?.done).toBe(false);
    expect(ui.$('#tasks-banner').textContent).not.toContain('Changed by someone else');
  });

  it('an assignee change interrupted by a switch sends nothing more under the new context (BDA13-V1)', async () => {
    const ui = await connected();
    (document.querySelector('[data-task="t-141"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#task-detail .comment') !== null, 'the detail');
    const gate = hold((url, init) => init.method === 'DELETE' && route(url).startsWith('tasks/t-141/members/'));
    const assigning = ui.tasks.assign('u-maya');
    await until(() => gate.hit, 'the first member call');
    await switchTo(ui, 'personal');
    gate.release();
    await assigning;
    await settle();
    const state = (await env.control('state')) as { requests: { method: string; path: string }[] };
    expect(state.requests.filter((request) => request.path.includes('/members/') && request.method === 'DELETE')).toHaveLength(1);
    expect(state.requests.filter((request) => request.path.includes('/members/') && request.method === 'PUT')).toHaveLength(0);
    expect((await writes()).filter((write) => write.kind === 'member').map((write) => write.method)).toEqual(['DELETE']);
    expect(ui.tasks.detail).toBeNull();
    expect(ui.$('#tasks-banner').textContent).not.toContain('Not saved');
  });

  it('a queued edit uses the last saved revision even when the panel shows another task meanwhile (BDA13-V2)', async () => {
    const ui = await connected();
    (document.querySelector('[data-task="t-141"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#task-detail .comment') !== null, 'the detail');
    const gate = hold((url, init) => init.method === 'PATCH' && route(url) === 'tasks/t-141');
    const first = ui.tasks.save({ priority: 'urgent' });
    const second = ui.tasks.save({ estimateMinutes: 45 });
    await until(() => gate.hit, 'the first edit');
    // The panel moves to another task while the first edit is on its way.
    await ui.tasks.openTask('t-144');
    expect(ui.tasks.detail?.id).toBe('t-144');
    gate.release();
    await Promise.all([first, second]);
    const patches = (await writes()).filter((write) => write.kind === 'patch' && write.taskId === 't-141');
    expect(patches).toHaveLength(2);
    expect(Number(patches[1].ifMatch?.replaceAll('"', ''))).toBe(Number(patches[0].ifMatch?.replaceAll('"', '')) + 1);
    expect(ui.$('#tasks-banner').textContent).not.toContain('Changed by someone else');
    expect(ui.tasks.mine.find((task) => task.id === 't-141')?.priority).toBe('urgent');
  });

  it('a refused move puts the card back even when the reload fails (offline)', async () => {
    const ui = await connected();
    (ui.$('[data-view="board"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('.col[data-col="env-todo"] .card[data-task="t-142"]') !== null, 'the board');
    hold(
      (url, init) => init.method === 'POST' && route(url) === 'tasks/t-142/move',
      () => {
        offline.on = true;
        return made(409, { ok: false, error: 'conflict', currentRevision: 7 });
      },
    ).release();
    await ui.tasks.move('t-142', 'env-doing');
    await settle();
    // The refusal is kept and announced; the banner shows the most severe message first (UX batch 1, UXA-15): offline.
    expect(ui.tasks.notice).toContain('Changed by someone else');
    expect(ui.$('#tasks-banner').textContent).toContain('You are offline');
    expect(document.querySelector('.col[data-col="env-todo"] .card[data-task="t-142"]')).not.toBeNull();
    expect(document.querySelector('.col[data-col="env-doing"] .card[data-task="t-142"]')).toBeNull();
    expect(ui.tasks.columns.get('env-doing')?.tasks.some((task) => task.id === 't-142')).toBe(false);
  });

  it('kanban drag and drop: the main window leaves HTML5 drops to the page (BDA13-I3)', () => {
    const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { app: { windows: { label: string; dragDropEnabled?: boolean }[] } };
    expect(conf.app.windows.find((window) => window.label === 'main')?.dragDropEnabled).toBe(false);
  });

  it('links in task text open through the chat opener (http, mailto); a failure is shown (BDA13-I2)', async () => {
    const ui = await connected();
    (document.querySelector('[data-task="t-141"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('#task-detail .comment') !== null, 'the detail');
    const deps = (ui.tasks as unknown as { deps: { openLink(url: string): void } }).deps;
    deps.openLink('http://intranet.example/spec');
    deps.openLink('mailto:maya@example.com');
    await until(() => ui.platform.hooks.chatLinks.length === 2, 'the opened links');
    expect(ui.platform.hooks.chatLinks).toEqual(['http://intranet.example/spec', 'mailto:maya@example.com']);
    const chat = ui.platform.chat as NonNullable<typeof ui.platform.chat>;
    const original = chat.openLink;
    chat.openLink = async () => {
      throw new Error('refused');
    };
    try {
      deps.openLink('http://intranet.example/x');
      await until(() => ui.$('#tasks-banner').textContent?.includes('That link could not be opened.') === true, 'the failure notice');
    } finally {
      chat.openLink = original;
    }
  });
});
