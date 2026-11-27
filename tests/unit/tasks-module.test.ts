// @vitest-environment happy-dom
// The Tasks module (BD-3b) through the DOM against the in-process mock Beacon (TimeTrack + ChatKit + TaskBoard): connect
// tasks, My tasks, the board and the list, moves (keyboard, conflict, policy refusal), the task panel's edits and
// checklists, quick add, a timer from a task, polling through `changes`, and `module_forbidden` hiding the module.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { landingModule, loadShellPrefs, SHELL_KEY, Shell } from '../../src/shell/shell';
import { POLL_HIDDEN_MS, POLL_MINE_MS, POLL_SHOWN_MS } from '../../src/tasks/module';
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
type Writes = { writes: { kind: string; taskId?: string; ifMatch?: string; done?: boolean; method?: string }[] };
const writes = async () => ((await env.control('tasks/state')) as Writes).writes;

async function connected(locale: 'en' | 'es' = 'en') {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.1.0', nodeFetch);
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
  return { root, platform, shell, app, $, key, tasks: shell.tasks as NonNullable<Shell['tasks']> };
}

describe('tasks module', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
  });

  it('connects with the tasks family, lands on My tasks, groups by due date, completes a task', async () => {
    const ui = await connected();
    expect(ui.platform.hooks.tasksConnectBegins).toBe(1);
    const state = (await env.control('state')) as { requests: { path: string; body: string }[] };
    expect(JSON.parse(state.requests.filter((item) => item.path.endsWith('device/code')).at(-1)?.body ?? '{}')).toMatchObject({ family: 'tasks', scopes: ['task-board:read', 'task-board:write'] });
    expect([...document.querySelectorAll('#tasks-mine h3')].map((node) => node.textContent?.replace(/·.*/, '').trim())).toEqual(['Overdue', 'Today', 'Upcoming', 'No date', 'To review']);
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
    expect([...document.querySelectorAll('.col-h h3')].map((node) => node.textContent)).toEqual(['To do', 'In progress', 'Review', 'Done']);
    expect(document.querySelector('.col-emoji')?.textContent).toBe('📝');
    expect((ui.$('#tasks-board') as HTMLSelectElement).value).toBe('b-envelope');
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
    const select = ui.$<HTMLSelectElement>('#tasks-board');
    select.value = 'b-website';
    select.dispatchEvent(new Event('change'));
    await until(() => ui.$('#tasks-title').textContent === 'Website relaunch', 'the other board');
    (ui.$('[data-view="list"]') as HTMLButtonElement).click();
    await until(() => document.querySelector('.tbl tbody tr:not(.tbl-group)') !== null, 'the list');
    const status = document.querySelector<HTMLSelectElement>('.tbl select') as HTMLSelectElement;
    status.value = 'web-done';
    status.dispatchEvent(new Event('change'));
    await until(async () => (await writes()).some((write) => write.kind === 'move' && write.taskId === 't-149'), 'the list move');
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
    const priority = ui.$<HTMLSelectElement>('[data-key="task-priority"]');
    priority.value = 'urgent';
    priority.dispatchEvent(new Event('change'));
    await until(() => ui.$<HTMLSelectElement>('[data-key="task-priority"]').value === 'urgent' && ui.tasks.detail?.priority === 'urgent', 'the priority');
    const due = ui.$<HTMLInputElement>('[data-key="task-due"]');
    due.value = '2026-12-24';
    due.dispatchEvent(new Event('change'));
    await until(() => ui.tasks.detail?.dueAt === '2026-12-24T00:00:00Z', 'the due date');
    const estimate = ui.$<HTMLInputElement>('[data-key="task-estimate"]');
    estimate.value = '120';
    estimate.dispatchEvent(new Event('input'));
    estimate.dispatchEvent(new Event('change'));
    await until(() => ui.tasks.detail?.estimateMinutes === 120, 'the estimate');
    const tags = ui.$<HTMLInputElement>('[data-key="task-tags"]');
    tags.value = 'parser, perf, release, parser';
    tags.dispatchEvent(new Event('input'));
    tags.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => ui.tasks.detail?.tags.join(',') === 'parser,perf,release', 'the tags');
    const assignee = ui.$<HTMLSelectElement>('[data-key="task-assignee"]');
    assignee.value = 'u-maya';
    assignee.dispatchEvent(new Event('change'));
    await until(() => ui.tasks.detail?.assignees.map((person) => person.id).join() === 'u-maya', 'the assignee');
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
      input.value = 'Preparar demo !high #demo @tomorrow ~2h';
      input.dispatchEvent(new Event('input'));
      expect(ui.$('.qa-preview').textContent).toContain('Alta');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      await until(async () => (await writes()).some((write) => write.kind === 'create'), 'the create');
      await until(() => ui.app.state.activeTimer !== null, 'the timer on the new task');
      await until(() => [...document.querySelectorAll('#tasks-mine .row .t')].some((node) => node.textContent === 'Preparar demo'), 'the new row');
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
});
