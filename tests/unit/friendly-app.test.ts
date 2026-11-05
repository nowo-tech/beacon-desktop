// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Me, Timer } from '../../src/api/types';
import { CATALOG, CARD_TTL_MINUTES, MIN_GAP_MINUTES } from '../../src/lib/friendly';
import { DEFAULT_SETTINGS, loadLocal } from '../../src/lib/settings';
import { browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

/** Tuesday 2026-11-03, 14:45 in Madrid: no English moment is due, Spanish lunch is (14:00–15:30). */
const NOW = Date.parse('2026-11-03T13:45:00Z');

async function signedIn(options: { locale?: 'en' | 'es'; random?: () => number } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  let now = NOW;
  const app = new DesktopApp(root, browserPlatform('0.5.0', nodeFetch), {
    storage: localStorage,
    locale: options.locale ?? 'en',
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 5,
    now: () => new Date(now),
    random: options.random ?? (() => 0),
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  await app.init();
  const done = app.connect(env.url);
  await tick();
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  expect(app.view).toBe('main');
  return { app, $, root, advance: (minutes: number) => void (now += minutes * 60_000), click: (selector: string) => $(selector).click() };
}

/** A timer started `minutes` ago (local state only) and Beacon's answer with the user's locale and time zone. */
function running(ui: Awaited<ReturnType<typeof signedIn>>, minutes: number, me: Partial<Me> & { locale?: string } = {}) {
  const timer: Timer = { id: 'E-1', taskId: 'T-101', taskTitle: 'Write onboarding guide', startedAt: new Date(NOW - minutes * 60_000).toISOString() } as Timer;
  ui.app.me = { ...(ui.app.me as Me), workingHours: { timezone: 'Europe/Madrid', slots: [] }, ...me } as Me;
  ui.app.state = { ...ui.app.state, activeTimer: timer, idleCheck: { phase: 'watching' } };
  ui.app.render();
}

describe('friendly messages in the app', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('a cheer after 2 h: calm card, decorative pose, never focused, dismissible, then rate limited', async () => {
    const ui = await signedIn();
    running(ui, 121);
    const search = ui.$<HTMLInputElement>('#search');
    search.focus();
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).not.toBeNull();
    expect(ui.$('#cheer').getAttribute('role')).toBe('region');
    expect(ui.$('#cheer').getAttribute('aria-label')).toBe('A note from the robot');
    expect(ui.$('#cheer').getAttribute('data-kind')).toBe('cheer');
    expect(ui.$('#cheer-text').textContent).toBe('2 hours in and still going strong. Look at you!');
    expect(ui.$('#cheer-text').getAttribute('lang')).toBe('en');
    const picture = ui.$('#cheer img');
    expect(picture.getAttribute('data-pose')).toBe(CATALOG.en.pools.cheer[0]?.pose);
    expect(picture.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(search);
    // Kept across a reload (local storage), the same line.
    expect(loadLocal(localStorage).messages.card).toMatchObject({ kind: 'cheer', line: 0 });
    ui.click('#cheer-dismiss');
    expect(ui.$('#cheer')).toBeNull();
    expect(loadLocal(localStorage).messages.card?.dismissed).toBe(true);
    // The next cheer (4 h) waits for its threshold and the rate limit.
    ui.advance(MIN_GAP_MINUTES - 1);
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).toBeNull();
    ui.advance(120);
    await ui.app.tick();
    expect(ui.$('#cheer-text').textContent).not.toBe('2 hours in and still going strong. Look at you!');
    // It expires by itself.
    ui.advance(CARD_TTL_MINUTES);
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).toBeNull();
    ui.app.destroy();
  });

  it('Beacon locale first: a Spanish user gets the Spanish lunch moment in an English UI', async () => {
    const ui = await signedIn({ locale: 'en' });
    running(ui, 30, { locale: 'es_ES' });
    expect(ui.app.messageLocale()).toBe('es');
    ui.app.checkFriendly();
    expect(ui.$('#cheer').getAttribute('data-kind')).toBe('lunch');
    expect(ui.$('#cheer-text').textContent).toBe(CATALOG.es.pools.lunch[0]?.text);
    expect(ui.$('#cheer-text').getAttribute('lang')).toBe('es');
    expect(ui.$('#cheer-dismiss').textContent).toBe('Thanks!');
    ui.app.destroy();
  });

  it('fallback: unknown Beacon locale → the UI locale; none → the UI locale', async () => {
    const ui = await signedIn({ locale: 'es' });
    running(ui, 30, { locale: 'ja' });
    expect(ui.app.messageLocale()).toBe('es');
    ui.app.me = null;
    expect(ui.app.messageLocale()).toBe('es');
    ui.app.destroy();
  });

  it('Settings: both switches on by default; off hides the card at once and stops new ones', async () => {
    const ui = await signedIn();
    expect(DEFAULT_SETTINGS.funMessages).toBe(true);
    expect(DEFAULT_SETTINGS.wellbeingReminders).toBe(true);
    running(ui, 121);
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).not.toBeNull();
    ui.click('#open-settings');
    const fun = ui.$<HTMLInputElement>('#fun-messages');
    const care = ui.$<HTMLInputElement>('#wellbeing-reminders');
    expect(fun.checked).toBe(true);
    expect(care.checked).toBe(true);
    expect(ui.$('#wellbeing-reminders-help').textContent).toContain(`${MIN_GAP_MINUTES} minutes`);
    fun.checked = false;
    fun.dispatchEvent(new Event('change'));
    care.checked = false;
    care.dispatchEvent(new Event('change'));
    expect(loadLocal(localStorage).settings).toMatchObject({ funMessages: false, wellbeingReminders: false });
    ui.app.show('main');
    expect(ui.$('#cheer')).toBeNull();
    ui.app.state = { ...ui.app.state, messages: { ...ui.app.state.messages, card: null, lastShownAt: null, seen: [] } };
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).toBeNull();
    ui.app.destroy();
  });

  it('not over the "Still there?" prompt, which gets its own phrasing and pose; the facts and buttons stay', async () => {
    const ui = await signedIn({ random: () => 0.5 });
    running(ui, 121, { locale: 'de' });
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).not.toBeNull();
    const asking = { phase: 'asking', taskId: 'T-101', taskTitle: 'Write onboarding guide', from: new Date(NOW - 11 * 60_000).toISOString(), askedAt: new Date(NOW - 60_000).toISOString(), returnedAt: null, timerStartedAt: ui.app.state.activeTimer?.startedAt };
    (ui.app as unknown as { setIdleCheck(state: unknown): void }).setIdleCheck(asking);
    expect(ui.$('#cheer')).toBeNull();
    const line = ui.app.state.messages.idleLine as number;
    expect(ui.$('#idle-title').textContent).toBe('Still there?');
    expect(ui.$('#idle-quip').textContent).toBe(CATALOG.de.pools.idle[line]?.text);
    expect(ui.$('#idle-quip').getAttribute('lang')).toBe('de');
    expect(ui.$('#idle img').getAttribute('data-pose')).toBe(CATALOG.de.pools.idle[line]?.pose);
    expect(ui.$('#idle-text').textContent).toContain('Write onboarding guide');
    expect(ui.$('#idle-here').textContent).toBe("Yes, I'm here");
    // Answered: the phrasing is cleared, the next prompt gets another one.
    (ui.app as unknown as { setIdleCheck(state: unknown): void }).setIdleCheck({ phase: 'watching' });
    expect(ui.app.state.messages.idleLine).toBeNull();
    (ui.app as unknown as { setIdleCheck(state: unknown): void }).setIdleCheck(asking);
    expect(ui.app.state.messages.idleLine).not.toBe(line);
    ui.app.destroy();
  });

  it('Fun messages off: the plain "Still there?" prompt with its usual pose', async () => {
    const ui = await signedIn();
    ui.app.setFriendly('funMessages', false);
    running(ui, 30);
    const asking = { phase: 'asking', taskId: 'T-101', taskTitle: 'Write onboarding guide', from: new Date(NOW - 11 * 60_000).toISOString(), askedAt: new Date(NOW - 60_000).toISOString(), returnedAt: null, timerStartedAt: ui.app.state.activeTimer?.startedAt };
    (ui.app as unknown as { setIdleCheck(state: unknown): void }).setIdleCheck(asking);
    expect(ui.$('#idle-quip')).toBeNull();
    expect(ui.$('#idle img').getAttribute('data-pose')).toBe('mascot-small');
    ui.app.destroy();
  });

  it('no card without a running timer or outside the main view', async () => {
    const ui = await signedIn();
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).toBeNull();
    expect(ui.app.currentCard()).toBeNull();
    running(ui, 121);
    ui.app.show('settings');
    ui.app.checkFriendly();
    expect(ui.app.state.messages.card).toBeNull();
    ui.app.dismissCheer();
    ui.app.destroy();
  });
});
