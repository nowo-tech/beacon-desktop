// @vitest-environment happy-dom
// UX batches 2 + 3: copy and i18n (UXA-14, 19, 20, 21, 32, 43) and the shell's keyboard and accessibility (UXA-3, 10,
// 27; owner item "global shortcuts in every module"), against the in-process mock Beacon.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../../src/platform';
import { SHELL_KEY, Shell } from '../../src/shell/shell';
import { mergeSwitch, scoreItems, type SwitchItem } from '../../src/shell/switcher';
import { shellText } from '../../src/shell/i18n';
import { chatText } from '../../src/chat/i18n';
import { tasksText } from '../../src/tasks/i18n';
import { createTranslator } from '../../src/lib/i18n';
import { DesktopApp } from '../../src/ui/app';
import { Roving } from '../../src/ui/roving';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const MAYA = '0c000000-0000-4000-8000-000000000006';

async function until(ready: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function onTime(options: { locale?: 'en' | 'es'; now?: () => Date } = {}) {
  localStorage.setItem(SHELL_KEY, JSON.stringify({ module: 'time', setup: 'done' }));
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const locale = options.locale ?? 'en';
  const platform = browserPlatform('0.1.0', nodeFetch);
  const shell = new Shell(root, platform, { locale, storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, {
    storage: localStorage,
    locale,
    onRender: () => shell.onAppRender(),
    beforeSignOut: () => shell.chat.revokeOnServer(),
    askAllocation: (request) => shell.askAllocation(request),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
    viewportWidth: () => 1280,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  shell.attach(app);
  shell.freshSignIn = false;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  const key = (init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  await app.init();
  const done = app.connect(env.url);
  await until(() => $('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  await until(() => shell.root.dataset.bare === 'false', 'the shell');
  await until(() => $('#tasks li') !== null, 'the task list');
  return { shell, app, platform, $, key };
}

type Ui = Awaited<ReturnType<typeof onTime>>;

async function withChat(ui: Ui) {
  ui.$<HTMLButtonElement>('#tab-chat').click();
  ui.$<HTMLButtonElement>('#chat-connect').click();
  await until(() => ui.$('#chat-user-code') !== null, 'the chat code');
  await env.control('device/approve', { userCode: ui.$('#chat-user-code').textContent });
  await until(() => ui.$('.side .conv') !== null, 'the conversations');
  ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
  await until(() => ui.$(`[data-conv="${MAYA}"]`) !== null, 'the organization list');
}

async function withTasks(ui: Ui) {
  if (ui.shell.context !== ORG) {
    ui.$<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
    await until(() => ui.shell.context === ORG, 'the organization');
  }
  ui.$<HTMLButtonElement>('#tab-tasks').click();
  ui.$<HTMLButtonElement>('#tasks-connect').click();
  await until(() => ui.$('#tasks-user-code') !== null, 'the tasks code');
  await env.control('device/approve', { userCode: ui.$('#tasks-user-code').textContent });
  await until(() => ui.$('#tasks-mine .row') !== null, 'My tasks');
}

const options = () => [...document.querySelectorAll<HTMLElement>('#sw-list .opt')];
const sheet = () => [...document.querySelectorAll('#shell-keys h2')].map((node) => node.textContent);

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  await env.control('reset', {});
  await env.control('config', { deviceInterval: 1, contextPolicy: { required: false, refuse: [] } });
});

describe('copy and plurals (UX batch 2)', () => {
  it('picks zero / one / other forms, so no "action(s)" and no count of 0', () => {
    const en = createTranslator('en');
    const es = createTranslator('es');
    expect(en('offline', { count: 0 })).toBe('Offline. Your changes will be sent when the connection returns.');
    expect(en('offline', { count: 1 })).toBe('Offline: 1 action will be sent when the connection returns.');
    expect(en('offline', { count: 3 })).toBe('Offline: 3 actions will be sent when the connection returns.');
    expect(es('synced', { count: 1 })).toBe('Conexión recuperada: 1 acción enviada.');
    expect(es('dropped', { count: 2 })).toBe('No se han podido aplicar 2 acciones hechas sin conexión.');
    expect(en('queuedStale', { count: 1 })).toMatch(/^1 stop saved offline was skipped/);
    expect(en('reassignResults', { count: 0 })).toBe('No tasks found.');
    // A key without forms is used as it is.
    expect(en('resultsCount', { count: 1 })).toBe('Tasks found: 1');
    expect(chatText('en')('allocSubjectResults', { count: 1 })).toBe('1 result');
    expect(chatText('es')('homeMore', { count: 1 })).toBe('1 más en la barra lateral');
    expect(tasksText('en')('colCount', { name: 'Done', count: 1 })).toBe('Done, 1 task');
    expect(tasksText('es')('boardSub', { name: 'Lumen', count: 4 })).toBe('Lumen · 4 tareas abiertas');
  });

  it('one Spanish word for the timer and plain words instead of jargon', () => {
    const es = chatText('es');
    for (const key of ['timerNone', 'timerStop', 'moduleTimeRunning', 'stopAndSwitchTitle', 'stopFailed', 'timerPlacement'] as const) expect(es(key, { org: 'X', task: 'Y', time: '1', target: 'Z' })).not.toMatch(/cronómetro/i);
    expect(es('timerNone')).toBe('Sin temporizador');
    expect(tasksText('en')('markersHint')).not.toContain('TaskBoard');
    expect(tasksText('en')('connectPoints')).not.toMatch(/keychain/);
    expect(tasksText('en')('connectHowText')).toMatch(/keychain/);
    expect(chatText('en')('allocSubjectHint')).toBe('Type to search. Beacon confirms the client when you save.');
  });

  it('a stop under a minute is saved without praise (UXA-20)', async () => {
    let now = Date.now();
    const ui = await onTime({ now: () => new Date(now) });
    await ui.app.start({ id: 'T-104', title: 'Fix invoice rounding bug' });
    now += 20_000;
    await ui.app.stop();
    expect(ui.$('#notice span').textContent).toMatch(/^Saved a short entry \(0:00\) on Fix invoice rounding bug\. If it was a slip, you can delete it in Beacon\.$/);
    await ui.app.start({ id: 'T-104', title: 'Fix invoice rounding bug' });
    now += 25 * 60_000;
    await ui.app.stop();
    expect(ui.$('#notice span').textContent).not.toMatch(/short entry/);
  });
});

describe('the global switcher (UX batch 3, UXA-3)', () => {
  const item = (key: string, module: SwitchItem['module'], label: string): SwitchItem => ({ key, module, label, meta: '', icon: 'hash', run: () => undefined });

  it('ranks the module in view first without a query, every match by score with one', () => {
    const chat = scoreItems('', [item('c1', 'chat', 'envelope-v2'), item('c2', 'chat', 'random'), item('c3', 'chat', 'incidents'), item('c4', 'chat', 'design')]);
    const time = scoreItems('', [item('t1', 'time', 'Fix invoice rounding bug'), item('t2', 'time', 'Plan sprint')]);
    expect(mergeSwitch([{ module: 'chat', items: chat }, { module: 'time', items: time }], 'time', '').map((entry) => entry.key)).toEqual(['t1', 't2', 'c1', 'c2', 'c3']);
    const query = 'inv';
    const ranked = mergeSwitch(
      [
        { module: 'chat', items: scoreItems(query, [item('c1', 'chat', 'envelope-v2'), item('c5', 'chat', 'invoices')]) },
        { module: 'time', items: scoreItems(query, [item('t1', 'time', 'Fix invoice rounding bug')]) },
      ],
      'time',
      query,
    );
    expect(ranked.map((entry) => entry.key)).toEqual(['c5', 't1']);
    // The extra words match too, a little lower than the label.
    expect(scoreItems('engineering', [{ ...item('t9', 'time', 'Plan sprint'), extra: 'Engineering' }])).toHaveLength(1);
  });

  it('works in Time with no chat: timer actions and views; runs the chosen one', async () => {
    const ui = await onTime();
    expect(ui.$('#tb-search').hidden).toBe(false);
    ui.key({ key: 'k', ctrlKey: true });
    expect(ui.$<HTMLDialogElement>('#switcher').open).toBe(true);
    expect(ui.$<HTMLInputElement>('#sw-input').placeholder).toBe('Jump to a conversation, task or timer…');
    expect(options().every((node) => node.dataset.module === 'time')).toBe(true);
    expect(options().map((node) => node.querySelector('.o-t')?.textContent)).toContain('My time');
    const input = ui.$<HTMLInputElement>('#sw-input');
    input.value = 'fix';
    input.dispatchEvent(new Event('input'));
    expect(options()[0].querySelector('.o-t')?.textContent).toBe('Fix invoice rounding bug');
    expect(options()[0].querySelector('.o-m')?.textContent).toBe('Start timer');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => ui.app.state.activeTimer !== null, 'the timer');
    expect(ui.$<HTMLDialogElement>('#switcher').open).toBe(false);
    // Running: "Stop the timer" leads, the other tasks say "Switch timer here".
    ui.key({ key: 'k', metaKey: true });
    expect(options()[0].querySelector('.o-t')?.textContent).toBe('Stop the timer');
    input.value = 'plan';
    input.dispatchEvent(new Event('input'));
    expect(options()[0].querySelector('.o-m')?.textContent).toBe('Switch timer here');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    options()[0].click();
    await until(() => ui.app.state.activeTimer === null, 'the stop');
    // My time from the switcher.
    ui.key({ key: 'k', ctrlKey: true });
    options()
      .find((node) => node.querySelector('.o-t')?.textContent === 'My time')
      ?.click();
    expect(ui.app.currentSection()).toBe('time');
  });

  it('in Tasks: boards and tasks first, conversations and timers on a query; opens a board or a task', async () => {
    const ui = await onTime();
    await withChat(ui);
    await withTasks(ui);
    ui.key({ key: 'k', ctrlKey: true });
    expect(options()[0].dataset.module).toBe('tasks');
    expect(options()[0].dataset.switch).toMatch(/^b-/);
    const input = ui.$<HTMLInputElement>('#sw-input');
    input.value = 'env';
    input.dispatchEvent(new Event('input'));
    const modules = new Set(options().map((node) => node.dataset.module));
    expect(modules.has('chat') && modules.has('tasks')).toBe(true);
    options()
      .find((node) => node.dataset.switch?.startsWith('b-'))
      ?.click();
    expect(ui.shell.module).toBe('tasks');
    expect(ui.shell.tasks?.prefs.view).toBe('board');
    ui.key({ key: 'k', ctrlKey: true });
    input.value = 'benchmark';
    input.dispatchEvent(new Event('input'));
    options()
      .find((node) => node.dataset.switch?.startsWith('t-'))
      ?.click();
    await until(() => ui.shell.tasks?.detail !== null, 'the task panel');
    // From Chat, a task: Tasks opens on it.
    ui.$<HTMLButtonElement>('#tab-chat').click();
    ui.key({ key: 'k', ctrlKey: true });
    expect(options()[0].dataset.module).toBe('chat');
  });
});

describe('app-wide keys in every module (UX batch 3)', () => {
  it('`?` lists Anywhere plus the keys of the module in view, and only those', async () => {
    const ui = await onTime();
    ui.key({ key: '?' }, document.body);
    expect(sheet()).toEqual(['Anywhere', 'Time']);
    expect(ui.$('#shell-keys').textContent).toContain('Previous / next section');
    expect(ui.$('#shell-keys').textContent).toContain('Move between areas');
    // Undo toasts (UX batch 4): Ctrl/⌘+Z is listed under Anywhere.
    expect(ui.$('#shell-keys').textContent).toContain('Undo the last action');
    ui.$<HTMLDialogElement>('#shell-keys').close();
    await withChat(ui);
    ui.$<HTMLElement>('#chat-home-link').focus();
    ui.key({ key: '?' });
    expect(sheet()).toEqual(['Anywhere', 'Chat']);
    // Ctrl/⌘+J also reaches the new messages below (UX batch 4, UXA-11).
    expect(ui.$('#shell-keys').textContent).toContain('Jump to unread or new messages');
    ui.$<HTMLDialogElement>('#shell-keys').close();
    await withTasks(ui);
    ui.key({ key: '?' }, document.body);
    expect(sheet()).toEqual(['Anywhere', 'Tasks']);
    expect(ui.$('#shell-keys').textContent).toContain('Previous / next board');
    ui.$<HTMLDialogElement>('#shell-keys').close();
    // Spanish sheet in Time.
    const es = await onTime({ locale: 'es' });
    es.key({ key: '?' }, document.body);
    expect(sheet()).toEqual(['En cualquier sitio', 'Tiempo']);
    expect(es.$('#shell-keys').textContent).toContain('Deshacer la última acción');
  });

  it('Ctrl/⌘+Shift+L is the theme everywhere; Ctrl/⌘+, and Ctrl/⌘+Shift+S too', async () => {
    const ui = await onTime();
    const sets = ui.platform.hooks.window.set.length;
    for (const module of ['time', 'tasks', 'chat'] as const) {
      ui.shell.show(module);
      const before = document.documentElement.getAttribute('data-theme');
      ui.key({ key: 'L', ctrlKey: true, shiftKey: true }, document.body);
      await until(() => document.documentElement.getAttribute('data-theme') !== before, `the theme in ${module}`);
    }
    expect(ui.platform.hooks.window.set).toHaveLength(sets);
    ui.shell.show('chat');
    ui.key({ key: ',', ctrlKey: true }, document.body);
    expect(ui.$<HTMLDialogElement>('#shell-settings').open).toBe(true);
    ui.$<HTMLDialogElement>('#shell-settings').close();
    await ui.app.start({ id: 'T-104', title: 'Fix invoice rounding bug' });
    ui.key({ key: 'S', ctrlKey: true, shiftKey: true }, document.body);
    await until(() => ui.app.state.activeTimer === null, 'the stop from Chat');
  });

  it('F6 walks title bar, rail and the module panes in every module; Alt+↑ / ↓ moves sections and boards', async () => {
    const ui = await onTime();
    const area = () => {
      const active = document.activeElement as HTMLElement;
      return active.closest('#titlebar') ? 'titlebar' : active.closest('#rail') ? 'rail' : active.closest('#sidebar, #chat-side') ? 'sidebar' : active.closest('#detail, #tasks-drawer, #thread-slot') ? 'detail' : active.closest('main, #main-pane') ? 'main' : active.tagName;
    };
    (document.activeElement as HTMLElement | null)?.blur();
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ui.key({ key: 'F6' });
      seen.push(area());
    }
    expect(seen).toEqual(['sidebar', 'main', 'detail', 'titlebar', 'rail', 'sidebar']);
    ui.key({ key: 'F6', shiftKey: true });
    expect(area()).toBe('rail');
    // Alt+↓ in Time: the next section (as Chat's conversations).
    ui.$<HTMLElement>('#nav-tasks').focus();
    ui.key({ key: 'ArrowDown', altKey: true });
    expect(ui.app.currentSection()).toBe('quick');
    expect(document.activeElement?.id).toBe('nav-quick');
    ui.key({ key: 'ArrowUp', altKey: true });
    expect(ui.app.currentSection()).toBe('tasks');
    // Chat: sidebar (the open conversation) → conversation → title bar.
    await withChat(ui);
    ui.$<HTMLButtonElement>(`[data-conv="${MAYA}"]`).click();
    await until(() => ui.shell.chat.openUuid() === MAYA, 'the conversation');
    (document.activeElement as HTMLElement | null)?.blur();
    ui.key({ key: 'F6' });
    expect((document.activeElement as HTMLElement).dataset.conv).toBe(MAYA);
    ui.key({ key: 'F6' });
    expect(area()).toBe('main');
    ui.key({ key: 'F6', shiftKey: true });
    expect(area()).toBe('sidebar');
    // Tasks: page → title bar; Alt+↓ on the board view: the next board.
    await withTasks(ui);
    (document.activeElement as HTMLElement | null)?.blur();
    ui.key({ key: 'F6' });
    expect((document.activeElement as HTMLElement).classList.contains('r-title')).toBe(true);
    ui.key({ key: 'F6' });
    expect(area()).toBe('titlebar');
    const tasks = ui.shell.tasks as NonNullable<Shell['tasks']>;
    tasks.setView('board');
    const board = tasks.currentBoard()?.id;
    ui.key({ key: 'ArrowDown', altKey: true }, document.body);
    expect(tasks.currentBoard()?.id).not.toBe(board);
    ui.key({ key: 'ArrowUp', altKey: true }, document.body);
    expect(tasks.currentBoard()?.id).toBe(board);
  });
});

describe('one Tab stop per long list (UX batch 3, UXA-10)', () => {
  it('the chat sidebar is one stop; ↑ ↓ Home End move; the open conversation takes Tab', async () => {
    const ui = await onTime();
    await withChat(ui);
    const stops = () => [...document.querySelectorAll<HTMLElement>('.side-scroll .conv, .side-scroll .sec-h')].filter((node) => node.tabIndex === 0);
    expect(stops()).toHaveLength(1);
    ui.$<HTMLButtonElement>(`[data-conv="${MAYA}"]`).click();
    await until(() => ui.shell.chat.openUuid() === MAYA, 'the conversation');
    expect(stops()[0].dataset.conv).toBe(MAYA);
    const first = document.querySelector<HTMLElement>('.side-scroll .sec-h') as HTMLElement;
    first.focus();
    ui.key({ key: 'ArrowDown' });
    expect((document.activeElement as HTMLElement).classList.contains('conv')).toBe(true);
    ui.key({ key: 'End' });
    const all = [...document.querySelectorAll<HTMLElement>('.side-scroll .sec-h, .side-scroll .conv, .side-scroll .sec-more')];
    expect(document.activeElement).toBe(all.at(-1));
    expect(stops()).toEqual([all.at(-1)]);
    ui.key({ key: 'Home' });
    expect(document.activeElement).toBe(first);
    // The main landmark (UXA-27).
    expect(ui.$('#chat-main').tagName).toBe('MAIN');
  });

  it('My tasks and List rows: one stop, ← → reach the checkbox and the play button, S starts the timer', async () => {
    const ui = await onTime();
    await withTasks(ui);
    const titles = () => [...document.querySelectorAll<HTMLElement>('#tasks-mine .r-title')];
    expect(titles().filter((node) => node.tabIndex === 0)).toHaveLength(1);
    expect([...document.querySelectorAll<HTMLElement>('#tasks-mine .chk, #tasks-mine .k-play')].filter((node) => node.tabIndex !== -1).map((node) => node.className)).toEqual([]);
    titles()[0].focus();
    ui.key({ key: 'ArrowDown' });
    expect(document.activeElement).toBe(titles()[1]);
    ui.key({ key: 'ArrowLeft' });
    expect((document.activeElement as HTMLElement).className).toBe('chk');
    ui.key({ key: 'ArrowRight' });
    expect((document.activeElement as HTMLElement).className).toBe('r-title');
    ui.key({ key: 'ArrowRight' });
    expect((document.activeElement as HTMLElement).className).toMatch(/k-play/);
    expect(titles()[1].tabIndex).toBe(0);
    titles()[1].focus();
    ui.key({ key: 's' });
    await until(() => ui.app.state.activeTimer !== null, 'the timer from the row');
    // Headings under the page's h1 are h2 (UXA-27); the page is the module's main landmark.
    expect(document.querySelectorAll('#tasks-mine h3')).toHaveLength(0);
    expect(document.querySelectorAll('#tasks-mine h2').length).toBeGreaterThan(0);
    expect(ui.$('#tasks-main').tagName).toBe('MAIN');
    // The List view: the timer column has a (visually hidden) header.
    ui.shell.tasks?.setView('list');
    await until(() => document.querySelector('#tasks-list-view tbody tr[data-row]') !== null, 'the list');
    expect(document.querySelector('#tasks-list-view th:last-child')?.textContent).toBe('Timer');
    const rows = [...document.querySelectorAll<HTMLElement>('#tasks-list-view .t-title')];
    expect(rows.filter((node) => node.tabIndex === 0)).toHaveLength(1);
  });

  it('Roving: arrows ignore modified keys and handled events; a re-rendered list keeps its stop', () => {
    document.body.replaceChildren();
    const root = document.createElement('ul');
    const render = () => root.replaceChildren(...['a', 'b', 'c'].map((id) => Object.assign(document.createElement('button'), { id, type: 'button' })));
    render();
    document.body.append(root);
    const roving = new Roving(root, { items: 'button' });
    roving.sync();
    expect([...root.querySelectorAll('button')].map((node) => node.tabIndex)).toEqual([0, -1, -1]);
    (root.querySelector('#a') as HTMLElement).focus();
    root.querySelector('#a')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(document.activeElement?.id).toBe('a');
    root.querySelector('#a')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.id).toBe('b');
    render();
    roving.sync();
    expect([...root.querySelectorAll('button')].map((node) => node.tabIndex)).toEqual([-1, 0, -1]);
    expect(roving.focus()).toBe(true);
    expect(document.activeElement?.id).toBe('b');
  });
});

describe('chat and dialog copy (UX batch 2)', () => {
  it('hides the healthy sidebar footer; a DM starts "with" its person (UXA-14, UXA-32)', async () => {
    const ui = await onTime();
    await withChat(ui);
    expect(ui.$('#chat-side-foot').hidden).toBe(true);
    ui.$<HTMLButtonElement>(`[data-conv="${MAYA}"]`).click();
    await until(() => ui.$('.conv-start') !== null, 'the start of the conversation');
    expect(ui.$('.conv-start').textContent).toContain('This is the start of your conversation with Maya Okafor.');
    ui.key({ key: ',', ctrlKey: true }, document.body);
    ui.$<HTMLButtonElement>('#settings-tab-chat').click();
    expect(ui.$('#settings-chat-status').textContent).toContain('Connected');
    expect(shellText('es')('connTrouble')).toBe('Problemas de conexión');
  });

  it('the required activity row takes no room until there is something to say (UXA-43)', async () => {
    await env.control('config', { deviceInterval: 1, allocation: { requireActivityType: true }, contextPolicy: { required: false, refuse: [] } });
    const ui = await onTime();
    await ui.app.start({ id: 'T-104', title: 'Fix invoice rounding bug' });
    const stopping = ui.app.stop();
    await until(() => ui.$('#alloc-activity') !== null && !(ui.$<HTMLSelectElement>('#alloc-activity').disabled), 'the activity list');
    expect(ui.$('#alloc-activity-row .row-msg').hasAttribute('data-quiet')).toBe(true);
    ui.$<HTMLButtonElement>('#alloc-submit').click();
    expect(ui.$('#alloc-activity-row').classList.contains('invalid')).toBe(true);
    ui.$<HTMLButtonElement>('#alloc-cancel').click();
    await stopping;
  });
});
