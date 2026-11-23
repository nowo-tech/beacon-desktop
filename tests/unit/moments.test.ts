// @vitest-environment happy-dom
import { existsSync, readFileSync, statSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import en from '../../src/i18n/en.json';
import es from '../../src/i18n/es.json';
import { DEFAULT_SETTINGS, emptyState, loadLocal, saveLocal } from '../../src/lib/settings';
import { applyTheme, forcedTheme, isTheme, THEMES } from '../../src/lib/theme';
import { browserPlatform } from '../../src/platform';
import { DesktopApp, LONG_RUNNING_HOURS } from '../../src/ui/app';
import { ERROR_POSES, MOMENTS, art, variant } from '../../src/ui/mascot';
import { nodeFetch, startMock, until } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

function mount(options: { locale?: 'en' | 'es'; now?: () => Date; channel?: 'direct' | 'store' } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.5.0', nodeFetch);
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale: options.locale ?? 'en',
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 5,
    now: options.now,
    channel: options.channel,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  return { app, platform, root, $, click: (selector: string) => $(selector).click() };
}

async function signedIn(options: Parameters<typeof mount>[0] = {}) {
  const ui = mount(options);
  await ui.app.init();
  const done = ui.app.connect(env.url);
  await until(() => ui.$('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
  await done;
  expect(ui.app.view).toBe('main');
  return ui;
}

const pose = (element: Element | null) => element?.getAttribute('data-pose');

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('knows the three preferences and what each forces', () => {
    expect(THEMES).toEqual(['system', 'light', 'dark']);
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('sepia')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
    expect(forcedTheme('system')).toBeNull();
    expect(forcedTheme('light')).toBe('light');
  });

  it('sets data-theme and color-scheme on <html>, and clears them for "system"', () => {
    const root = document.documentElement;
    expect(applyTheme('dark', root)).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    applyTheme('light', root);
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(applyTheme('system', root)).toBeNull();
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.style.colorScheme).toBe('');
  });

  it('defaults to "system" and ignores an unknown stored value', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system');
    expect(loadLocal(localStorage).settings.theme).toBe('system');
    const state = emptyState();
    saveLocal({ ...state, settings: { ...state.settings, theme: 'dark' } }, localStorage);
    expect(loadLocal(localStorage).settings.theme).toBe('dark');
    localStorage.setItem('time-track-desktop', JSON.stringify({ settings: { theme: 'neon' } }));
    expect(loadLocal(localStorage).settings.theme).toBe('system');
  });

  it('applies the stored theme at start-up and hands it to the native window', async () => {
    const state = emptyState();
    saveLocal({ ...state, settings: { ...state.settings, theme: 'dark' } }, localStorage);
    const ui = mount();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await ui.app.init();
    expect(ui.platform.hooks.windowTheme).toBe('dark');
    ui.app.destroy();
  });

  it('Settings → Theme: System / Light / Dark radios, persisted and applied at once', async () => {
    const ui = await signedIn({ locale: 'es' });
    ui.click('#open-settings');
    expect(ui.$('#theme legend').textContent).toBe('Tema');
    const labels = [...ui.root.querySelectorAll('#theme .segment')].map((label) => label.textContent);
    expect(labels).toEqual(['Sistema', 'Claro', 'Oscuro']);
    expect(ui.$<HTMLInputElement>('#theme-system').checked).toBe(true);
    const dark = ui.$<HTMLInputElement>('#theme-dark');
    dark.checked = true;
    dark.dispatchEvent(new Event('change'));
    await tick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(ui.platform.hooks.windowTheme).toBe('dark');
    expect(loadLocal(localStorage).settings.theme).toBe('dark');
    expect(ui.$<HTMLInputElement>('#theme-dark').checked).toBe(true);
    await ui.app.setTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(ui.platform.hooks.windowTheme).toBeNull();
    ui.app.destroy();
  });

  it('a platform that cannot theme its window does not break the switch', async () => {
    const ui = mount();
    ui.platform.setWindowTheme = () => Promise.reject(new Error('unsupported'));
    await ui.app.init();
    await ui.app.setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    ui.app.destroy();
  });
});

