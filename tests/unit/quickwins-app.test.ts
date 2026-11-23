// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Timer } from '../../src/api/types';
import { browserPlatform } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { PromptMount, renderPrompt, type PromptAnswer, type PromptView } from '../../src/ui/prompt';
import { nodeFetch, startMock, until as untilReady } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());
beforeEach(async () => {
  localStorage.clear();
  await env.control('reset', {});
  await env.control('config', { deviceInterval: 1 });
});

/** Tuesday 2026-11-03, 14:45 in Madrid (inside 09:00–18:00). */
const NOW = Date.parse('2026-11-03T13:45:00Z');
const HOURS = { timezone: 'Europe/Madrid', slots: [2].map((day) => ({ day, from: '09:00', to: '18:00' })) };

type Hooks = ReturnType<typeof browserPlatform>['hooks'];
type Internals = { setIdleCheck(state: unknown): void };

/** `start`: the app's clock (the idle tests use the real one, like the mock server's entries). */
async function signedIn(setup: (hooks: Hooks) => void = () => undefined, locale: 'en' | 'es' = 'en', start = NOW) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  let now = start;
  const platform = browserPlatform('0.5.0', nodeFetch);
  setup(platform.hooks);
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
    searchDelayMs: 5,
    now: () => new Date(now),
    random: () => 0,
  });
  const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector(selector) as T;
  await app.init();
  const done = app.connect(env.url);
  await untilReady(() => $('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  expect(app.view).toBe('main');
  return {
    app,
    hooks: platform.hooks,
    $,
    root,
    advance: (minutes: number) => void (now += minutes * 60_000),
    now: () => now,
    click: (selector: string) => $<HTMLElement>(selector).click(),
  };
}
type Ui = Awaited<ReturnType<typeof signedIn>>;

const entries = async () =>
  Object.values(((await env.control('state')) as { entries: Record<string, { taskId: string; startedAt: string; endedAt: string }[]> }).entries)
    .flat()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

/** A timer on T-101 that started an hour ago (on the server too), and the "Still there?" question about the last 11 min. */
async function askingAboutIdle(ui: Ui) {
  await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
  await env.control('timer/backdate', { seconds: 3600 });
  await ui.app.refresh();
  (ui.app as unknown as Internals).setIdleCheck({
    phase: 'asking',
    taskId: 'T-101',
    taskTitle: 'Write onboarding guide',
    from: new Date(Date.now() - 11 * 60_000).toISOString(),
    askedAt: new Date(Date.now() - 60_000).toISOString(),
    returnedAt: new Date(Date.now() - 5_000).toISOString(),
    timerStartedAt: ui.app.state.activeTimer?.startedAt,
  });
}

async function until(check: () => boolean) {
  for (let i = 0; i < 40 && !check(); i++) await tick(20);
}

describe('three choices on return from idle', () => {
  it('Keep · Discard · Reassign first, then the finer options; Reassign splits the idle span to a found task', async () => {
    const ui = await signedIn(undefined, 'es', Date.now());
    await askingAboutIdle(ui);
    const labels = [...ui.root.querySelectorAll('#idle .choice-list > button')].map((button) => button.id);
    expect(labels).toEqual(['idle-here', 'idle-pause', 'idle-reassign', 'idle-meeting', 'idle-discard']);
    expect(ui.$('#idle-here').textContent).toBe('Mantener: sí, era trabajo');
    expect(ui.$('#idle-pause').textContent).toMatch(/^Descartar: parar el temporizador a las /);
    expect(ui.$('#idle-reassign').getAttribute('aria-expanded')).toBe('false');
    ui.click('#idle-reassign');
    expect(ui.$('#reassign-heading').textContent).toBe('¿A qué tarea va este tiempo?');
    expect(document.activeElement?.id).toBe('reassign-search');
    // Search (run by the main window): results first.
    ui.$<HTMLInputElement>('#reassign-search').value = 'invoice';
    ui.$<HTMLFormElement>('#reassign-search-form').requestSubmit();
    await until(() => ui.app.reassignResults !== null);
    await tick();
    expect(ui.$('#reassign-status').textContent).toBe('1 tareas encontradas.');
    expect(ui.$<HTMLInputElement>('input[name="reassign-task"]:checked').value).toBe('T-104');
    ui.click('#reassign-save');
    await until(() => ui.app.state.idleCheck.phase === 'watching' && !ui.app.busy);
    await tick();
    const list = await entries();
    expect(list.map((entry) => entry.taskId)).toEqual(['T-101', 'T-104']);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    expect(ui.$('#notice').textContent).toMatch(/^Hecho: \d+ min van a Fix invoice rounding bug\.$/);
    ui.app.destroy();
  });

  it('without the server reassign: four backdated starts and stops, same result', async () => {
    await env.control('config', { allowReassign: false });
    const ui = await signedIn(undefined, 'en', Date.now());
    await askingAboutIdle(ui);
    expect(ui.app.features().idleReassign).toBe(false);
    ui.click('#idle-reassign');
    ui.root.querySelector<HTMLInputElement>('input[name="reassign-task"][value="T-102"]')!.checked = true;
    ui.click('#reassign-save');
    await until(() => ui.app.state.idleCheck.phase === 'watching' && !ui.app.busy);
    await tick(80);
    const list = await entries();
    expect(list.map((entry) => entry.taskId)).toEqual(['T-101', 'T-102']);
    expect(list[1]!.startedAt).toBe(list[0]!.endedAt);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    expect(Date.parse(ui.app.state.activeTimer!.startedAt)).toBe(Date.parse(list[1]!.endedAt));
    ui.app.destroy();
  });

  it('the quick "Meeting" choice, cancel, an empty search and failed or empty searches', async () => {
    const ui = await signedIn(undefined, 'en', Date.now());
    await askingAboutIdle(ui);
    ui.click('#idle-reassign');
    expect(ui.$('#reassign-meeting').textContent).toBe('Meeting: Customer call: Acme quarterly review');
    ui.click('#reassign-cancel');
    expect(ui.$('#reassign-picker')).toBeNull();
    expect(ui.app.reassignOpen).toBe(false);
    ui.click('#idle-reassign');
    await ui.app.searchReassign('zzz');
    expect(ui.$('#reassign-status').textContent).toBe('No task matches “zzz”.');
    // No match: the pinned, recent and listed tasks stay to choose from.
    expect(ui.$('#reassign-save')).not.toBeNull();
    await env.control('config', { failNext: { status: 500 } });
    await ui.app.searchReassign('acme');
    expect(ui.$('#reassign-status').textContent).toBe('The search did not work. Try again.');
    await ui.app.searchReassign('  ');
    expect(ui.app.reassignResults).toBeNull();
    expect(ui.$('#reassign-meeting')).not.toBeNull();
    ui.click('#reassign-meeting');
    await until(() => ui.app.state.idleCheck.phase === 'watching' && !ui.app.busy);
    await tick();
    expect((await entries()).map((entry) => entry.taskId)).toEqual(['T-101', 'T-103']);
    ui.app.destroy();
  });

  it('a 1.9 server cannot reassign: no button; unknown tasks are ignored', async () => {
    await env.control('config', { apiVersion: '1.9' });
    const ui = await signedIn(undefined, 'en', Date.now());
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    (ui.app as unknown as Internals).setIdleCheck({ phase: 'asking', taskId: 'T-101', taskTitle: 'Write onboarding guide', from: new Date(Date.now() - 11 * 60_000).toISOString(), askedAt: new Date().toISOString(), returnedAt: null, timerStartedAt: ui.app.state.activeTimer?.startedAt });
    expect(ui.$('#idle-reassign')).toBeNull();
    await ui.app.answerPrompt({ action: 'reassign-save', taskId: 'T-102' });
    expect(ui.app.state.idleCheck.phase).toBe('asking');
    await ui.app.answerPrompt({ action: 'reassign-save', taskId: 'nope' });
    await ui.app.reassignIdle({ id: 'T-102', title: 'x' });
    expect(ui.app.state.idleCheck.phase).toBe('asking');
    ui.app.destroy();
  });

  it('Discard stops the timer at the idle start and offers to resume', async () => {
    const ui = await signedIn(undefined, 'en', Date.now());
    await askingAboutIdle(ui);
    const from = (ui.app.state.idleCheck as { from: string }).from;
    ui.click('#idle-pause');
    await until(() => ui.app.state.idleCheck.phase === 'resume' && !ui.app.busy);
    await tick();
    expect(ui.app.state.activeTimer).toBeNull();
    const list = await entries();
    expect(Math.abs(Date.parse(list[0]!.endedAt) - Date.parse(from))).toBeLessThan(2000);
    expect(ui.$('#gap-resume')).not.toBeNull();
    ui.app.destroy();
  });
});

describe('picker rendering', () => {
  const view = (blocks: PromptView['blocks']): PromptView => ({ id: 'idle', moment: 'stillThere', pose: null, title: 'Still there?', blocks, windowTitle: 'w', lang: 'en', theme: null, escapeHint: 'e', openApp: null, focus: null, focusSeq: 0 });
  const picker = {
    kind: 'picker' as const,
    heading: 'Which task?',
    meeting: { kind: 'button' as const, id: 'reassign-meeting', label: 'Meeting: Sync', style: 'secondary' as const, action: 'reassign-save' as const, taskId: 'M-1' },
    searchLabel: 'Search tasks',
    searchButton: 'Search',
    query: 'sy',
    status: null,
    options: [
      { id: 'A', title: 'Alpha' },
      { id: 'B', title: 'Beta' },
    ],
    selected: 'B',
    emptyText: 'none',
    saveLabel: 'Save',
    cancelLabel: 'Cancel',
  };

  it('sends the chosen task, the meeting task, the query and cancel', () => {
    const answers: PromptAnswer[] = [];
    const rendered = renderPrompt(view([picker]), { onAnswer: (answer) => answers.push(answer) });
    document.body.replaceChildren(rendered.element);
    const $ = (selector: string) => rendered.element.querySelector<HTMLElement>(selector)!;
    expect(($('#reassign-search') as HTMLInputElement).value).toBe('sy');
    expect(($('input[value="B"]') as HTMLInputElement).checked).toBe(true);
    expect($('label[for="reassign-option-0"]').textContent).toBe('Alpha');
    $('#reassign-save').click();
    ($('input[value="A"]') as HTMLInputElement).checked = true;
    $('#reassign-save').click();
    $('#reassign-meeting').click();
    ($('#reassign-search') as HTMLInputElement).value = ' sync ';
    ($('#reassign-search-form') as HTMLFormElement).requestSubmit();
    $('#reassign-cancel').click();
    expect(answers).toEqual([
      { action: 'reassign-save', taskId: 'B' },
      { action: 'reassign-save', taskId: 'A' },
      { action: 'reassign-save', taskId: 'M-1' },
      { action: 'reassign-search', query: 'sync' },
      { action: 'reassign-cancel' },
    ]);
    rendered.dispose();
  });

  it('the same view is not redrawn (a typed search or a chosen task stays); a new one is', () => {
    const region = document.createElement('div');
    document.body.replaceChildren(region);
    const mount = new PromptMount(region, { onAnswer: () => undefined });
    const first = mount.show(view([{ ...picker, meeting: null, selected: null }]))!;
    (region.querySelector('input[value="B"]') as HTMLInputElement).checked = true;
    expect(mount.show(view([{ ...picker, meeting: null, selected: null }]))).toBe(first);
    expect((region.querySelector('input[value="B"]') as HTMLInputElement).checked).toBe(true);
    expect(region.querySelector('#reassign-meeting')).toBeNull();
    const second = mount.show(view([{ ...picker, options: [], status: '0 found' }]))!;
    expect(second).not.toBe(first);
    expect(region.querySelector('#reassign-empty')?.textContent).toBe('none');
    expect(region.querySelector('#reassign-status')?.textContent).toBe('0 found');
    mount.dispose();
  });
});

describe('"Continue last" and its global shortcut', () => {
  it('the timer card button and the shortcut start the last task again as a new entry, window hidden or not', async () => {
    const ui = await signedIn();
    expect(ui.hooks.resumeShortcut).toBe('CommandOrControl+Alt+Shift+R');
    await ui.app.start({ id: 'T-102', title: 'Review pull request queue' });
    await ui.app.stop();
    expect(ui.$('#resume').textContent).toBe('Continue last');
    ui.click('#resume');
    await until(() => ui.app.state.activeTimer !== null);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    // While a timer runs the shortcut does nothing.
    ui.hooks.resumeShortcutPressed();
    await tick();
    expect((await entries()).length).toBe(1);
    await ui.app.stop();
    ui.hooks.resumeShortcutPressed();
    await until(() => ui.app.state.activeTimer !== null);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    expect((await entries()).length).toBe(2);
    ui.app.destroy();
  });

  it('after an automatic stop it is the Resume of that question', async () => {
    const ui = await signedIn();
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await ui.app.stop();
    (ui.app as unknown as Internals).setIdleCheck({ phase: 'resume', taskId: 'T-101', taskTitle: 'Write onboarding guide' });
    ui.hooks.resumeShortcutPressed();
    await until(() => ui.app.state.activeTimer !== null);
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    await ui.app.stop();
    (ui.app as unknown as Internals).setIdleCheck({ phase: 'away', taskId: 'T-101', taskTitle: 'Write onboarding guide', from: new Date().toISOString() });
    await ui.app.continueLast();
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    // Asking: never from a shortcut.
    (ui.app as unknown as Internals).setIdleCheck({ phase: 'asking', taskId: 'T-101', taskTitle: 'x', from: new Date().toISOString(), askedAt: new Date().toISOString(), returnedAt: null, timerStartedAt: ui.app.state.activeTimer?.startedAt });
    await ui.app.stop();
    await ui.app.continueLast();
    expect(ui.app.state.activeTimer).toBeNull();
    ui.app.destroy();
  });

  it('Settings: change it, refuse the other shortcut or one the OS refuses, back to the default', async () => {
    const ui = await signedIn((hooks) => (hooks.refusedShortcuts = ['Alt+F1']));
    ui.app.show('settings');
    expect(ui.$('#helpers-title').textContent).toBe('Continue, reminders and lock');
    const input = ui.$<HTMLInputElement>('#resume-shortcut');
    expect(input.value).toBe('CommandOrControl+Alt+Shift+R');
    input.value = 'CommandOrControl+Alt+Shift+T';
    ui.$<HTMLFormElement>('#resume-shortcut-form').requestSubmit();
    await tick();
    expect(ui.$('#resume-shortcut-message').textContent).toBe('“CommandOrControl+Alt+Shift+T” is already the other shortcut: choose a different one.');
    ui.$<HTMLInputElement>('#resume-shortcut').value = 'Alt+F1';
    ui.$<HTMLFormElement>('#resume-shortcut-form').requestSubmit();
    await tick();
    expect(ui.$('#resume-shortcut-message').className).toBe('field-error');
    ui.$<HTMLInputElement>('#resume-shortcut').value = 'Alt+F9';
    ui.$<HTMLFormElement>('#resume-shortcut-form').requestSubmit();
    await tick();
    expect(ui.hooks.resumeShortcut).toBe('Alt+F9');
    expect(ui.app.state.settings.resumeShortcut).toBe('Alt+F9');
    expect(ui.$('#resume-shortcut-message').textContent).toBe('Shortcut set: Alt+F9');
    // The other one cannot take it either.
    expect(await ui.app.applyShortcut('alt+f9')).toBe(false);
    ui.click('#resume-shortcut-default');
    await tick();
    expect(ui.app.state.settings.resumeShortcut).toBe('CommandOrControl+Alt+Shift+R');
    ui.app.destroy();
  });
});

describe('"Working without a timer?"', () => {
  beforeEach(async () => {
    await env.control('config', { workingHours: HOURS });
  });

  it('after 10 min of input in working hours: a notification with Start last / Choose task, then not for 45 min', async () => {
    const ui = await signedIn((hooks) => {
      hooks.notificationPermission = 'granted';
      hooks.idleSeconds = 4;
    });
    await ui.app.start({ id: 'T-102', title: 'Review pull request queue' });
    await ui.app.stop();
    await ui.app.tick();
    ui.advance(5);
    await ui.app.tick();
    expect(ui.hooks.friendly).toHaveLength(0);
    ui.advance(5);
    await ui.app.tick();
    await tick();
    expect(ui.hooks.friendly).toEqual([
      {
        title: 'Working without a timer?',
        body: "You've been busy for a while and no timer is running. Shall we track it? Last task: Review pull request queue.",
        pose: 'think',
        actions: [
          { id: 'nudge-resume', label: 'Start Review pull request queue' },
          { id: 'nudge-choose', label: 'Choose task' },
        ],
      },
    ]);
    for (let minute = 0; minute < 40; minute += 5) {
      ui.advance(5);
      await ui.app.tick();
    }
    expect(ui.hooks.friendly).toHaveLength(1);
    ui.advance(10);
    await ui.app.tick();
    await tick();
    expect(ui.hooks.friendly).toHaveLength(2);
    // "Start" from the notification.
    ui.hooks.notificationAction('nudge-resume');
    await until(() => ui.app.state.activeTimer !== null);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-102');
    ui.app.destroy();
  });

  it('as a toast without desktop notifications; "Choose task" goes to the search', async () => {
    const ui = await signedIn((hooks) => (hooks.idleSeconds = 4), 'es');
    await ui.app.tick();
    ui.advance(10);
    await ui.app.tick();
    expect(ui.$('#nudge-text').textContent).toBe('Llevas un rato a tope y no hay temporizador en marcha. ¿Lo registramos?');
    expect(ui.$('#nudge-resume')).toBeNull();
    expect(ui.$('#nudge img').getAttribute('data-pose')).toBe('think');
    ui.click('#nudge-choose');
    await tick();
    expect(ui.$('#nudge')).toBeNull();
    expect(document.activeElement?.id).toBe('search');
    ui.hooks.notificationAction('nudge-choose');
    await tick();
    ui.hooks.notificationAction('schedule-stop');
    await tick();
    ui.app.destroy();
  });

  it('a toast goes away when a timer starts, on dismiss, or after a while', async () => {
    const ui = await signedIn((hooks) => (hooks.idleSeconds = 4));
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    await ui.app.stop();
    await ui.app.tick();
    ui.advance(10);
    await ui.app.tick();
    expect(ui.$('#nudge-resume').textContent).toBe('Start Write onboarding guide');
    ui.click('#nudge-dismiss');
    expect(ui.$('#nudge')).toBeNull();
    ui.advance(50);
    await ui.app.tick();
    ui.advance(10);
    await ui.app.tick();
    expect(ui.$('#nudge')).not.toBeNull();
    ui.advance(31);
    ui.app.render();
    expect(ui.$('#nudge')).toBeNull();
    ui.advance(30);
    await ui.app.tick();
    ui.advance(10);
    await ui.app.tick();
    ui.click('#nudge-resume');
    await until(() => ui.app.state.activeTimer !== null);
    expect(ui.$('#nudge')).toBeNull();
    ui.app.destroy();
  });

  it('never outside working hours, with a timer, when turned off, paused or after a meeting; the counter is not read then', async () => {
    const ui = await signedIn((hooks) => (hooks.idleSeconds = 4));
    let reads = 0;
    const platform = (ui.app as unknown as { platform: { idleSeconds(): Promise<number> } }).platform;
    const read = platform.idleSeconds.bind(platform);
    platform.idleSeconds = () => {
      reads += 1;
      return read();
    };
    ui.app.setHelper({ nudgeWithoutTimer: false });
    for (let i = 0; i < 4; i++) {
      ui.advance(5);
      await ui.app.tick();
    }
    expect(reads).toBe(0);
    expect(ui.$('#nudge')).toBeNull();
    ui.app.setHelper({ nudgeWithoutTimer: true, nudgeMinutes: 5 });
    await ui.app.pauseFriendly(true);
    ui.advance(10);
    await ui.app.tick();
    expect(reads).toBe(0);
    await ui.app.pauseFriendly(false);
    // 19:00 in Madrid: outside the hours.
    ui.advance(4 * 60);
    await ui.app.tick();
    ui.advance(10);
    await ui.app.tick();
    expect(reads).toBe(0);
    expect(ui.$('#nudge')).toBeNull();
    ui.app.destroy();
  });

  it('after a meeting-type task: only "Choose task"', async () => {
    const ui = await signedIn((hooks) => (hooks.idleSeconds = 4));
    await ui.app.start({ id: 'T-103', title: 'Customer call: Acme quarterly review' });
    await ui.app.stop();
    await ui.app.tick();
    ui.advance(10);
    await ui.app.tick();
    expect(ui.$('#nudge')).not.toBeNull();
    expect(ui.$('#nudge-resume')).toBeNull();
    ui.app.destroy();
  });

  it('Settings: the switch, the minutes and the lock switch', async () => {
    const ui = await signedIn();
    ui.app.show('settings');
    expect(ui.$<HTMLInputElement>('#nudge-toggle').checked).toBe(true);
    const minutes = ui.$<HTMLSelectElement>('#nudge-minutes');
    expect([...minutes.options].map((option) => option.value)).toEqual(['5', '10', '15', '20', '30']);
    minutes.value = '20';
    minutes.dispatchEvent(new Event('change'));
    expect(ui.app.state.settings.nudgeMinutes).toBe(20);
    ui.$<HTMLInputElement>('#nudge-toggle').click();
    expect(ui.app.state.settings.nudgeWithoutTimer).toBe(false);
    expect(ui.$('#nudge-minutes')).toBeNull();
    expect(ui.$<HTMLInputElement>('#lock-toggle').checked).toBe(true);
    expect(ui.$('#lock-needs-idle')).toBeNull();
    ui.$<HTMLInputElement>('#lock-toggle').click();
    expect(ui.app.state.settings.pauseOnLock).toBe(false);
    ui.app.destroy();
  });
});

describe('pause on screen lock or sleep', () => {
  async function runningFor(ui: Ui, minutes: number) {
    await ui.app.start({ id: 'T-101', title: 'Write onboarding guide' });
    const timer = ui.app.state.activeTimer as Timer;
    ui.app.state = { ...ui.app.state, activeTimer: { ...timer, startedAt: new Date(ui.now() - minutes * 60_000).toISOString() } };
  }

  it('a lock of a few minutes asks the three-choice question on unlock', async () => {
    const ui = await signedIn();
    await runningFor(ui, 60);
    ui.hooks.sessionEvent('lock');
    await tick();
    ui.advance(6);
    ui.hooks.sessionEvent('unlock');
    await tick();
    expect(ui.app.state.idleCheck).toMatchObject({ phase: 'asking', from: new Date(ui.now() - 6 * 60_000).toISOString(), returnedAt: new Date(ui.now()).toISOString() });
    expect(ui.$('#idle-here')).not.toBeNull();
    expect(ui.$('#idle-reassign')).not.toBeNull();
    // Answered "back" already: no countdown.
    expect(ui.$('#idle-countdown')).toBeNull();
    ui.app.destroy();
  });

  it('a short lock asks nothing; sleep inside a lock asks only once unlocked and awake', async () => {
    const ui = await signedIn();
    await runningFor(ui, 60);
    ui.hooks.sessionEvent('lock');
    await tick();
    ui.advance(1);
    ui.hooks.sessionEvent('unlock');
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    ui.hooks.sessionEvent('lock');
    await tick();
    ui.advance(1);
    ui.hooks.sessionEvent('suspend');
    await tick();
    ui.advance(5);
    ui.hooks.sessionEvent('resume');
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    ui.hooks.sessionEvent('unlock');
    await tick();
    expect(ui.app.state.idleCheck).toMatchObject({ phase: 'asking', from: new Date(ui.now() - 6 * 60_000).toISOString() });
    ui.app.destroy();
  });

  it('a long sleep stops the timer at its start and asks about the gap', async () => {
    const ui = await signedIn();
    await runningFor(ui, 60);
    ui.hooks.sessionEvent('suspend');
    await tick();
    ui.advance(40);
    ui.hooks.sessionEvent('resume');
    await until(() => ui.app.state.idleCheck.phase === 'gap' && !ui.app.busy);
    expect(ui.app.state.activeTimer).toBeNull();
    expect(ui.$('#gap-keep')).not.toBeNull();
    expect(ui.$('#idle-reassign')).not.toBeNull();
    ui.app.destroy();
  });

  it('off in Settings, or without the "Still there?" check: nothing', async () => {
    const ui = await signedIn();
    await runningFor(ui, 60);
    ui.app.setHelper({ pauseOnLock: false });
    ui.hooks.sessionEvent('lock');
    await tick();
    ui.advance(6);
    ui.hooks.sessionEvent('unlock');
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    ui.app.destroy();

    localStorage.clear();
    await env.control('config', { idleCheck: { enabled: false, threshold_minutes: 10, answer_timeout_minutes: 5 } });
    const off = await signedIn();
    await runningFor(off, 60);
    expect(off.app.lockPauseOn()).toBe(false);
    off.app.show('settings');
    expect(off.$('#lock-needs-idle').textContent).toBe('It works with the “Still there?” check, which is off now.');
    off.app.show('main');
    off.hooks.sessionEvent('lock');
    await tick();
    off.advance(6);
    off.hooks.sessionEvent('unlock');
    await tick();
    expect(off.app.state.idleCheck.phase).toBe('watching');
    off.app.destroy();
  });
});
