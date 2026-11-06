// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MEETINGS_KEY, sha256Hex, shortKey } from '../../src/lib/meetingReminders';
import { loadLocal } from '../../src/lib/settings';
import { browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { renderPrompt } from '../../src/ui/prompt';
import { nodeFetch, startMock } from './helpers';

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
const SPRINT = { id: 'T-105', title: 'Plan sprint 42' };
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const JOIN = 'https://meet.google.com/abc-defg-hij';

function meeting(id: string, startMin: number, extra: Record<string, unknown> = {}) {
  return {
    id: `mtg_${id.padEnd(16, '0')}`,
    start: iso(TEN + startMin * MIN),
    end: iso(TEN + (startMin + 30) * MIN),
    timeZone: 'Europe/Madrid',
    allDay: false,
    date: null,
    busy: true,
    private: false,
    title: `Meeting ${id}`,
    joinUrl: JOIN,
    joinProvider: 'meet',
    organizerIsMe: false,
    attendees: [{ id: 'u1', name: 'Luis Pérez' }],
    externalCount: 0,
    taskLinks: [],
    updatedAt: iso(TEN - 60 * MIN),
    ...extra,
  };
}

const short = async (item: ReturnType<typeof meeting>) => shortKey(await sha256Hex(`${item.id}|${item.start}`));

interface Options {
  meetings?: Record<string, unknown> | null;
  native?: boolean;
  scope?: boolean;
  nativePrompt?: boolean;
  permission?: 'granted' | 'denied' | 'prompt';
  storage?: Storage;
}

async function signedIn(options: Options = {}) {
  await env.control('config', {
    workingHours: HOURS,
    meetings: options.meetings === undefined ? { status: 'connected', refreshAfterSeconds: 300, calendarsUrl: `${env.url}/account/calendars`, list: [meeting('a', 30)] } : options.meetings,
    meetingsScope: options.scope !== false,
  });
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  let now = TEN;
  const platform = browserPlatform('0.6.0', nodeFetch);
  if (options.native === true) platform.hooks.notificationPermission = 'granted';
  if (options.permission !== undefined) platform.hooks.notificationPermission = options.permission;
  if (options.nativePrompt === true) platform.hooks.nativePrompt = true;
  const app = new DesktopApp(root, platform, {
    storage: options.storage ?? localStorage,
    locale: 'en',
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 5,
    now: () => new Date(now),
    random: () => 0.5,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  await app.init();
  const done = app.connect(env.url);
  await tick();
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  app.dismissWelcome();
  // Only the reminders reach the notifications here (no coffee or cheer lines in between).
  app.setFriendly('funMessages', false);
  app.setFriendly('wellbeingReminders', false);
  return {
    app,
    root,
    platform,
    hooks: platform.hooks,
    $,
    at: async (minutes: number) => {
      now = TEN + minutes * MIN;
      await app.tick();
      await tick();
    },
    setNow: (minutes: number) => {
      now = TEN + minutes * MIN;
    },
    requests: async (path = 'me/meetings') => ((await env.control('state')) as { requests: { path: string; query: string; body: string }[] }).requests.filter((r) => r.path.endsWith(path)),
  };
}

type Ui = Awaited<ReturnType<typeof signedIn>>;

async function running(ui: Ui, task: { id: string; title: string } = DOCS) {
  await ui.app.start(task as never);
  await tick();
  expect(ui.app.state.activeTimer?.taskId).toBe(task.id);
}

describe('meeting reminders in the app', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('an older server: the sign-in works without meetings:read and Settings says why there are no reminders', async () => {
    const ui = await signedIn({ meetings: null, scope: false });
    expect(ui.app.state.session?.scopes).not.toContain('meetings:read');
    expect(ui.app.meetingSupport).toEqual({ kind: 'unsupported' });
    expect(await ui.requests()).toEqual([]);
    expect(ui.$('#meetings-today')).toBeNull();
    ui.app.show('settings');
    expect(ui.$('#meeting-reminders-unavailable').textContent).toContain('TimeTrack 1.14');
    expect(ui.$<HTMLInputElement>('#meeting-reminders-toggle').disabled).toBe(true);
    expect(ui.$('#meeting-reminders-options')).toBeNull();
    ui.app.destroy();
  });

  it('a 1.14 server with the feature off and with no calendar connected', async () => {
    const off = await signedIn({ meetings: { enabled: false } });
    expect(off.app.meetingSupport.kind).toBe('unsupported');
    off.app.destroy();
    const ui = await signedIn({ meetings: { status: 'not_connected', calendarsUrl: `${env.url}/account/calendars`, list: [] } });
    expect(ui.app.meetingRemindersOn()).toBe(false);
    expect(await ui.requests()).toEqual([]);
    ui.app.show('settings');
    expect(ui.$<HTMLInputElement>('#meeting-reminders-toggle').checked).toBe(false);
    ui.$('#meeting-reminders-connect').click();
    await tick();
    expect(ui.hooks.opened.at(-1)).toBe(`${env.url}/account/calendars`);
    // Turned on by hand: still nothing to fetch until a calendar is connected; GET me is asked again later.
    const toggle = ui.$<HTMLInputElement>('#meeting-reminders-toggle');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await tick();
    expect(ui.app.state.settings.meetingReminders).toBe(true);
    await env.control('config', { meetings: { status: 'connected', list: [meeting('a', 30)] } });
    await ui.at(31);
    expect(ui.app.meetings).toHaveLength(1);
    ui.app.destroy();
  });

  it('on by default with a calendar: fetches today and tomorrow, shows Today, the tray and the wake-up', async () => {
    const ui = await signedIn();
    const [request] = await ui.requests();
    const query = new URLSearchParams(request?.query);
    expect(query.get('from')).toBe('2026-11-05T08:50:00Z');
    expect(query.get('to')).toBe('2026-11-06T23:00:00Z');
    expect(query.get('tz')).toBe('Europe/Madrid');
    expect(ui.app.meetingRemindersOn()).toBe(true);
    const row = ui.$('#meetings-today-list li');
    expect(row.textContent).toContain('Meeting a');
    const key = await short(meeting('a', 30));
    expect(ui.hooks.trayMenu?.meetingsLabel).toBe("Today's meetings");
    expect(ui.hooks.trayMenu?.meetings?.[0]?.id).toBe(`meeting:${key}`);
    expect(ui.hooks.wakePlan?.reminderAt).toBe(TEN + 25 * MIN);
    const opened = ui.hooks.opened.length;
    ui.$(`#meeting-join-${key}`).click();
    await tick();
    expect(ui.hooks.opened.at(-1)).toBe(JOIN);
    await ui.app.trayAction(`meeting:${key}`);
    expect(ui.hooks.opened).toHaveLength(opened + 2);
    await ui.app.trayAction('meeting:0000000000000000');
    expect(ui.hooks.opened).toHaveLength(opened + 2);
    // The stored list carries what the API returned; the marks only hashes.
    expect(localStorage.getItem(MEETINGS_KEY)).toContain('Meeting a');
    ui.app.destroy();
  });

  it('reminds 5 min before with Join and Snooze, once; snooze brings it back 1 min before the start', async () => {
    const ui = await signedIn({ native: true });
    const key = await short(meeting('a', 30));
    await ui.at(24);
    expect(ui.$('#meeting-reminder')).toBeNull();
    await ui.at(25);
    const note = ui.hooks.friendly.at(-1);
    expect(note?.title).toBe('Meeting a');
    expect(note?.body).toMatch(/in 5 min · Luis$/);
    expect(note?.actions?.map((action) => action.id)).toEqual([`meeting-join:${key}`, `meeting-snooze:${key}`]);
    expect(ui.$('#meeting-reminder').getAttribute('data-kind')).toBe('reminder');
    expect(ui.$('#meeting-reminder-join')).not.toBeNull();
    const count = ui.hooks.friendly.length;
    await ui.at(26);
    expect(ui.hooks.friendly).toHaveLength(count);
    ui.hooks.notificationAction(`meeting-snooze:${key}`);
    await tick();
    expect(ui.$('#meeting-reminder')).toBeNull();
    expect(ui.hooks.wakePlan?.reminderAt).toBe(TEN + 29 * MIN);
    await ui.at(29);
    expect(ui.hooks.friendly).toHaveLength(count + 1);
    expect(ui.hooks.friendly.at(-1)?.body).toMatch(/in 1 min/);
    // No snooze left a minute before; Join from the notification opens the link and closes the toast.
    expect(ui.hooks.friendly.at(-1)?.actions?.map((action) => action.id)).toEqual([`meeting-join:${key}`]);
    ui.hooks.notificationAction(`meeting-join:${key}`);
    await tick();
    expect(ui.hooks.opened.at(-1)).toBe(JOIN);
    expect(ui.$('#meeting-reminder')).toBeNull();
    ui.app.destroy();
  });

  it('the toast: snooze choices, dismiss, a link that is not allowed, private meetings as Busy', async () => {
    const list = [meeting('a', 30), meeting('p', 40, { private: true, title: null, attendees: [], joinUrl: 'https://evil.example/j' })];
    const ui = await signedIn({ meetings: { status: 'connected', list } });
    await ui.at(20);
    expect(ui.$('#meeting-reminder')).toBeNull();
    // Without desktop notifications the toast carries everything.
    ui.app.state = { ...ui.app.state, settings: { ...ui.app.state.settings, meetingLeadMinutes: 10 } };
    await ui.at(21);
    expect([...ui.root.querySelectorAll('#meeting-reminder-actions button')].map((b) => b.textContent)).toEqual(['Join', 'Snooze', '1 min', '5 min']);
    ui.$('#meeting-reminder-snooze-5').click();
    await tick();
    expect(ui.$('#meeting-reminder')).toBeNull();
    await ui.at(26);
    expect(ui.$('#meeting-reminder-title').textContent).toBe('Meeting a');
    ui.$('#meeting-reminder-join').click();
    await tick();
    expect(ui.hooks.opened.at(-1)).toBe(JOIN);
    expect(ui.$('#meeting-reminder')).toBeNull();
    await ui.at(30);
    expect(ui.$('#meeting-reminder-title').textContent).toBe('Busy');
    // The private meeting's link is not on the allow-list: no Join, and nothing opens.
    expect(ui.$('#meeting-reminder-join')).toBeNull();
    ui.$('#meeting-reminder-snooze-default').click();
    await tick();
    await ui.at(39);
    expect(ui.$('#meeting-reminder-title').textContent).toBe('Busy');
    ui.$('#meeting-reminder-dismiss').click();
    await tick();
    expect(ui.$('#meeting-reminder')).toBeNull();
    const opened = ui.hooks.opened.length;
    await ui.app.joinMeeting({ ...ui.app.meetings[1]!, joinUrl: 'https://evil.example/j' });
    expect(ui.hooks.opened).toHaveLength(opened);
    expect(ui.$('#status').textContent).toContain('This link cannot be opened from TimeTrack.');
    ui.app.destroy();
  });

  it('start prompt while a timer runs: Keep, Pause, or Track the meeting on its linked task (origin meeting)', async () => {
    const list = [meeting('a', 30, { taskLinks: [{ taskId: SPRINT.id, key: '#105' }] }), meeting('b', 60)];
    const ui = await signedIn({ native: true, meetings: { status: 'connected', list } });
    const [a, b] = [await short(list[0]!), await short(list[1]!)];
    await running(ui);
    await ui.at(30);
    expect(ui.$('#meeting-reminder').getAttribute('data-kind')).toBe('start');
    expect(ui.hooks.friendly.at(-1)).toMatchObject({ title: 'Meeting started', body: `Meeting a has started. Keep timing "${DOCS.title}", pause, or track the meeting?` });
    expect(ui.hooks.friendly.at(-1)?.actions?.map((action) => action.id)).toEqual([`meeting-pause:${a}`, `meeting-track:${a}`]);
    ui.hooks.notificationAction(`meeting-track:${a}`);
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe(SPRINT.id);
    const switches = await ui.requests('timer/switch');
    expect(JSON.parse(switches.at(-1)?.body ?? '{}')).toMatchObject({ taskId: SPRINT.id, metadata: { origin: 'meeting' } });
    // Once per meeting.
    await ui.at(32);
    expect(ui.$('#meeting-reminder')).toBeNull();
    // Meeting b: Keep, then (a new start) Pause.
    await ui.app.start(DOCS as never);
    await ui.at(60);
    ui.$('#meeting-reminder-keep').click();
    await tick();
    expect(ui.$('#meeting-reminder')).toBeNull();
    expect(ui.app.state.activeTimer?.taskId).toBe(DOCS.id);
    await ui.app.meetingReminderAction('pause', b);
    expect(ui.app.state.activeTimer).toBeNull();
    // Another start prompt, answered "Pause" in the window.
    await env.control('config', { meetings: { status: 'connected', list: [...list, meeting('c', 90)] } });
    await ui.app.refresh();
    await ui.app.start(DOCS as never);
    await ui.at(90);
    ui.$('#meeting-reminder-pause').click();
    await tick(80);
    expect(ui.app.state.activeTimer).toBeNull();
    // GET me says the feature went off: the list goes.
    await env.control('config', { meetings: null });
    await ui.app.refresh();
    expect(ui.app.meetings).toEqual([]);
    expect(ui.app.meetingSupport.kind).toBe('unsupported');
    ui.app.destroy();
  });

  it('Track the meeting without a linked task: the window asks which task', async () => {
    const ui = await signedIn();
    await running(ui);
    await ui.at(30);
    ui.$('#meeting-reminder-track').click();
    await tick();
    const search = ui.$<HTMLInputElement>('#meeting-reminder-search');
    search.value = 'sprint';
    search.dispatchEvent(new Event('input'));
    await tick();
    ui.$(`#meeting-reminder-task-${SPRINT.id}`).click();
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe(SPRINT.id);
    expect(ui.$('#meeting-reminder')).toBeNull();
    ui.app.destroy();
  });

  it('automatic pause (opt-in) with Undo; the start prompt can be turned off', async () => {
    const ui = await signedIn({ native: true, meetings: { status: 'connected', list: [meeting('a', 30), meeting('b', 60)] } });
    ui.app.setReminderSetting({ meetingAutoPause: true });
    await running(ui);
    await ui.at(30);
    expect(ui.app.state.activeTimer).toBeNull();
    const a = await short(meeting('a', 30));
    expect(ui.hooks.friendly.at(-1)).toMatchObject({ title: 'Timer paused', actions: [{ id: `meeting-undo:${a}`, label: 'Undo' }] });
    ui.$('#meeting-reminder-undo').click();
    await tick(80);
    expect(ui.app.state.activeTimer?.taskId).toBe(DOCS.id);
    // Undo again does nothing.
    await ui.app.meetingReminderAction('undo', a);
    ui.app.setReminderSetting({ meetingAutoPause: false, meetingAskOnStart: false });
    await ui.at(60);
    expect(ui.$('#meeting-reminder')).toBeNull();
    expect(ui.app.state.activeTimer?.taskId).toBe(DOCS.id);
    ui.app.destroy();
  });

  it('outside working hours and on days off only when switched on; more than three at once are grouped', async () => {
    const evening = [meeting('e', 9 * 60 + 30)];
    const ui = await signedIn({ native: true, meetings: { status: 'connected', list: [...evening, ...['w', 'x', 'y', 'z'].map((id) => meeting(id, 120))] } });
    await ui.at(115);
    expect(ui.hooks.friendly.at(-1)).toMatchObject({ title: '4 meetings at 11:00 AM', actions: [] });
    expect(ui.$('#meeting-reminder').getAttribute('data-kind')).toBe('group');
    await ui.at(9 * 60 + 25);
    expect(ui.hooks.friendly.at(-1)?.title).toBe('4 meetings at 11:00 AM');
    ui.app.setReminderSetting({ meetingOutsideHours: true });
    await ui.at(9 * 60 + 26);
    expect(ui.hooks.friendly.at(-1)?.title).toBe('Meeting e');
    ui.app.destroy();
  });

  it('404 clears the list, 403 asks for the permission again, 429 waits for Retry-After, 401 signs out', async () => {
    const ui = await signedIn();
    expect(ui.app.meetings).toHaveLength(1);
    await env.control('config', { failNext: { status: 429, error: 'rate_limited', retryAfter: 600 } });
    await ui.at(6);
    expect(ui.app.meetingPoll.notBefore).toBe(TEN + 16 * MIN);
    expect(ui.app.meetings).toHaveLength(1);
    const before = (await ui.requests()).length;
    await ui.at(12);
    expect(await ui.requests()).toHaveLength(before);
    await env.control('config', { failNext: { status: 404, error: 'not_found' } });
    await ui.at(16);
    expect(ui.app.meetings).toEqual([]);
    expect(ui.$('#meetings-today')).toBeNull();
    expect(JSON.parse(localStorage.getItem(MEETINGS_KEY) ?? '{}').cache).toBeNull();
    ui.app.show('settings');
    expect(ui.$('#meeting-reminders-unavailable').textContent).toBe('Your Beacon turned meeting reminders off.');
    // GET me still says on: the stop is lifted at the next refresh.
    await ui.app.refresh();
    expect(ui.app.meetingPoll.stopped).toBeNull();
    await env.control('config', { failNext: { status: 403, error: 'insufficient_scope' } });
    await ui.at(30);
    expect(ui.app.meetingPoll.stopped).toBe('scope');
    ui.app.show('settings');
    expect(ui.$('#meeting-reminders-consent')).not.toBeNull();
    ui.app.show('main');
    expect(ui.$('#meeting-consent-card')).not.toBeNull();
    ui.$('#meeting-consent-later').click();
    await tick();
    expect(ui.$('#meeting-consent-card')).toBeNull();
    await ui.app.refresh();
    await env.control('config', { failNext: { status: 401, error: 'invalid_token' } });
    await ui.at(60);
    expect(ui.app.view).toBe('login');
    expect(JSON.parse(localStorage.getItem(MEETINGS_KEY) ?? '{}').cache).toBeNull();
    ui.app.destroy();
  });

  it('re-consent: a sign-in without meetings:read gets one card, and the device flow adds the scope', async () => {
    const ui = await signedIn({ scope: false });
    expect(ui.app.meetingSupport.kind).toBe('consent');
    expect(ui.$('#meeting-consent-card')).not.toBeNull();
    await env.control('config', { meetingsScope: true });
    // A failure keeps the session (and the main window).
    await env.control('config', { failNext: { status: 500, error: 'server_error' } });
    ui.$('#meeting-consent-allow').click();
    await tick(80);
    expect(ui.app.view).toBe('main');
    expect(ui.app.state.session).not.toBeNull();
    // Cancel: back to the main window, still signed in.
    ui.app.show('settings');
    ui.$('#meeting-reminders-consent').click();
    await tick();
    expect(ui.app.view).toBe('device');
    ui.app.cancelDevice();
    await tick();
    expect(ui.app.view).toBe('main');
    expect(ui.app.state.session).not.toBeNull();
    ui.app.dismissError();
    ui.app.show('settings');
    ui.$('#meeting-reminders-consent').click();
    await tick();
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
    await tick(300);
    expect(ui.app.view).toBe('main');
    expect(ui.app.welcome).toBe(false);
    expect(ui.app.meetingSupport.kind).toBe('on');
    expect(ui.app.meetings).toHaveLength(1);
    expect(ui.$('#meeting-consent-card')).toBeNull();
    ui.app.destroy();
  });

  it('needs_reconnect: one banner with Reconnect; the list is kept', async () => {
    const ui = await signedIn({ meetings: { status: 'needs_reconnect', calendarsUrl: `${env.url}/account/calendars`, list: [meeting('a', 30)] } });
    expect(ui.app.meetings).toHaveLength(1);
    ui.$('#meeting-reconnect-open').click();
    await tick();
    expect(ui.hooks.opened.at(-1)).toBe(`${env.url}/account/calendars`);
    ui.$('#meeting-reconnect-dismiss').click();
    await tick();
    expect(ui.$('#meeting-reconnect')).toBeNull();
    ui.app.show('settings');
    expect(ui.$('#meeting-reminders-reconnect-block')).not.toBeNull();
    ui.app.destroy();
  });

  it('Settings: lead presets, custom 1–120, the switches, and off wipes the list', async () => {
    const ui = await signedIn({ permission: 'prompt' });
    ui.app.show('settings');
    const select = ui.$<HTMLSelectElement>('#meeting-lead');
    expect(select.value).toBe('5');
    expect([...select.options].map((option) => option.textContent)).toEqual(['Not before the meeting', '1 min before', '2 min before', '5 min before', '10 min before', '15 min before', '30 min before', 'Custom…']);
    select.value = '15';
    select.dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.meetingLeadMinutes).toBe(15);
    ui.$<HTMLSelectElement>('#meeting-lead').value = 'custom';
    ui.$<HTMLSelectElement>('#meeting-lead').dispatchEvent(new Event('change'));
    const custom = ui.$<HTMLInputElement>('#meeting-lead-custom');
    // Starts from the current lead time.
    expect(custom.value).toBe('15');
    custom.value = '121';
    custom.dispatchEvent(new Event('change'));
    expect(ui.$('#meeting-lead-error').textContent).toBe('Enter a whole number of minutes from 1 to 120.');
    expect(ui.app.state.settings.meetingLeadMinutes).toBe(15);
    ui.$<HTMLInputElement>('#meeting-lead-custom').value = '';
    ui.$<HTMLInputElement>('#meeting-lead-custom').dispatchEvent(new Event('change'));
    expect(ui.$('#meeting-lead-error')).not.toBeNull();
    ui.$<HTMLInputElement>('#meeting-lead-custom').value = '45';
    ui.$<HTMLInputElement>('#meeting-lead-custom').dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.meetingLeadMinutes).toBe(45);
    expect(ui.$('#meeting-lead-error')).toBeNull();
    expect(ui.$<HTMLInputElement>('#meeting-lead-custom').value).toBe('45');
    for (const [id, name] of [['meeting-outside-hours', 'meetingOutsideHours'], ['meeting-days-off', 'meetingDaysOff'], ['meeting-auto-pause', 'meetingAutoPause']] as const) {
      const box = ui.$<HTMLInputElement>(`#${id}`);
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      expect(ui.app.state.settings[name]).toBe(true);
    }
    const ask = ui.$<HTMLInputElement>('#meeting-ask-start');
    ask.checked = false;
    ask.dispatchEvent(new Event('change'));
    expect(loadLocal(localStorage).settings).toMatchObject({ meetingAskOnStart: false, meetingLeadMinutes: 45, meetingAutoPause: true });
    const toggle = ui.$<HTMLInputElement>('#meeting-reminders-toggle');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await tick();
    expect(ui.app.meetings).toEqual([]);
    expect(ui.$('#meeting-reminders-options')).toBeNull();
    expect(JSON.parse(localStorage.getItem(MEETINGS_KEY) ?? '{}').cache).toBeNull();
    // On again: macOS-style permission question now (never at first launch), and a fetch.
    const again = ui.$<HTMLInputElement>('#meeting-reminders-toggle');
    again.checked = true;
    again.dispatchEvent(new Event('change'));
    await tick(80);
    expect(ui.hooks.notificationPermission).toBe('granted');
    expect(ui.app.state.settings.nativeStatus).toBe('granted');
    // Fetched again once the 60-second rule allows it.
    expect(ui.app.meetings).toHaveLength(0);
    await ui.at(1.5);
    expect(ui.app.meetings).toHaveLength(1);
    ui.$<HTMLSelectElement>('#meeting-lead').value = '0';
    ui.$<HTMLSelectElement>('#meeting-lead').dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.meetingLeadMinutes).toBe(0);
    ui.app.destroy();
  });

  it('without desktop notifications the reminder also opens the prompt window; its answers act', async () => {
    const ui = await signedIn({ nativePrompt: true, permission: 'denied' });
    ui.app.state = { ...ui.app.state, settings: { ...ui.app.state.settings, nativeStatus: 'denied' } };
    ui.app.show('settings');
    expect(ui.$('#meeting-reminders-notifications-off')).not.toBeNull();
    ui.app.show('main');
    const key = await short(meeting('a', 30));
    await ui.at(25);
    expect(ui.hooks.prompt?.id).toBe('meeting-prompt');
    const buttons = ui.hooks.prompt?.blocks.flatMap((block) => (block.kind === 'choices' ? block.items : [])) ?? [];
    expect(buttons.map((item) => (item.kind === 'button' ? `${item.action}:${item.meeting}` : ''))).toEqual([`meeting-join:${key}`, `meeting-snooze:${key}`, `meeting-snooze-1:${key}`, `meeting-dismiss:${key}`]);
    // The prompt window's page sends the meeting's short key with the answer.
    const answers: unknown[] = [];
    const rendered = renderPrompt(ui.hooks.prompt!, { onAnswer: (answer) => answers.push(answer) });
    (rendered.element.querySelector('#meeting-prompt-join') as HTMLButtonElement).click();
    expect(answers).toEqual([{ action: 'meeting-join', meeting: key }]);
    rendered.dispose();
    ui.hooks.answerPrompt({ action: 'meeting-snooze-1', meeting: key });
    await tick();
    expect(ui.hooks.prompt).toBeNull();
    await ui.at(26);
    expect(ui.hooks.prompt?.id).toBe('meeting-prompt');
    ui.hooks.answerPrompt({ action: 'meeting-dismiss' });
    await tick();
    expect(ui.hooks.prompt).toBeNull();
    await running(ui);
    await ui.at(30);
    expect(ui.hooks.prompt?.title).toBe('Meeting started');
    ui.hooks.answerPrompt({ action: 'meeting-keep', meeting: key });
    await tick();
    expect(ui.hooks.prompt).toBeNull();
    ui.app.destroy();
  });

  it('microphone detection stays quiet around a reminded meeting (one prompt, Q-O20)', async () => {
    const ui = await signedIn({ native: true });
    await ui.app.setFeature('meetingDetection', true);
    await ui.at(25);
    for (let at = 30 * MIN; at <= 34 * MIN; at += 20_000) {
      ui.setNow(at / MIN);
      ui.hooks.mic({ at: TEN + at, inUse: true, apps: ['teams'], source: 'process' });
    }
    await tick();
    expect(ui.app.state.meeting.phase).toBe('ignored');
    expect(ui.$('#meeting')).toBeNull();
    ui.app.destroy();
  });

  it('offline: reminders fire from the cached list, marked as maybe outdated; sign-out wipes it', async () => {
    const first = await signedIn({ native: true });
    first.app.destroy();
    // A new start with the server unreachable, 70 minutes later.
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    let now = TEN + 70 * MIN;
    const platform = browserPlatform('0.6.0', (async () => {
      throw new TypeError('offline');
    }) as typeof fetch);
    platform.hooks.notificationPermission = 'granted';
    await platform.secretSet('stored');
    const app = new DesktopApp(root, platform, { storage: localStorage, locale: 'en', now: () => new Date(now), random: () => 0.5 });
    await env.control('config', { meetings: { status: 'connected', list: [meeting('a', 30), meeting('l', 100)] } });
    const cache = JSON.parse(localStorage.getItem(MEETINGS_KEY) ?? '{}');
    cache.cache.meetings.push({ ...cache.cache.meetings[0], id: 'mtg_l000000000000000', start: TEN + 100 * MIN, end: TEN + 130 * MIN, title: 'Later', key: await sha256Hex(`mtg_l000000000000000|${iso(TEN + 100 * MIN)}`) });
    localStorage.setItem(MEETINGS_KEY, JSON.stringify(cache));
    await app.init();
    expect(app.offline).toBe(true);
    now = TEN + 95 * MIN;
    await app.tick();
    await tick();
    expect(platform.hooks.friendly.at(-1)?.title).toBe('Later');
    expect(platform.hooks.friendly.at(-1)?.body).toContain('(may be outdated)');
    expect(root.querySelector('#meetings-today-outdated')?.textContent).toMatch(/^Last updated at .+: this list may be outdated\.$/);
    await app.logout();
    expect(JSON.parse(localStorage.getItem(MEETINGS_KEY) ?? '{}').cache).toBeNull();
    expect(app.meetings).toEqual([]);
    app.destroy();
  });

  it('wakes from sleep and the network coming back fetch again; the list expires after tomorrow', async () => {
    const ui = await signedIn();
    const count = (await ui.requests()).length;
    await ui.at(2);
    expect(await ui.requests()).toHaveLength(count);
    ui.hooks.wake('resumed');
    ui.setNow(3);
    await tick(80);
    expect(await ui.requests()).toHaveLength(count + 1);
    await ui.app.sessionEvent('resume');
    await ui.at(5);
    expect(await ui.requests()).toHaveLength(count + 2);
    ui.app.offline = true;
    await ui.at(5.5);
    ui.app.offline = false;
    await ui.at(7);
    expect(await ui.requests()).toHaveLength(count + 3);
    // Saturday: past the end of tomorrow, the list is gone (and the server is not asked on a weekend).
    await env.control('config', { meetings: { status: 'connected', list: [] } });
    await ui.at(2 * 24 * 60 + 60);
    expect(ui.app.meetings).toEqual([]);
    expect(ui.$('#meetings-today')).toBeNull();
    ui.app.destroy();
  });

  it('without a schedule from Beacon every day counts as working time', async () => {
    await env.control('config', { workingHours: null });
    const ui = await signedIn({ native: true });
    await env.control('config', { workingHours: null });
    await ui.app.refresh();
    await ui.at(25);
    expect(ui.hooks.friendly.at(-1)?.title).toBe('Meeting a');
    ui.app.destroy();
  });

  it('clearing local data wipes the meetings store', async () => {
    const ui = await signedIn();
    await ui.app.clearLocalData();
    expect(localStorage.getItem(MEETINGS_KEY)).toBeNull();
    expect(ui.app.meetings).toEqual([]);
    ui.app.destroy();
  });

  it('privacy page lists the meetings kept on this computer', async () => {
    const ui = await signedIn();
    ui.app.show('privacy');
    expect(ui.$('#privacy-local').textContent).toContain('Meeting reminders: today');
    ui.app.destroy();
  });
});
