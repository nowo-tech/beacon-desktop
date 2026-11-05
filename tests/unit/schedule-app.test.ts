// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Timer } from '../../src/api/types';
import { MIN_GAP_MINUTES } from '../../src/lib/friendly';
import { REMINDERS } from '../../src/lib/reminders';
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

/** Thursday 2026-11-05, 09:00 in Madrid. */
const NINE = Date.parse('2026-11-05T08:00:00Z');
const HOURS = {
  timezone: 'Europe/Madrid',
  slots: [1, 2, 3, 4, 5].flatMap((day) => [
    { day, from: '09:00', to: '14:00' },
    { day, from: '15:00', to: '18:00' },
  ]),
};
const TASK = { id: 'T-101', title: 'Write onboarding guide' };

async function signedIn(options: { daysOff?: unknown; hours?: unknown; native?: boolean } = {}) {
  await env.control('config', { workingHours: options.hours === undefined ? HOURS : options.hours, daysOff: options.daysOff ?? null, locale: 'es' });
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  let now = NINE - 30 * 60_000;
  const platform = browserPlatform('0.5.0', nodeFetch);
  if (options.native === true) platform.hooks.notificationPermission = 'granted';
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale: 'es',
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 5,
    now: () => new Date(now),
    random: () => 0,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  await app.init();
  const done = app.connect(env.url);
  await tick();
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  expect(app.view).toBe('main');
  app.dismissWelcome();
  app.state = { ...app.state, lastTask: TASK };
  return {
    app,
    root,
    platform,
    hooks: platform.hooks,
    $,
    /** Sets the app's clock to `iso` and runs one regular check. */
    at: async (iso: string) => {
      now = Date.parse(iso);
      await app.tick();
    },
  };
}

type Ui = Awaited<ReturnType<typeof signedIn>>;

/** A running timer (local state only) since `iso`. */
function running(ui: Ui, iso: string) {
  ui.app.state = { ...ui.app.state, activeTimer: { id: 'E-1', taskId: TASK.id, taskTitle: TASK.title, startedAt: new Date(iso).toISOString() } as Timer };
  ui.app.render();
}