describe('mascot moments', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('every pose exists as small 1x / @2x WebP, every moment has a translated alt when it needs one', () => {
    const poses = new Set([...Object.values(MOMENTS).map((m) => m.pose), ...Object.values(ERROR_POSES), 'mascot-arcs']);
    for (const name of poses) {
      for (const file of [`public/mascot/${name}.webp`, `public/mascot/${name}@2x.webp`]) {
        expect(existsSync(file), file).toBe(true);
        expect(readFileSync(file).subarray(8, 12).toString('ascii'), file).toBe('WEBP');
        expect(statSync(file).size, file).toBeLessThan(45_000);
      }
    }
    for (const { alt } of Object.values(MOMENTS)) {
      if (alt !== null) {
        expect(en[alt]).toBeTruthy();
        expect(es[alt]).toBeTruthy();
      }
    }
    expect(readFileSync('public/mascot/README.md', 'utf8')).toContain('symfony-beacon');
  });

  it('decorative pictures are hidden from assistive tech, meaningful ones keep their alt', () => {
    const decorative = art('pose-card', '', 'mascot');
    expect(decorative.getAttribute('alt')).toBe('');
    expect(decorative.getAttribute('aria-hidden')).toBe('true');
    expect(decorative.getAttribute('srcset')).toBe('mascot/pose-card.webp 1x, mascot/pose-card@2x.webp 2x');
    const hero = art('mascot', 'Robot', 'mascot');
    expect(hero.hasAttribute('aria-hidden')).toBe(false);
  });

  it('variant() cycles through the choices, also for negative counters', () => {
    expect([0, 1, 2, 3].map((n) => variant(['a', 'b', 'c'], n))).toEqual(['a', 'b', 'c', 'a']);
    expect(variant(['a', 'b', 'c'], -1)).toBe('c');
  });

  it('first run: the waving mascot with alt text, an idle hint in the timer card', async () => {
    const ui = mount();
    await ui.app.init();
    const hero = ui.$('#login-form [data-moment="firstRun"]');
    expect(pose(hero)).toBe('mascot');
    expect(hero.getAttribute('alt')).toBe("Beacon's robot mascot waving");
    ui.app.destroy();
  });

  it('sign-in success: "You\'re in" card until Got it, gone on the first Start', async () => {
    const ui = await signedIn();
    expect(ui.$('#welcome-title').textContent).toBe("You're in!");
    expect(ui.$('#welcome').textContent).toContain('This computer is connected to 127.0.0.1');
    expect(pose(ui.$('#welcome [data-moment="signedIn"]'))).toBe('pose-card');
    expect(ui.$('#idle-hint').textContent).toBe('Nothing on the clock yet. Pick a task below and press Start.');
    ui.click('#welcome-dismiss');
    expect(ui.$('#welcome')).toBeNull();
    expect(document.activeElement?.id).toBe('search');

    const again = await signedIn();
    expect(again.$('#welcome')).not.toBeNull();
    await again.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    expect(again.$('#welcome')).toBeNull();
    await again.app.logout();
    expect(again.app.welcome).toBe(false);
    ui.app.destroy();
    again.app.destroy();
  });

  it('stopped: a friendly saved notice with the mascot, wording varies, offline says it is kept here', async () => {
    let now = Date.now();
    const ui = await signedIn({ now: () => new Date(now) });
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      await ui.app.start({ id: 'T-104', title: 'Fix invoice rounding bug' });
      now += 25 * 60_000;
      await ui.app.stop();
      expect(pose(ui.$('#notice [data-moment="saved"]'))).toBe('mascot-small');
      // The mock server stamps the start with its own clock: only the minutes this test added are known.
      texts.push((ui.$('#notice span').textContent ?? '').replace(/\d+:\d\d/, 'H:MM'));
    }
    expect(texts).toEqual([
      'Saved H:MM on Fix invoice rounding bug. Nice work.',
      'H:MM on Fix invoice rounding bug, safely logged.',
      'Logged H:MM on Fix invoice rounding bug. Good moment for a stretch?',
    ]);
    await ui.app.start({ id: 'T-104', title: 'Fix invoice rounding bug' });
    now += 60 * 60_000;
    (ui.platform as { fetch: typeof fetch }).fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await ui.app.stop();
    expect(ui.$('#notice span').textContent).toMatch(/^\d+:\d\d on Fix invoice rounding bug is saved on this computer and goes to Beacon when you are back online\.$/);
    // Offline: a calm card with the reconnecting robot.
    expect(ui.$('#offline-title').textContent).toBe('Working offline');
    expect(pose(ui.$('#offline-card [data-moment="offline"]'))).toBe('pose-reconnect');
    ui.app.destroy();
  });

  it('a failed stop (server error) shows the error, not the saved notice', async () => {
    const ui = await signedIn();
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await env.control('config', { failNext: { status: 500, error: 'boom' } });
    await ui.app.stop();
    expect(ui.$('#notice')).toBeNull();
    expect(pose(ui.$('#error .error-art'))).toBe('pose-wrench');
    ui.app.destroy();
  });

  it(`long-running: after ${LONG_RUNNING_HOURS} h a calm nudge; Keep going hides it for that entry, Stop stops`, async () => {
    let now = Date.now();
    const ui = await signedIn({ now: () => new Date(now) });
    await ui.app.start({ id: 'T-102', title: 'Review pull request queue' });
    expect(ui.app.longRunning()).toBe(false);
    expect(ui.$('#long-running')).toBeNull();
    now += LONG_RUNNING_HOURS * 3600_000 + 60_000;
    await ui.app.tick();
    expect(ui.$('#long-running-title').textContent).toBe('Still going strong?');
    expect(ui.$('#long-running-text').textContent).toBe(`Review pull request queue has been on the clock for ${LONG_RUNNING_HOURS} hours. If you finished a while ago, stop it and fix the end time in Beacon.`);
    expect(pose(ui.$('#long-running [data-moment="longRunning"]'))).toBe('pose-hourglass');
    ui.click('#long-running-keep');
    expect(ui.$('#long-running')).toBeNull();
    expect(document.activeElement?.id).toBe('stop');
    await ui.app.tick();
    expect(ui.$('#long-running')).toBeNull();
    // A new entry gets its own nudge; its Stop button stops the timer.
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    now += LONG_RUNNING_HOURS * 3600_000;
    ui.app.render();
    expect(ui.$('#long-running')).not.toBeNull();
    ui.click('#long-running-stop');
    await tick(80);
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.$('#long-running')).toBeNull();
    ui.app.keepGoing();
    ui.app.destroy();
  });

  it('empty list and no search results have their own poses and copy', async () => {
    const ui = await signedIn({ locale: 'es' });
    const search = ui.$<HTMLInputElement>('#search');
    search.value = 'zzz';
    search.dispatchEvent(new Event('input'));
    await tick(80);
    expect(pose(ui.$('#tasks-empty [data-moment="noResults"]'))).toBe('pose-reading');
    expect(ui.$('#tasks-empty').textContent).toBe('Nada coincide con «zzz», y el robot ha repasado la lista dos veces. Solo aparecen tareas en las que puedes registrar tiempo.');
    search.value = '';
    search.dispatchEvent(new Event('input'));
    ui.app.tasks = [];
    ui.app.render();
    // No task at all: the "Open the tasks in Beacon" empty state (its own art, a dark-theme variant), and the pinned /
    // recent section steps aside so there is only one mascot on the main screen.
    expect(ui.$('#tasks-empty').getAttribute('data-empty')).toBe('tasks');
    expect(ui.$('#tasks-empty .empty-art').getAttribute('data-pose')).toBe('empty-tasks');
    expect(ui.$('#tasks-empty img.theme-light').getAttribute('srcset')).toBe('mascot/pose-empty-tasks.webp 1x, mascot/pose-empty-tasks@2x.webp 2x');
    expect(ui.$('#tasks-empty img.theme-dark').getAttribute('srcset')).toBe('mascot/pose-empty-tasks-dark.webp 1x, mascot/pose-empty-tasks-dark@2x.webp 2x');
    expect(ui.$('#tasks-empty').textContent).toContain('Abrir las tareas en Beacon');
    expect(ui.$('#quick-empty')).toBeNull();
    ui.app.destroy();
  });

  it('update card: small mascot on the offer, the wrench while downloading / installing; required uses the wrench', async () => {
    const ui = await signedIn();
    await env.control('config', { update: { version: '0.6.0', notes: 'x', pub_date: '2026-11-04T10:00:00Z', url: 'u', signature: 's' } });
    await ui.app.checkUpdates();
    expect(pose(ui.$('#update [data-moment]'))).toBe('mascot-small');
    ui.app.updateStage = 'downloading';
    ui.app.render();
    expect(pose(ui.$('#update [data-moment]'))).toBe('pose-wrench');
    await env.control('config', { update: { version: '0.6.0', notes: null, pub_date: '2026-11-04T10:00:00Z', url: 'u', signature: 's', min_supported_version: '0.6.0' } });
    ui.app.updateStage = 'offer';
    await ui.app.checkUpdates(true);
    expect(ui.app.view).toBe('update-required');
    expect(pose(ui.$('#update-required [data-moment="updateRequired"]'))).toBe('pose-wrench');
    ui.app.destroy();
  });

  it('Microsoft Store channel: About says the Store handles updates, kindly', async () => {
    const ui = await signedIn({ channel: 'store' });
    ui.click('#open-settings');
    expect(ui.$('#store-about').textContent).toBe('Sit back: it handles them in the background.');
    expect(pose(ui.$('#about [data-moment="about"]'))).toBe('mascot-small');
    ui.app.destroy();
  });

  it('idle check cards: still there, away and Resume each have their pose', async () => {
    const ui = await signedIn();
    const from = new Date(Date.now() - 20 * 60_000).toISOString();
    const base = { taskId: 'T-101', taskTitle: 'Write onboarding guide', from };
    ui.app.state = { ...ui.app.state, idleCheck: { phase: 'away', ...base } as never };
    ui.app.render();
    expect(pose(ui.$('[data-moment="away"] img'))).toBe('pose-pause');
    ui.app.state = { ...ui.app.state, idleCheck: { phase: 'resume', ...base } as never };
    ui.app.render();
    expect(pose(ui.$('[data-moment="resume"] img'))).toBe('pose-card');
    ui.app.destroy();
  });
});
