// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDLE_COUNTDOWN_MINUTES, MEETING_COUNTDOWN_MINUTES } from '../../src/lib/friendly';
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
  const platform = browserPlatform('0.5.0', nodeFetch);
  const app = new DesktopApp(root, platform, {
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
  return { app, platform, $, root, advance: (minutes: number) => void (now += minutes * 60_000), click: (selector: string) => $(selector).click() };
}

/** A timer started `minutes` ago (local state only) and Beacon's answer with the user's locale and time zone. */
function running(ui: Awaited<ReturnType<typeof signedIn>>, minutes: number, me: Partial<Me> & { locale?: string } = {}, taskTitle = 'Write onboarding guide') {
  const timer: Timer = { id: 'E-1', taskId: 'T-101', taskTitle, startedAt: new Date(NOW - minutes * 60_000).toISOString() } as Timer;
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

  it('the 2 h milestone: a toast with a decorative pose, never focused, dismissible, then rate limited', async () => {
    const ui = await signedIn();
    running(ui, 121);
    const search = ui.$<HTMLInputElement>('#search');
    search.focus();
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).not.toBeNull();
    expect(ui.$('#cheer').closest('#toasts')?.getAttribute('aria-live')).toBe('polite');
    expect(ui.$('#cheer').getAttribute('aria-label')).toBe('A note from the robot');
    expect(ui.$('#cheer').getAttribute('data-kind')).toBe('milestone');
    expect(ui.$('#cheer-text').textContent).toBe('2 hours of solid work. That deserves a medal!');
    expect(ui.$('#cheer-text').getAttribute('lang')).toBe('en');
    expect(ui.$('#cheer-dismiss').getAttribute('aria-label')).toBe('Dismiss');
    const picture = ui.$('#cheer img');
    expect(picture.getAttribute('data-pose')).toBe('achievement');
    expect(picture.getAttribute('src')).toBe('mascot/pose-achievement.webp');
    expect(picture.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(search);
    // Kept across a reload (local storage), the same line.
    expect(loadLocal(localStorage).messages.card).toMatchObject({ kind: 'milestone', line: 0 });
    ui.click('#cheer-dismiss');
    expect(ui.$('#cheer')).toBeNull();
    expect(loadLocal(localStorage).messages.card?.dismissed).toBe(true);
    // The next cheer (4 h) waits for its threshold and the rate limit.
    ui.advance(MIN_GAP_MINUTES - 1);
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).toBeNull();
    ui.advance(120);
    await ui.app.tick();
    expect(ui.$('#cheer-text').textContent).toContain('4');
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
    expect(ui.$('#cheer-dismiss').getAttribute('aria-label')).toBe('Dismiss');
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
    expect(ui.$('#idle-here').textContent).toBe('Keep: yes, it was work');
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

  it('no card without a running timer; on another view it is planned (desktop notification) but no toast is drawn', async () => {
    const ui = await signedIn();
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).toBeNull();
    expect(ui.app.currentCard()).toBeNull();
    running(ui, 121);
    ui.app.show('settings');
    ui.app.checkFriendly();
    expect(ui.app.state.messages.card?.kind).toBe('milestone');
    expect(ui.$('#cheer')).toBeNull();
    ui.app.dismissCheer();
    ui.app.destroy();
  });

  type Internals = { setIdleCheck(state: unknown): void; saved(timer: Timer, queued: boolean): void };
  const internals = (ui: Awaited<ReturnType<typeof signedIn>>) => ui.app as unknown as Internals;
  const asking = (ui: Awaited<ReturnType<typeof signedIn>>, idleMinutes = 11) => ({
    phase: 'asking',
    taskId: 'T-101',
    taskTitle: ui.app.state.activeTimer?.taskTitle,
    from: new Date(NOW - idleMinutes * 60_000).toISOString(),
    askedAt: new Date(NOW).toISOString(),
    returnedAt: null,
    timerStartedAt: ui.app.state.activeTimer?.startedAt,
  });

  it(`countdown: ${IDLE_COUNTDOWN_MINUTES} min shown as text and a bar; at 0 the timer stops at the start of the idle time`, async () => {
    const ui = await signedIn();
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    const startedAt = ui.app.state.activeTimer?.startedAt as string;
    internals(ui).setIdleCheck({ ...asking(ui), timerStartedAt: startedAt, from: new Date(Math.max(Date.parse(startedAt), NOW - 11 * 60_000)).toISOString() });
    expect(ui.$('#idle-countdown-text').textContent).toBe('The timer pauses in 2:00 if there is no answer.');
    expect(ui.$('#idle-countdown [role="progressbar"]').getAttribute('aria-valuenow')).toBe(String(IDLE_COUNTDOWN_MINUTES * 60));
    expect(ui.$<HTMLElement>('#idle-countdown-fill').style.transform).toBe('scaleX(1)');
    ui.advance(1);
    ui.app.render();
    expect(ui.$('#idle-countdown-text').textContent).toBe('The timer pauses in 1:00 if there is no answer.');
    const from = (ui.app.state.idleCheck as { from: string }).from;
    ui.advance(IDLE_COUNTDOWN_MINUTES);
    await ui.app.tick();
    expect(ui.app.state.idleCheck.phase).toBe('away');
    expect(ui.app.state.activeTimer).toBeNull();
    const state = (await env.control('state')) as { entries: Record<string, { endedAt: string }[]> };
    expect(Object.values(state.entries).flat().at(-1)?.endedAt).toBe(from);
    // Paused, still a modal: "I stopped your timer at …" and Resume now on the same task.
    expect(ui.$('#idle-away').getAttribute('aria-modal')).toBe('true');
    expect(ui.$('#idle-away-text').textContent).toContain('I stopped your timer at');
    expect(document.activeElement?.id).toBe('idle-resume-now');
    ui.click('#idle-resume-now');
    for (let i = 0; i < 20 && ui.app.state.activeTimer === null; i++) await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    expect(ui.$('#idle-modal').hidden).toBe(true);
    ui.app.destroy();
  });

  it('an answer before 0 cancels the countdown', async () => {
    const ui = await signedIn();
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    internals(ui).setIdleCheck({ ...asking(ui, 0.5), timerStartedAt: ui.app.state.activeTimer?.startedAt });
    expect(ui.$('#idle-countdown')).not.toBeNull();
    ui.click('#idle-here');
    for (let i = 0; i < 20 && ui.app.state.idleCheck.phase !== 'watching'; i++) await tick();
    expect(ui.$('#idle-countdown')).toBeNull();
    ui.advance(IDLE_COUNTDOWN_MINUTES + 1);
    await ui.app.tick();
    expect(ui.app.state.activeTimer).not.toBeNull();
    ui.app.destroy();
  });

  it('sleep: a countdown that ran out while asleep still stops at the idle start, even if an input woke the computer', async () => {
    const ui = await signedIn();
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await ui.app.tick();
    internals(ui).setIdleCheck({ ...asking(ui, 0.5), timerStartedAt: ui.app.state.activeTimer?.startedAt });
    ui.advance(180);
    ui.platform.hooks.idleSeconds = 1;
    await ui.app.tick();
    expect(ui.app.state.activeTimer).toBeNull();
    expect(['away', 'gap']).toContain(ui.app.state.idleCheck.phase);
    ui.app.destroy();
  });

  it(`meetings: "Still in the meeting?" with the teamwork pose and a ${MEETING_COUNTDOWN_MINUTES} min countdown; same buttons`, async () => {
    const ui = await signedIn({ locale: 'es' });
    running(ui, 30, { locale: 'es' }, 'Daily del equipo');
    expect(ui.app.inMeeting()).toBe(true);
    expect(ui.app.idleSettings().answerTimeoutMinutes).toBe(MEETING_COUNTDOWN_MINUTES);
    internals(ui).setIdleCheck(asking(ui));
    expect(ui.$('#idle-title').textContent).toBe('¿Sigues en la reunión?');
    expect(ui.$('#idle-quip').textContent).toBe(CATALOG.es.pools.meetingIdle[0]?.text);
    expect(ui.$('#idle img').getAttribute('data-pose')).toBe('teamwork');
    expect(ui.$('#idle-countdown-text').textContent).toContain(`${MEETING_COUNTDOWN_MINUTES}:00`);
    expect(ui.$('#idle-here')).not.toBeNull();
    expect(ui.$('#idle-pause')).not.toBeNull();
    // Fun messages off: still the softer heading and pose, without the extra line.
    ui.app.setFriendly('funMessages', false);
    expect(ui.$('#idle-title').textContent).toBe('¿Sigues en la reunión?');
    expect(ui.$('#idle-quip')).toBeNull();
    expect(ui.$('#idle img').getAttribute('data-pose')).toBe('teamwork');
    ui.app.destroy();
  });

  it('a stopped daily shows a "daily done" toast; a long meeting makes the next card a coffee / stretch line', async () => {
    const ui = await signedIn({ locale: 'es' });
    running(ui, 15, { locale: 'es' }, 'Daily stand-up');
    internals(ui).saved({ id: 'E-1', taskId: 'T-9', taskTitle: 'Daily stand-up', startedAt: new Date(NOW - 15 * 60_000).toISOString() } as Timer, false);
    expect(ui.$('#daily-toast-text').textContent).toBe(CATALOG.es.pools.dailyDone[0]?.text);
    expect(ui.$('#daily-toast-text').getAttribute('lang')).toBe('es');
    expect(ui.app.state.messages.afterMeeting).toBeNull();
    ui.click('#daily-toast-dismiss');
    expect(ui.$('#daily-toast')).toBeNull();
    internals(ui).saved({ id: 'E-2', taskId: 'T-9', taskTitle: 'Reunión con Acme', startedAt: new Date(NOW - 75 * 60_000).toISOString() } as Timer, false);
    expect(ui.$('#daily-toast')).toBeNull();
    expect(ui.app.state.messages.afterMeeting).not.toBeNull();
    running(ui, 5, { locale: 'es' });
    ui.app.checkFriendly();
    expect(ui.$('#cheer').getAttribute('data-kind')).toBe('meetingAfter');
    ui.app.destroy();
  });
});