describe('working-hours reminders in the app', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('start time: a toast with the last task and a Start button that resumes it, once a day', async () => {
    const ui = await signedIn();
    expect(DEFAULT_SETTINGS.scheduleReminders).toBe(true);
    await ui.at('2026-11-05T07:59:00Z');
    expect(ui.$('#reminder')).toBeNull();
    // The host is asked to wake the UI on time for it.
    expect(ui.hooks.wakePlan?.reminderAt).toBe(NINE);
    await ui.at('2026-11-05T08:00:30Z');
    expect(ui.$('#reminder').getAttribute('data-kind')).toBe('start');
    expect(ui.$('#reminder-text').textContent).toBe('¿Empezamos? Última tarea: Write onboarding guide.');
    expect(ui.$('#reminder-text').getAttribute('lang')).toBe('es');
    expect(ui.$('#reminder img').getAttribute('data-pose')).toBe('sunrise');
    expect(ui.$('#reminder-action').textContent).toBe('Empezar');
    expect(loadLocal(localStorage).schedule.seen).toContain('start:2026-11-05');
    // The next reminder of the day is lunch.
    expect(ui.hooks.wakePlan?.reminderAt).toBe(Date.parse('2026-11-05T13:00:00Z'));
    ui.$('#reminder-action').click();
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    expect(ui.$('#reminder')).toBeNull();
    // Not again that day.
    ui.app.state = { ...ui.app.state, activeTimer: null };
    await ui.at('2026-11-05T08:05:00Z');
    expect(ui.$('#reminder')).toBeNull();
    ui.app.destroy();
  });

  it('start time with a timer already running: nothing, and not later that day either', async () => {
    const ui = await signedIn();
    running(ui, '2026-11-05T07:30:00Z');
    await ui.at('2026-11-05T08:00:00Z');
    expect(ui.$('#reminder')).toBeNull();
    expect(loadLocal(localStorage).schedule.seen).toContain('start:2026-11-05');
    ui.app.state = { ...ui.app.state, activeTimer: null };
    await ui.at('2026-11-05T08:03:00Z');
    expect(ui.$('#reminder')).toBeNull();
    ui.app.destroy();
  });

  it('desktop notification with the button; the button starts, the click only opens', async () => {
    const ui = await signedIn({ native: true });
    await ui.at('2026-11-05T08:00:00Z');
    await tick();
    expect(ui.hooks.friendly).toHaveLength(1);
    expect(ui.hooks.friendly[0]).toEqual({
      title: 'Hora de entrada',
      body: '¿Empezamos? Última tarea: Write onboarding guide.',
      pose: 'sunrise',
      action: { id: 'schedule-start', label: 'Empezar' },
    });
    expect(ui.$('#reminder')).toBeNull();
    ui.hooks.notificationAction('unknown');
    await tick();
    expect(ui.app.state.activeTimer).toBeNull();
    ui.hooks.notificationAction('schedule-start');
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    ui.app.destroy();
  });

  it('a refused notification falls back to the toast', async () => {
    const ui = await signedIn({ native: true });
    ui.hooks.friendlyFails = true;
    await ui.at('2026-11-05T08:00:00Z');
    await tick();
    expect(ui.$('#reminder-action').textContent).toBe('Empezar');
    ui.app.destroy();
  });

  it('lunch: "stop the timer?" with Stop; after lunch "back to X?" with Resume', async () => {
    const ui = await signedIn();
    running(ui, '2026-11-05T08:00:00Z');
    await ui.at('2026-11-05T13:00:00Z');
    expect(ui.$('#reminder-text').textContent).toBe('Hora de comer, ¿paro el temporizador?');
    expect(ui.$('#reminder img').getAttribute('data-pose')).toBe('lunch');
    expect(ui.$('#reminder-action').getAttribute('data-action')).toBe('stop');
    ui.$('#reminder-action').click();
    await tick(80);
    expect(ui.app.state.activeTimer).toBeNull();
    await ui.at('2026-11-05T14:01:00Z');
    expect(ui.$('#reminder-text').textContent).toBe('¿Retomamos Write onboarding guide?');
    expect(ui.$('#reminder-action').textContent).toBe('Retomar');
    // Started some other way: the Resume button goes away.
    running(ui, '2026-11-05T14:02:00Z');
    expect(ui.$('#reminder')).toBeNull();
    ui.app.destroy();
  });

  it('end of the day: "call it a day?" with today\'s total and Stop; bypasses the 50-min gap; no late card that evening', async () => {
    const ui = await signedIn();
    running(ui, '2026-11-05T15:00:00Z');
    ui.app.state = { ...ui.app.state, messages: { ...ui.app.state.messages, lastShownAt: '2026-11-05T16:50:00Z' } };
    await ui.at('2026-11-05T17:00:00Z');
    expect(ui.$('#reminder-text').textContent).toBe('¿Cerramos por hoy? Hoy llevas 2:00.');
    expect(ui.$('#reminder img').getAttribute('data-pose')).toBe('finished');
    const stored = loadLocal(localStorage);
    expect(stored.messages.seen).toContain('lateWork:2026-11-05');
    expect(stored.messages.lastShownAt).toBe('2026-11-05T17:00:00.000Z');
    // The friendly cards wait for the gap after it.
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).toBeNull();
    expect(MIN_GAP_MINUTES).toBe(50);
    ui.$('#reminder-action').click();
    await tick(80);
    expect(ui.app.state.activeTimer).toBeNull();
    ui.app.destroy();
  });

  it('sleep: a reminder missed by a few minutes fires on waking; hours later it does not', async () => {
    const ui = await signedIn();
    await ui.at('2026-11-05T08:12:00Z');
    expect(ui.$('#reminder')).not.toBeNull();
    ui.app.showReminderToast(null);
    running(ui, '2026-11-05T08:13:00Z');
    // Lid closed before lunch, opened at 18:40 with the timer running: no lunch, no end reminder.
    await ui.at('2026-11-05T17:40:00Z');
    expect(ui.$('#reminder')).toBeNull();
    expect(loadLocal(localStorage).schedule.seen).not.toContain('end:2026-11-05');
    ui.app.destroy();
  });

  it('holidays from Beacon and local days off: no reminders; a timer on one gets one friendly line', async () => {
    const ui = await signedIn({ daysOff: [{ date: '2026-11-05', kind: 'vacation' }] });
    await ui.at('2026-11-05T08:00:00Z');
    expect(ui.$('#reminder')).toBeNull();
    expect(ui.hooks.wakePlan?.reminderAt).toBe(Date.parse('2026-11-06T08:00:00Z'));
    running(ui, '2026-11-05T09:00:00Z');
    await ui.at('2026-11-05T09:01:00Z');
    expect(ui.$('#reminder').getAttribute('data-kind')).toBe('dayOff');
    expect(ui.$('#reminder-text').textContent).toBe(REMINDERS.es.lines.dayOff[0]?.text);
    expect(ui.$('#reminder-action')).toBeNull();
    ui.$('#reminder-dismiss').click();
    await ui.at('2026-11-05T13:00:00Z');
    expect(ui.$('#reminder')).toBeNull();
    ui.app.destroy();
  });

  it('respects its own switch, the pause and the "Still there?" question', async () => {
    const ui = await signedIn();
    ui.app.setScheduleSetting({ scheduleReminders: false });
    await ui.at('2026-11-05T08:00:00Z');
    expect(ui.$('#reminder')).toBeNull();
    expect(ui.hooks.wakePlan?.reminderAt).toBeNull();
    ui.app.setScheduleSetting({ scheduleReminders: true });
    await ui.app.pauseFriendly(true);
    await ui.at('2026-11-05T08:01:00Z');
    expect(ui.$('#reminder')).toBeNull();
    await ui.app.pauseFriendly(false);
    ui.app.state = { ...ui.app.state, idleCheck: { phase: 'asking', taskId: 'T-101', taskTitle: TASK.title, from: '2026-11-05T07:40:00Z', askedAt: '2026-11-05T07:59:00Z', returnedAt: null, timerStartedAt: '2026-11-05T07:00:00Z' } };
    ui.app.checkReminders();
    expect(ui.$('#reminder')).toBeNull();
    ui.app.state = { ...ui.app.state, idleCheck: { phase: 'watching' } };
    ui.app.checkReminders();
    expect(ui.$('#reminder')).not.toBeNull();
    ui.app.destroy();
  });

  it('Settings → My schedule: prefilled from Beacon, local values marked, reset, lead time and local days off', async () => {
    const ui = await signedIn();
    ui.app.show('settings');
    expect(ui.$('#schedule-title').textContent).toBe('Mi horario');
    expect(ui.$<HTMLInputElement>('#schedule-reminders').checked).toBe(true);
    expect(ui.$('#schedule-source').textContent).toContain('Beacon');
    expect(ui.$('#day-4-summary').textContent).toBe('09:00–18:00 · comida 14:00–15:00');
    expect(ui.$('#day-6-summary').textContent).toBe('Libre');
    expect(ui.$<HTMLInputElement>('#day-4-start').value).toBe('09:00');
    expect(ui.$('#day-4-start-source').getAttribute('data-source')).toBe('beacon');
    expect(ui.$<HTMLButtonElement>('#schedule-reset').disabled).toBe(true);
    // Earlier start on Thursdays, no lunch on Fridays, Saturday morning.
    const start = ui.$<HTMLInputElement>('#day-4-start');
    start.value = '08:30';
    start.dispatchEvent(new Event('change'));
    const lunch = ui.$<HTMLInputElement>('#day-5-lunchStart');
    lunch.value = '';
    lunch.dispatchEvent(new Event('change'));
    const saturday = ui.$<HTMLInputElement>('#day-6-off');
    saturday.checked = false;
    saturday.dispatchEvent(new Event('change'));
    expect(loadLocal(localStorage).schedule.overrides).toEqual({ 4: { start: '08:30' }, 5: { lunchStart: null }, 6: { off: false } });
    expect(ui.$('#day-4-start-source').getAttribute('data-source')).toBe('local');
    expect(ui.$('#day-4-start-source').textContent).toBe('Este equipo');
    expect(ui.$('#day-4-end-source').textContent).toBe('Beacon');
    expect(ui.$('#day-4').getAttribute('data-local')).toBe('true');
    expect(ui.$('#day-5-summary').textContent).toBe('09:00–18:00');
    expect(ui.$('#day-6-summary').textContent).toBe('Sin horario');
    // The local start time drives the reminder.
    ui.app.show('main');
    await ui.at('2026-11-05T07:30:00Z');
    expect(ui.$('#reminder')).not.toBeNull();
    ui.app.show('settings');
    // Lead time.
    const lead = ui.$<HTMLSelectElement>('#schedule-lead');
    expect([...lead.options].map((option) => option.textContent)).toEqual(['A la hora de entrada', '5 min antes', '10 min antes', '15 min antes']);
    lead.value = '10';
    lead.dispatchEvent(new Event('change'));
    expect(loadLocal(localStorage).settings.scheduleLeadMinutes).toBe(10);
    // Reset.
    ui.$('#schedule-reset').click();
    expect(loadLocal(localStorage).schedule.overrides).toEqual({});
    expect(ui.$('#day-4-summary').textContent).toBe('09:00–18:00 · comida 14:00–15:00');
    // A local day off: listed, removable, and it silences the reminders.
    expect(ui.$('#days-off-empty')).not.toBeNull();
    const date = ui.$<HTMLInputElement>('#day-off-date');
    date.value = '2026-11-06';
    date.dispatchEvent(new Event('input'));
    ui.$<HTMLFormElement>('#day-off-form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(loadLocal(localStorage).schedule.daysOff).toEqual([{ date: '2026-11-06' }]);
    expect(ui.$('#days-off-list li').getAttribute('data-source')).toBe('local');
    expect(ui.$('#days-off-list .day-off-label').textContent).toBe('Día libre');
    ui.app.show('main');
    await ui.at('2026-11-06T07:50:00Z');
    expect(ui.$('#reminder')).toBeNull();
    ui.app.show('settings');
    ui.$('#day-off-remove-2026-11-06').click();
    expect(loadLocal(localStorage).schedule.daysOff).toEqual([]);
    // A day stays open across renders.
    const day = ui.$<HTMLDetailsElement>('#day-2');
    day.open = true;
    day.dispatchEvent(new Event('toggle'));
    ui.app.render();
    expect(ui.$<HTMLDetailsElement>('#day-2').open).toBe(true);
    ui.app.destroy();
  });

  it("Beacon's holidays are listed read-only; without Beacon hours the week is set here", async () => {
    const ui = await signedIn({ hours: null, daysOff: [{ date: '2026-12-08', kind: 'holiday', label: 'Inmaculada' }, { date: '2026-12-24', kind: 'vacation' }] });
    ui.app.show('settings');
    expect(ui.$('#schedule-source').textContent).toBe('Beacon no publica tu horario: defínelo aquí (solo en este equipo).');
    expect(ui.$('#day-1-summary').textContent).toBe('Sin horario');
    expect(ui.$('#day-1-start-source')).toBeNull();
    expect(ui.$<HTMLButtonElement>('#schedule-reset').disabled).toBe(true);
    const items = [...ui.root.querySelectorAll('#days-off-list li')];
    expect(items.map((item) => item.querySelector('.day-off-label')?.textContent)).toEqual(['Inmaculada', 'Vacaciones']);
    expect(items.every((item) => item.querySelector('button') === null)).toBe(true);
    const end = ui.$<HTMLInputElement>('#day-1-end');
    end.value = '17:00';
    end.dispatchEvent(new Event('change'));
    expect(ui.$('#day-1-end-source').textContent).toBe('Este equipo');
    ui.app.destroy();
  });

  it('offline start uses the last Beacon schedule; signing out forgets it', async () => {
    const ui = await signedIn();
    expect(loadLocal(localStorage).schedule.beacon?.workingHours).toEqual(HOURS);
    ui.app.me = null;
    expect(ui.app.scheduleView().beacon?.[4].start).toBe('09:00');
    await ui.app.logout();
    expect(loadLocal(localStorage).schedule).toEqual({ overrides: {}, daysOff: [], seen: [], recent: {}, beacon: null });
    expect(ui.app.reminderToast).toBeNull();
    // Signed out: no reminders.
    ui.app.checkReminders();
    expect(ui.hooks.wakePlan?.reminderAt ?? null).toBeNull();
    ui.app.destroy();
  });

  it('actions ignore what no longer applies', async () => {
    const ui = await signedIn();
    await ui.app.reminderAction(null);
    await ui.app.reminderAction('stop');
    expect(ui.app.state.activeTimer).toBeNull();
    running(ui, '2026-11-05T08:00:00Z');
    await ui.app.reminderAction('resume');
    expect(ui.app.state.activeTimer?.startedAt).toBe('2026-11-05T08:00:00.000Z');
    ui.app.destroy();
  });
});
