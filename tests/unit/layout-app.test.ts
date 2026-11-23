// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WINDOW_KEY } from '../../src/lib/layout';
import { browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock, until } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

function mount(width: { value: number }, locale: 'en' | 'es' = 'en') {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  const platform = browserPlatform('0.1.0', nodeFetch);
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 1,
    viewportWidth: () => width.value,
    windowSaveMs: 5,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  return { app, platform, root, $, click: (selector: string) => $(selector).click() };
}

async function signedIn(width: { value: number }, locale: 'en' | 'es' = 'en') {
  const ui = mount(width, locale);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent ?? '' });
  await done;
  expect(ui.app.view).toBe('main');
  return ui;
}

/** One finished entry earlier today (UTC), never before midnight nor zero-length, and its length as `H:MM`. */
function todayEntry(taskId: string, now = Date.now()) {
  const midnight = now - (now % 86_400_000);
  const from = Math.max(now - 61 * 60_000, midnight + 1000);
  const to = Math.max(now - 60_000, from + 1000);
  const minutes = Math.floor((to - from) / 60_000);
  return { entry: { taskId, startedAt: new Date(from).toISOString(), endedAt: new Date(to).toISOString() }, time: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` };
}

const key = (target: EventTarget, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

describe('window layouts', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('draws the compact layout below the breakpoint and the full one above it, following resizes', async () => {
    const width = { value: 400 };
    const ui = await signedIn(width);
    expect(ui.root.getAttribute('data-layout')).toBe('compact');
    expect(ui.$('#sidebar').hidden).toBe(true);
    expect(ui.$('#detail').hidden).toBe(true);
    expect(ui.$('#layout-toggle').getAttribute('aria-label')).toBe('Switch to the full view');
    expect(ui.platform.hooks.trayMenu?.layout).toEqual({ id: 'layout-full', label: 'Full view' });
    width.value = 1280;
    window.dispatchEvent(new Event('resize'));
    expect(ui.root.getAttribute('data-layout')).toBe('full');
    expect(ui.$('#sidebar').hidden).toBe(false);
    expect(ui.$('#sidebar').getAttribute('aria-label')).toBe('Sections');
    expect(ui.$('#detail').hidden).toBe(false);
    expect(ui.$('#detail-empty')).not.toBeNull();
    expect(ui.$('#layout-toggle').textContent).toBe('Compact view');
    await tick(5);
    expect(ui.platform.hooks.trayMenu?.layout).toEqual({ id: 'layout-compact', label: 'Compact view' });
    // Same width again: nothing to redraw.
    ui.app.relayout();
    expect(ui.$('#nav-tasks').getAttribute('aria-current')).toBe('page');
    // Signed out, a wide window keeps the single column.
    await ui.app.logout();
    expect(ui.root.getAttribute('data-layout')).toBe('compact');
    expect(ui.$('#layout-toggle')).toBeNull();
    expect(ui.platform.hooks.trayMenu?.layout).toBeNull();
  });

  it('shows the selected task in the detail pane, with its time today and this week, and acts on it', async () => {
    const seeded = todayEntry('T-102');
    await env.control('entries/seed', { entries: [seeded.entry] });
    const width = { value: 1280 };
    const ui = await signedIn(width);
    expect(ui.$('#detail-week-days li')).not.toBeNull();
    expect(ui.$('#detail-week-days').querySelectorAll('li')).toHaveLength(7);
    expect(ui.$('#detail-week-days [aria-current="date"]')).not.toBeNull();
    // Keyboard focus on a row selects it.
    ui.$<HTMLButtonElement>('[data-task="T-104"] .row-action').focus();
    expect(ui.app.selectedTaskId).toBe('T-104');
    expect(ui.$('[data-task="T-104"]').classList.contains('selected')).toBe(true);
    expect(ui.$('[data-task="T-104"]').getAttribute('aria-current')).toBe('true');
    expect(ui.$('#detail-title').textContent).toBe('Fix invoice rounding bug');
    expect(ui.$('#detail-context').textContent).toBe('Engineering');
    expect(ui.$('#detail-today .value').textContent).toBe('0:00');
    expect(ui.$('#detail-entries-empty')).not.toBeNull();
    // A click on another row's text selects it too.
    ui.$('[data-task="T-102"] .task').click();
    expect(ui.$('#detail-title').textContent).toBe('Review pull request queue');
    expect(ui.$('#detail-today .value').textContent).toBe(seeded.time);
    expect(ui.$('#detail-week .value').textContent).toBe(seeded.time);
    expect(ui.$('#detail-entries').querySelectorAll('li')).toHaveLength(1);
    expect(ui.$('[data-task="T-104"]').classList.contains('selected')).toBe(false);
    ui.app.selectTask('T-102');
    // Pin from the pane.
    ui.click('#detail-pin');
    expect(ui.app.isPinned('T-102')).toBe(true);
    expect(ui.$('#detail-pin').getAttribute('aria-pressed')).toBe('true');
    expect(ui.$('#detail-pin').textContent).toBe('Unpin');
    // Start, then the pane shows it running with Stop.
    ui.click('#detail-start');
    await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    expect(ui.$('#detail .chip').textContent).toContain('Tracking');
    expect(ui.$('#detail-entries li.running')).not.toBeNull();
    ui.app.selectTask('T-101');
    expect(ui.$('#detail-start').textContent).toBe('Switch');
    ui.app.selectTask('T-102');
    ui.click('#detail-stop');
    await tick();
    expect(ui.app.state.activeTimer).toBeNull();
    // A task that is no longer known shows the empty pane.
    ui.app.selectedTaskId = 'T-404';
    ui.app.render();
    expect(ui.$('#detail-empty')).not.toBeNull();
    // Compact: no selection.
    width.value = 500;
    ui.app.relayout();
    ui.app.selectTask('T-101');
    expect(ui.app.selectedTaskId).toBe('T-404');
  });

  it('switches sections in the sidebar: pinned & recent, my time, settings as a page', async () => {
    const seeded = todayEntry('T-101');
    await env.control('entries/seed', { entries: [seeded.entry] });
    const ui = await signedIn({ value: 1280 }, 'es');
    ui.$<HTMLInputElement>('#search').value = 'invoice';
    ui.$('#search').dispatchEvent(new Event('input'));
    ui.click('#nav-quick');
    expect(ui.app.section).toBe('quick');
    expect(ui.$('#nav-quick').getAttribute('aria-current')).toBe('page');
    expect((ui.$('#search').parentElement as HTMLElement).hidden).toBe(true);
    expect(ui.$('#list-section').hidden).toBe(true);
    // The query does not hide the quick list here.
    expect(ui.$('#quick-section').hidden).toBe(false);
    expect(ui.$('#quick li[data-task="T-101"]')).not.toBeNull();
    ui.click('#nav-time');
    expect(ui.$('#time-section').hidden).toBe(false);
    expect(ui.$('#quick-section').hidden).toBe(true);
    expect(ui.$('#time-title').textContent).toBe('Registros de hoy');
    expect(ui.$('#time-today li .span-task').textContent).toBe('Write onboarding guide');
    expect(ui.$('#time-week').querySelectorAll('li')).toHaveLength(7);
    expect(ui.$('#time-week .week-total strong').textContent).toBe(seeded.time);
    expect(ui.$('#time-open-beacon')).toBeNull();
    // Settings: a page in the main pane, the sidebar stays, no detail pane.
    ui.click('#nav-settings');
    expect(ui.app.view).toBe('settings');
    expect(ui.$('#main-pane #settings')).not.toBeNull();
    expect(ui.$('#sidebar').hidden).toBe(false);
    expect(ui.$('#nav-settings').getAttribute('aria-current')).toBe('page');
    expect(ui.$('#detail').hidden).toBe(true);
    expect(ui.$('#layout-toggle').textContent).toBe('Vista reducida');
    ui.click('#nav-tasks');
    expect(ui.app.view).toBe('main');
    expect(ui.$('#list-section').hidden).toBe(false);
    expect(ui.$('#time-section').hidden).toBe(true);
  });

  it('says when the entries cannot be read', async () => {
    const ui = await signedIn({ value: 1280 });
    ui.app.entries = null;
    ui.app.render();
    expect(ui.$('#detail-no-entries')).not.toBeNull();
    ui.app.showSection('time');
    expect(ui.$('#time-unavailable')).not.toBeNull();
  });

  it('resizes the window to the remembered size of each view and remembers moves', async () => {
    const width = { value: 400 };
    const ui = await signedIn(width);
    const hooks = ui.platform.hooks.window;
    // First launch: the compact preset, centred.
    expect(hooks.set[0]).toEqual({ x: 760, y: 200, width: 400, height: 640 });
    ui.click('#layout-toggle');
    await tick(5);
    expect(hooks.set.at(-1)).toEqual({ x: 360, y: 130, width: 1200, height: 780 });
    expect(ui.app.windowMemory.mode).toBe('full');
    expect(ui.$('#live').textContent).toBe('Full view');
    // The OS applied it: the person then moves and resizes the full window.
    width.value = 1200;
    window.dispatchEvent(new Event('resize'));
    hooks.bounds = { x: 100, y: 50, width: 1300, height: 800 };
    ui.platform.hooks.windowChanged();
    ui.platform.hooks.windowChanged();
    await tick(20);
    expect(JSON.parse(localStorage.getItem(WINDOW_KEY) ?? '{}').bounds.full).toEqual({ x: 100, y: 50, width: 1300, height: 800 });
    // Ctrl+Shift+L back to compact: its first position again.
    key(document.body, { key: 'L', ctrlKey: true, shiftKey: true });
    await tick(5);
    expect(hooks.set.at(-1)).toEqual({ x: 760, y: 200, width: 400, height: 640 });
    width.value = 400;
    window.dispatchEvent(new Event('resize'));
    // Tray: full view again, at the remembered bounds.
    ui.platform.hooks.trayAction('layout-full');
    await tick(5);
    expect(hooks.set.at(-1)).toEqual({ x: 100, y: 50, width: 1300, height: 800 });
    ui.platform.hooks.trayAction('layout-compact');
    await tick(5);
    expect(ui.app.windowMemory.mode).toBe('compact');
    // Maximised: nothing is remembered.
    hooks.bounds = null;
    const before = localStorage.getItem(WINDOW_KEY);
    await ui.app.rememberWindow();
    expect(localStorage.getItem(WINDOW_KEY)).toBe(before);
    // "Clear local data" forgets the window too.
    await ui.app.clearLocalData();
    expect(localStorage.getItem(WINDOW_KEY)).toBeNull();
    expect(ui.app.windowMemory).toEqual({ mode: 'compact', bounds: {} });
  });

  it('opens in the view last used, and survives a window that cannot be read or moved', async () => {
    localStorage.setItem(WINDOW_KEY, JSON.stringify({ mode: 'full', bounds: { full: { x: 40, y: 30, width: 1000, height: 700 } } }));
    const ui = mount({ value: 400 });
    await ui.app.init();
    expect(ui.platform.hooks.window.set).toEqual([{ x: 40, y: 30, width: 1000, height: 700 }]);
    // Already there: not moved again.
    const again = mount({ value: 400 });
    again.platform.hooks.window.bounds = { x: 40, y: 30, width: 1000, height: 700 };
    await again.app.init();
    expect(again.platform.hooks.window.set).toEqual([]);
    const broken = mount({ value: 400 });
    broken.platform.windowHost.screens = async () => {
      throw new Error('no monitor');
    };
    broken.platform.windowHost.bounds = async () => {
      throw new Error('no window');
    };
    await broken.app.init();
    await broken.app.setLayoutMode('full');
    await broken.app.rememberWindow();
    expect(broken.app.windowMemory.mode).toBe('full');
  });

  it('moves between the panes with F6 and keeps them inert behind the "Still there?" modal', async () => {
    const ui = await signedIn({ value: 1280 });
    key(document.body, { key: 'F6' });
    expect(document.activeElement?.id).toBe('nav-tasks');
    key(document.activeElement as Element, { key: 'F6' });
    expect(document.activeElement?.id).toBe('search');
    key(document.activeElement as Element, { key: 'F6' });
    expect(ui.$('#detail').contains(document.activeElement)).toBe(true);
    key(document.activeElement as Element, { key: 'F6', shiftKey: true });
    expect(document.activeElement?.id).toBe('search');
    // Detail pane with nothing focusable: the pane itself.
    ui.app.showSection('time');
    key(document.activeElement as Element, { key: 'F6' });
    expect(document.activeElement).toBe(ui.$('#detail'));
    key(document.activeElement as Element, { key: 'F6' });
    expect(document.activeElement?.id).toBe('nav-time');
    key(document.activeElement as Element, { key: 'F6' });
    expect(ui.$('#main-pane').contains(document.activeElement)).toBe(true);
    ui.app.showSection('tasks');
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide', boardId: 'docs' });
    await env.control('timer/backdate', { seconds: 3600 });
    await ui.app.refresh();
    ui.platform.hooks.idleSeconds = 617;
    await ui.app.tick();
    expect(ui.$('#idle-modal').hidden).toBe(false);
    expect(ui.$('#sidebar').hasAttribute('inert')).toBe(true);
    expect(ui.$('#detail').hasAttribute('inert')).toBe(true);
  });
});
