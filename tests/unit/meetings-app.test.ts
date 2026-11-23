// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Timer } from '../../src/api/types';
import { pauseMessages } from '../../src/lib/friendly';
import { MIC_POLL_SECONDS } from '../../src/lib/meetings';
import { loadLocal } from '../../src/lib/settings';
import { browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock, until } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

/** Thursday 2026-11-05, 10:00 in Madrid (working hours 09:00–14:00, 15:00–18:00). */
const TEN = Date.parse('2026-11-05T09:00:00Z');
const MIN = 60_000;
const HOURS = {
  timezone: 'Europe/Madrid',
  slots: [1, 2, 3, 4, 5].flatMap((day) => [
    { day, from: '09:00', to: '14:00' },
    { day, from: '15:00', to: '18:00' },
  ]),
};
const DOCS = { id: 'T-101', title: 'Write onboarding guide' };
const CALL = { id: 'T-103', title: 'Customer call: Acme quarterly review' };

async function signedIn(options: { native?: boolean; enable?: boolean } = {}) {
  await env.control('config', { workingHours: HOURS, locale: 'es' });
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  let now = TEN;
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
  await until(() => $('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  app.dismissWelcome();
  if (options.enable !== false) await app.setFeature('meetingDetection', true);
  return {
    app,
    root,
    hooks: platform.hooks,
    $,
    /** The host reports the microphone every 20 s from `from` to `to` minutes after 10:00 (the app's clock follows). */
    call: async (from: number, to: number, apps: string[] = ['teams']) => {
      for (let at = from * MIN; at <= to * MIN; at += MIC_POLL_SECONDS * 1000) {
        now = TEN + at;
        platform.hooks.mic({ at: now, inUse: apps.length > 0, apps, source: 'process' });
      }
      await tick();
    },
  };
}

type Ui = Awaited<ReturnType<typeof signedIn>>;

function running(ui: Ui, task: { id: string; title: string }, startedAt = TEN - 30 * MIN) {
  ui.app.state = { ...ui.app.state, activeTimer: { id: 'E-1', taskId: task.id, taskTitle: task.title, startedAt: new Date(startedAt).toISOString() } as Timer };
  ui.app.render();
}

describe('meeting detection in the app', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('is off by default: the host never looks at the microphone and reports are ignored', async () => {
    const ui = await signedIn({ enable: false });
    expect(ui.app.state.settings.meetingDetection).toBe(false);
    expect(ui.hooks.wakePlan?.micEverySeconds).toBeUndefined();
    await ui.call(0, 5);
    expect(ui.app.state.meeting.phase).toBe('idle');
    expect(ui.$('#meeting')).toBeNull();
    ui.app.show('settings');
    const toggle = ui.$<HTMLInputElement>('#feature-meetingDetection');
    expect(toggle.checked).toBe(false);
    expect(ui.$('#meeting-privacy').textContent).toContain('Nunca lee títulos de ventanas');
    expect(ui.$('.meeting-options')).toBeNull();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await tick();
    expect(ui.hooks.wakePlan?.micEverySeconds).toBe(MIC_POLL_SECONDS);
    expect(loadLocal(localStorage).consents.meetingDetection?.granted).toBe(true);
    expect(ui.$('#consent-meetingDetection')).not.toBeNull();
    expect(ui.$('#meeting-status').textContent).toBe('Comprobando el micrófono…');
    ui.app.destroy();
  });

  it('no timer: asks after 2 minutes, "Generic meeting" asks once which task, then the end offers to stop', async () => {
    const ui = await signedIn({ native: true });
    await ui.call(0, 1.9);
    expect(ui.$('#meeting')).toBeNull();
    // The softer "Still in the meeting?" applies during the call.
    expect(ui.app.inMeeting()).toBe(true);
    await ui.call(2, 2);
    expect(ui.app.view).toBe('main');
    expect(ui.$('#meeting-text').textContent).toBe('Parece que estás en una reunión (Teams). ¿Qué reunión es?');
    expect(ui.$('#meeting img').getAttribute('data-pose')).toBe('teamwork');
    expect([...ui.root.querySelectorAll('#meeting-actions button')].map((b) => b.textContent)).toEqual(['Elegir tarea', 'Reunión genérica', 'No es una reunión', 'No preguntar con esta app']);
    // Desktop notification with the pose, no button yet (no generic meeting): a click opens the window.
    expect(ui.hooks.friendly.at(-1)).toEqual({ title: '¿Reunión?', body: 'Parece que estás en una reunión (Teams). ¿Qué reunión es?', pose: 'teamwork', action: null });
    ui.$('#meeting-generic').click();
    await tick();
    expect(ui.$('#meeting-generic-help')).not.toBeNull();
    // Meeting-like tasks first, marked.
    const first = ui.root.querySelector('#meeting-tasks li') as HTMLElement;
    expect(first.textContent).toContain(CALL.title);
    expect(first.querySelector('.meeting-badge')?.textContent).toBe('Reunión');
    ui.$(`#meeting-task-${CALL.id}`).click();
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe(CALL.id);
    expect(ui.app.state.settings.meetingGeneric).toEqual(CALL);
    expect(ui.app.state.meeting.phase).toBe('tracking');
    expect(ui.$('#meeting')).toBeNull();
    // The call ends: free for a minute.
    await ui.call(30, 31, []);
    expect(ui.$('#meeting-text').textContent).toBe('Reunión terminada (30 min). ¿Paro el temporizador?');
    expect(ui.hooks.friendly.at(-1)?.action).toEqual({ id: 'meeting-stop', label: 'Parar' });
    ui.$('#meeting-stop').click();
    await tick(80);
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.app.state.meeting.phase).toBe('idle');
    ui.app.destroy();
  });

  it('a non-meeting timer: "Switch to the meeting" from the notification, then "Back" to the previous task', async () => {
    const ui = await signedIn({ native: true });
    ui.app.setMeetingSetting({ meetingGeneric: CALL });
    running(ui, DOCS);
    await ui.call(0, 2, ['browser']);
    expect(ui.$('#meeting-text').textContent).toBe('Parece que estás en una reunión (llamada en el navegador) y el reloj sigue en Write onboarding guide. ¿Cambiamos a la reunión?');
    expect(ui.hooks.friendly.at(-1)?.action).toEqual({ id: 'meeting-switch', label: 'Cambiar a la reunión' });
    ui.hooks.notificationAction('meeting-switch');
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe(CALL.id);
    expect(ui.app.state.meeting.previous).toEqual(DOCS);
    // A stale button does nothing.
    ui.hooks.notificationAction('meeting-back');
    await tick();
    expect(ui.app.state.activeTimer?.taskId).toBe(CALL.id);
    await ui.call(2.5, 32, ['browser']);
    await ui.call(32.25, 33.5, []);
    expect(ui.$('#meeting-text').textContent).toBe('Reunión terminada (32 min). ¿Volver a Write onboarding guide?');
    expect(ui.hooks.friendly.at(-1)).toEqual({ title: 'Reunión terminada', body: 'Reunión terminada (32 min). ¿Volver a Write onboarding guide?', pose: 'teamwork', action: { id: 'meeting-back', label: 'Volver' } });
    ui.hooks.notificationAction('meeting-back');
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe(DOCS.id);
    expect(ui.$('#meeting')).toBeNull();
    ui.app.destroy();
  });

  it('"Choose task" with a search', async () => {
    const ui = await signedIn();
    await ui.call(0, 2, ['zoom']);
    ui.$('#meeting-choose').click();
    await tick();
    expect(ui.$('#meeting-choose')).toBeNull();
    const search = ui.$<HTMLInputElement>('#meeting-search');
    search.value = 'factura';
    search.dispatchEvent(new Event('input'));
    expect(ui.$('#meeting-tasks-empty').textContent).toBe('Ninguna tarea coincide.');
    const again = ui.$<HTMLInputElement>('#meeting-search');
    again.value = 'INVOICE';
    again.dispatchEvent(new Event('input'));
    ui.$('#meeting-task-T-104').click();
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-104');
    expect(ui.app.state.settings.meetingGeneric).toBeNull();
    // Cancel goes back to the answers.
    ui.app.state = { ...ui.app.state, meeting: { ...ui.app.state.meeting, phase: 'asking' } };
    ui.app.meetingPicker = 'task';
    ui.app.render();
    ui.$('#meeting-picker-cancel').click();
    expect(ui.$('#meeting-choose')).not.toBeNull();
    ui.app.destroy();
  });

  it('"Not a meeting", "Don\'t ask for this app" (undone in Settings) and ×', async () => {
    const ui = await signedIn();
    await ui.call(0, 2, ['slack']);
    ui.$('#meeting-notMeeting').click();
    expect(ui.$('#meeting')).toBeNull();
    expect(ui.app.state.meeting.phase).toBe('ignored');
    await ui.call(2.5, 10, ['slack']);
    expect(ui.$('#meeting')).toBeNull();
    // Over, and a new Zoom call (after the question gap): "Don't ask for this app".
    await ui.call(10.5, 12, []);
    await ui.call(13, 15, ['zoom']);
    expect(ui.$('#meeting-text').textContent).toContain('(Zoom)');
    ui.$('#meeting-mute').click();
    expect(ui.app.state.settings.meetingMuted).toEqual(['zoom']);
    await ui.call(15.5, 17, []);
    await ui.call(30, 40, ['zoom']);
    expect(ui.$('#meeting')).toBeNull();
    ui.app.show('settings');
    expect(ui.$('#meeting-muted').textContent).toContain('Zoom');
    expect(ui.$('#meeting-status').textContent).toBe('Ahora: el micrófono está en uso (Zoom).');
    ui.$('#meeting-unmute-zoom').click();
    expect(ui.app.state.settings.meetingMuted).toEqual([]);
    ui.app.show('main');
    // × closes the question for this call.
    await ui.call(40.5, 42, []);
    await ui.call(60, 62, ['teams']);
    ui.$('#meeting-dismiss').click();
    expect(ui.$('#meeting')).toBeNull();
    expect(ui.app.state.meeting.phase).toBe('ignored');
    ui.app.destroy();
  });

  it('quiet: a meeting task already running, paused messages, outside working hours, the "Still there?" question', async () => {
    const ui = await signedIn();
    running(ui, CALL);
    await ui.call(0, 5);
    expect(ui.$('#meeting')).toBeNull();
    expect(ui.app.state.meeting.phase).toBe('ignored');
    await ui.call(5.5, 7, []);
    ui.app.state = { ...ui.app.state, activeTimer: null, messages: pauseMessages(ui.app.state.messages, new Date(TEN + 7 * MIN)) };
    await ui.call(8, 12);
    expect(ui.$('#meeting')).toBeNull();
    // Paused for an hour from 10:07: asks once the pause is over, during the same call.
    await ui.call(67, 68);
    expect(ui.$('#meeting')).not.toBeNull();
    ui.app.dismissMeeting();
    await ui.call(68.5, 70, []);
    // 19:00 Madrid, no timer: outside the working day.
    await ui.call(9 * 60, 9 * 60 + 5);
    expect(ui.$('#meeting')).toBeNull();
    expect(ui.app.state.meeting.phase).toBe('starting');
    // With a timer it is work anyway.
    running(ui, DOCS, TEN + 8 * 60 * MIN);
    await ui.call(9 * 60 + 5.5, 9 * 60 + 6);
    expect(ui.$('#meeting')).not.toBeNull();
    ui.app.destroy();
  });

  it('turning it off forgets the call; signing out too; Settings changes the wait and the generic meeting', async () => {
    const ui = await signedIn();
    ui.app.show('settings');
    const wait = ui.$<HTMLSelectElement>('#meeting-min');
    expect([...wait.options].map((o) => o.textContent)).toEqual(['1 min', '2 min', '5 min', '10 min']);
    wait.value = '5';
    wait.dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.meetingMinMinutes).toBe(5);
    const generic = ui.$<HTMLSelectElement>('#meeting-generic');
    expect(generic.options[1]?.textContent).toBe(CALL.title);
    generic.value = CALL.id;
    generic.dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.meetingGeneric).toEqual(CALL);
    const again = ui.$<HTMLSelectElement>('#meeting-generic');
    again.value = '';
    again.dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.meetingGeneric).toBeNull();
    await ui.call(0, 0, ['teams']);
    expect(ui.$('#meeting-status').textContent).toBe('Ahora: el micrófono está en uso (Teams).');
    ui.hooks.mic({ at: TEN, inUse: true, apps: [], source: 'process' });
    expect(ui.$('#meeting-status').textContent).toBe('Ahora: el micrófono lo usa una app que no es de reuniones.');
    ui.hooks.mic({ at: TEN, inUse: false, apps: [], source: 'unavailable' });
    expect(ui.$('#meeting-status').textContent).toContain('no indica');
    ui.hooks.mic({ at: TEN, inUse: false, apps: [], source: 'process' });
    expect(ui.$('#meeting-status').textContent).toBe('Ahora: el micrófono está libre.');
    // A report that changes nothing only updates that line: what is being typed in Settings stays.
    ui.$<HTMLInputElement>('#shortcut').value = 'Ctrl+Alt+M';
    ui.hooks.mic({ at: TEN + 5_000, inUse: false, apps: [], source: 'unavailable' });
    expect(ui.$<HTMLInputElement>('#shortcut').value).toBe('Ctrl+Alt+M');
    expect(ui.$('#meeting-status').textContent).toContain('no indica');
    ui.hooks.mic('garbage');
    await ui.call(0.5, 1, ['teams']);
    expect(ui.app.state.meeting.phase).toBe('starting');
    const toggle = ui.$<HTMLInputElement>('#feature-meetingDetection');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await tick();
    expect(ui.app.state.meeting.phase).toBe('idle');
    expect(ui.hooks.wakePlan?.micEverySeconds).toBeUndefined();
    expect(ui.$('#consent-meetingDetection').textContent).toContain('retirado');
    await ui.app.setFeature('meetingDetection', true);
    await ui.call(2, 3, ['teams']);
    await ui.app.logout();
    expect(loadLocal(localStorage).meeting.phase).toBe('idle');
    ui.app.destroy();
  });
});
