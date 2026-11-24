// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../src/i18n/en.json';
import es from '../../src/i18n/es.json';
import { SETTINGS_TAB_KEY } from '../../src/lib/settings';
import { browserPlatform } from '../../src/platform';
import { DesktopApp, SETTINGS_TABS } from '../../src/ui/app';
import { createTabs } from '../../src/ui/tabs';
import { nodeFetch, startMock, until } from './helpers';

/** Settings split into tabs (accessible tablist, keyboard, remembered tab) and the tabs widget itself. */
let env: Awaited<ReturnType<typeof startMock>>;

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());
beforeEach(async () => {
  localStorage.clear();
  await env.control('reset', {});
  await env.control('config', { deviceInterval: 1 });
});

async function signedIn(locale: 'en' | 'es' = 'en') {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.5.0', nodeFetch);
  const app = new DesktopApp(root, platform, { storage: localStorage, locale, sleep: () => new Promise((resolve) => setTimeout(resolve, 5)), searchDelayMs: 5 });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  await app.init();
  const done = app.connect(env.url);
  await until(() => $('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  return { app, root, $ };
}

const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const selected = (root: ParentNode) => [...root.querySelectorAll('[role="tab"][aria-selected="true"]')].map((tab) => tab.id);
const visiblePanels = (root: ParentNode) => [...root.querySelectorAll('[role="tabpanel"]')].filter((panel) => !panel.hasAttribute('hidden')).map((panel) => panel.id);

describe('Settings tabs', () => {
  it('render a labelled tablist with one tab and one panel per group, the first selected', async () => {
    const ui = await signedIn();
    ui.app.show('settings');
    const tablist = ui.$('[role="tablist"]');
    expect(tablist.getAttribute('aria-label')).toBe('Settings sections');
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['General', 'Shortcuts', 'Timer', 'Schedule', 'Notifications', 'Meetings', 'Updates']);
    for (const tab of tabs) {
      const panel = ui.$(`#${tab.getAttribute('aria-controls')}`);
      expect(tab.type).toBe('button');
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    expect(selected(ui.root)).toEqual(['settings-tab-general']);
    expect(visiblePanels(ui.root)).toEqual(['settings-panel-general']);
    // Roving tabindex: only the selected tab is a Tab stop; hidden panels stay findable where supported.
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
    expect(ui.$('#settings-panel-updates').getAttribute('hidden')).toBe('until-found');
    expect(ui.app.settingsTab()).toBe('general');
    ui.app.destroy();
  });

  it('put every option in its group, update controls on the Updates tab', async () => {
    const ui = await signedIn();
    ui.app.show('settings');
    const where = (selector: string) => ui.$(selector)?.closest('[role="tabpanel"]')?.id;
    expect(where('#theme')).toBe('settings-panel-general');
    expect(where('#browser-settings')).toBe('settings-panel-general');
    expect(where('#feature-autostart')).toBe('settings-panel-general');
    expect(where('#background-note')).toBe('settings-panel-general');
    expect(where('#open-privacy')).toBe('settings-panel-general');
    expect(where('#logout')).toBe('settings-panel-general');
    expect(where('#shortcut-form')).toBe('settings-panel-shortcuts');
    expect(where('#resume-shortcut-form')).toBe('settings-panel-shortcuts');
    expect(where('#idle-settings')).toBe('settings-panel-timer');
    expect(where('#nudge-toggle')).toBe('settings-panel-timer');
    expect(where('#lock-toggle')).toBe('settings-panel-timer');
    expect(where('#schedule-settings')).toBe('settings-panel-schedule');
    expect(where('#friendly-settings')).toBe('settings-panel-notifications');
    expect(where('#feature-notifications')).toBe('settings-panel-notifications');
    expect(where('#meeting-settings')).toBe('settings-panel-meetings');
    expect(where('#meeting-reminders')).toBe('settings-panel-meetings');
    expect(where('#about')).toBe('settings-panel-updates');
    expect(where('#check-updates')).toBe('settings-panel-updates');
    ui.app.destroy();
  });

  it('switch on click; the tabs and panels are built once and updated in place', async () => {
    const ui = await signedIn();
    ui.app.show('settings');
    const tab = ui.$<HTMLButtonElement>('#settings-tab-updates');
    const panel = ui.$('#settings-panel-updates');
    tab.click();
    expect(selected(ui.root)).toEqual(['settings-tab-updates']);
    expect(visiblePanels(ui.root)).toEqual(['settings-panel-updates']);
    expect(ui.$('#settings-panel-general').getAttribute('hidden')).toBe('until-found');
    expect(document.activeElement).toBe(tab);
    // A render (update status, language, anything) keeps the same tab and panel nodes and the selection.
    await ui.app.checkUpdates(true);
    ui.app.show('main');
    ui.app.show('settings');
    expect(ui.$('#settings-tab-updates')).toBe(tab);
    expect(ui.$('#settings-panel-updates')).toBe(panel);
    expect(selected(ui.root)).toEqual(['settings-tab-updates']);
    ui.app.destroy();
  });

  it('move with ←/→ (wrapping), Home and End; selection follows focus', async () => {
    const ui = await signedIn();
    ui.app.show('settings');
    const tablist = ui.$('[role="tablist"]');
    ui.$<HTMLButtonElement>('#settings-tab-general').focus();
    key(document.activeElement as Element, 'ArrowRight');
    expect(selected(ui.root)).toEqual(['settings-tab-shortcuts']);
    expect(document.activeElement?.id).toBe('settings-tab-shortcuts');
    expect(visiblePanels(ui.root)).toEqual(['settings-panel-shortcuts']);
    key(document.activeElement as Element, 'End');
    expect(document.activeElement?.id).toBe('settings-tab-updates');
    key(document.activeElement as Element, 'ArrowRight');
    expect(document.activeElement?.id).toBe('settings-tab-general');
    key(document.activeElement as Element, 'ArrowLeft');
    expect(document.activeElement?.id).toBe('settings-tab-updates');
    key(document.activeElement as Element, 'Home');
    expect(document.activeElement?.id).toBe('settings-tab-general');
    expect(ui.$<HTMLButtonElement>('#settings-tab-general').tabIndex).toBe(0);
    expect(ui.$<HTMLButtonElement>('#settings-tab-updates').tabIndex).toBe(-1);
    // Other keys are left alone (no preventDefault).
    const other = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    tablist.querySelector('[aria-selected="true"]')?.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(selected(ui.root)).toEqual(['settings-tab-general']);
    ui.app.destroy();
  });

  it('remember the last tab, also after signing in again; "Clear local data" forgets it', async () => {
    let ui = await signedIn();
    ui.app.show('settings');
    ui.$<HTMLButtonElement>('#settings-tab-meetings').click();
    expect(localStorage.getItem(SETTINGS_TAB_KEY)).toBe('meetings');
    ui.app.destroy();
    ui = await signedIn();
    expect(ui.app.settingsTab()).toBeNull();
    ui.app.show('settings');
    expect(selected(ui.root)).toEqual(['settings-tab-meetings']);
    expect(visiblePanels(ui.root)).toEqual(['settings-panel-meetings']);
    await ui.app.clearLocalData();
    expect(localStorage.getItem(SETTINGS_TAB_KEY)).toBeNull();
    ui.app.destroy();
  });

  it('fall back to the first tab when the stored value is unknown or storage fails', async () => {
    localStorage.setItem(SETTINGS_TAB_KEY, 'nope');
    let ui = await signedIn();
    ui.app.show('settings');
    expect(selected(ui.root)).toEqual(['settings-tab-general']);
    ui.app.destroy();
    ui = await signedIn();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      ui.app.show('settings');
      expect(selected(ui.root)).toEqual(['settings-tab-general']);
      ui.$<HTMLButtonElement>('#settings-tab-timer').click();
      expect(selected(ui.root)).toEqual(['settings-tab-timer']);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
    ui.app.destroy();
  });

  it('showSettings opens a given tab', async () => {
    const ui = await signedIn();
    ui.app.showSettings('schedule');
    expect(ui.app.view).toBe('settings');
    expect(selected(ui.root)).toEqual(['settings-tab-schedule']);
    expect(localStorage.getItem(SETTINGS_TAB_KEY)).toBe('schedule');
    ui.app.destroy();
  });

  it('speak Spanish in sentence case', async () => {
    const ui = await signedIn('es');
    ui.app.show('settings');
    expect(ui.$('[role="tablist"]').getAttribute('aria-label')).toBe('Secciones de ajustes');
    expect([...ui.root.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['General', 'Atajos', 'Temporizador', 'Horario', 'Notificaciones', 'Reuniones', 'Actualizaciones']);
    ui.app.destroy();
  });

  it('have a name in every locale for every tab', () => {
    for (const messages of [en, es] as Record<string, string>[]) {
      for (const id of SETTINGS_TABS) expect(messages[`settingsTab${id[0].toUpperCase()}${id.slice(1)}`]).toBeTruthy();
      expect(messages.settingsSections).toBeTruthy();
    }
  });
});

describe('createTabs', () => {
  const make = (selected: 'a' | 'b' | 'c' = 'a') => {
    const onSelect = vi.fn();
    const tabs = createTabs<'a' | 'b' | 'c'>({ idPrefix: 'x', label: 'X', tabs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], selected, onSelect });
    document.body.replaceChildren(tabs.root);
    return { tabs, onSelect };
  };

  it('starts on the given tab, or the first one for an unknown id', () => {
    expect(make('b').tabs.selected()).toBe('b');
    expect(make('z' as 'a').tabs.selected()).toBe('a');
  });

  it('calls onSelect only when the selection changes', () => {
    const { tabs, onSelect } = make();
    tabs.select('a');
    expect(onSelect).not.toHaveBeenCalled();
    tabs.select('c');
    expect(onSelect).toHaveBeenCalledWith('c');
    expect(tabs.panels.get('c')?.hasAttribute('hidden')).toBe(false);
    expect(tabs.panels.get('a')?.getAttribute('hidden')).toBe('until-found');
  });

  it('a find-in-page match in a hidden panel selects its tab', () => {
    const { tabs, onSelect } = make();
    tabs.panels.get('b')?.dispatchEvent(new Event('beforematch'));
    expect(tabs.selected()).toBe('b');
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(document.activeElement).not.toBe(tabs.tabs.get('b'));
  });

  it('renames tabs in place', () => {
    const { tabs } = make();
    const a = tabs.tabs.get('a');
    tabs.setLabels('Y', { a: 'Uno', b: 'Dos', c: 'Tres' });
    expect(tabs.tablist.getAttribute('aria-label')).toBe('Y');
    expect(tabs.tabs.get('a')).toBe(a);
    expect([...tabs.tabs.values()].map((tab) => tab.textContent)).toEqual(['Uno', 'Dos', 'Tres']);
  });

  it('swaps the arrow keys for right-to-left text', () => {
    const { tabs } = make();
    tabs.tablist.style.direction = 'rtl';
    tabs.tabs.get('a')?.focus();
    key(tabs.tabs.get('a') as HTMLElement, 'ArrowLeft');
    expect(tabs.selected()).toBe('b');
    key(tabs.tabs.get('b') as HTMLElement, 'ArrowRight');
    expect(tabs.selected()).toBe('a');
  });

  it('marks the edges with more tabs beyond them where scroll-driven animations are missing', () => {
    const observed: Element[] = [];
    let callback: IntersectionObserverCallback = () => undefined;
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe(target: Element) {
        observed.push(target);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    vi.stubGlobal('CSS', { supports: () => false });
    try {
      const { tabs } = make();
      expect(observed).toEqual([tabs.tabs.get('a'), tabs.tabs.get('c')]);
      callback([{ target: observed[0], intersectionRatio: 1 }, { target: observed[1], intersectionRatio: 0.4 }] as unknown as IntersectionObserverEntry[], {} as IntersectionObserver);
      expect(tabs.tablist.classList.contains('more-start')).toBe(false);
      expect(tabs.tablist.classList.contains('more-end')).toBe(true);
    } finally {
      globalThis.IntersectionObserver = original;
      vi.unstubAllGlobals();
    }
  });
});
