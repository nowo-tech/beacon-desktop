// @vitest-environment happy-dom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, Task, Timer } from '../../src/api/types';
import { CATALOG, IDLE_COUNTDOWN_MINUTES, MESSAGE_LOCALES, noticeTitle, PAUSE_MINUTES, pauseMessages, pausedAt, resumeMessages, EMPTY_MESSAGES } from '../../src/lib/friendly';
import { POOL_KINDS } from '../../src/lib/messages/types';
import { EMPTY_NUDGE } from '../../src/lib/nudge';
import { loadLocal } from '../../src/lib/settings';
import { browserPlatform, browserPromptClient, notificationBody, type BrowserPromptHooks } from '../../src/platform';
import { DesktopApp } from '../../src/ui/app';
import { clock, PromptMount, renderPrompt, secondsLeft, type PromptView } from '../../src/ui/prompt';
import { startPromptWindow } from '../../src/ui/promptWindow';
import { nodeFetch, startMock, until } from './helpers';

let env: Awaited<ReturnType<typeof startMock>>;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

/** Tuesday 2026-11-03, 14:45 in Madrid. */
const NOW = Date.parse('2026-11-03T13:45:00Z');

async function signedIn(setup: (hooks: ReturnType<typeof browserPlatform>['hooks']) => void = () => undefined) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  let now = NOW;
  const platform = browserPlatform('0.5.0', nodeFetch);
  setup(platform.hooks);
  const app = new DesktopApp(root, platform, {
    storage: localStorage,
    locale: 'en',
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
  expect(app.view).toBe('main');
  return { app, hooks: platform.hooks, $, root, advance: (minutes: number) => void (now += minutes * 60_000), now: () => now };
}

function running(ui: Awaited<ReturnType<typeof signedIn>>, minutes: number, taskTitle = 'Write onboarding guide') {
  const timer: Timer = { id: 'E-1', taskId: 'T-101', taskTitle, startedAt: new Date(NOW - minutes * 60_000).toISOString() } as Timer;
  ui.app.me = { ...(ui.app.me as Me), workingHours: { timezone: 'Europe/Madrid', slots: [] } } as Me;
  ui.app.state = { ...ui.app.state, activeTimer: timer, idleCheck: { phase: 'watching' } };
  ui.app.render();
}

const asking = (ui: Awaited<ReturnType<typeof signedIn>>) => ({
  phase: 'asking',
  taskId: 'T-101',
  taskTitle: 'Write onboarding guide',
  from: new Date(ui.now() - 11 * 60_000).toISOString(),
  askedAt: new Date(ui.now() - 60_000).toISOString(),
  returnedAt: null,
  timerStartedAt: ui.app.state.activeTimer?.startedAt,
});

type Internals = { setIdleCheck(state: unknown): void; saved(timer: Timer, queued: boolean): void };
const internals = (app: DesktopApp) => app as unknown as Internals;

describe('friendly messages as desktop notifications', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('first need: asks the OS, sends the notification (title, line, pose), hides the toast and explains once', async () => {
    const ui = await signedIn((hooks) => (hooks.notificationPermission = 'prompt'));
    running(ui, 121);
    ui.app.checkFriendly();
    // Until the OS answers, the message is in the window.
    expect(ui.$('#cheer')).not.toBeNull();
    await tick();
    expect(ui.hooks.friendly).toEqual([{ title: 'Milestone!', body: '2 hours of solid work. That deserves a medal!', pose: 'achievement' }]);
    expect(ui.$('#cheer')).toBeNull();
    expect(ui.app.state.messages.card?.delivered).toBe('desktop');
    expect(ui.app.state.settings).toMatchObject({ nativeStatus: 'granted', nativeIntroSeen: true });
    expect(ui.$('#native-notice-title').textContent).toBe('Friendly messages now pop up on your desktop');
    ui.$<HTMLButtonElement>('#native-notice-ok').click();
    expect(ui.$('#native-notice')).toBeNull();
    // Once granted, the next one never shows as a toast first.
    ui.advance(130);
    ui.app.checkFriendly();
    expect(ui.$('#cheer')).toBeNull();
    await tick();
    expect(ui.hooks.friendly).toHaveLength(2);
    expect(ui.$('#native-notice')).toBeNull();
    ui.app.destroy();
  });

  it('"Keep them inside the app" from the explanation turns them off; Settings shows the switch', async () => {
    const ui = await signedIn((hooks) => (hooks.notificationPermission = 'granted'));
    running(ui, 121);
    ui.app.checkFriendly();
    await tick();
    ui.$<HTMLButtonElement>('#native-notice-in-app').click();
    expect(ui.app.state.settings.desktopNotifications).toBe(false);
    ui.app.show('settings');
    expect(ui.$<HTMLInputElement>('#desktop-notifications').checked).toBe(false);
    expect(ui.$('#native-status')).toBeNull();
    ui.$<HTMLInputElement>('#desktop-notifications').click();
    expect(ui.app.state.settings).toMatchObject({ desktopNotifications: true, nativeStatus: 'unknown' });
    ui.app.destroy();
  });

  it('denied: the toast stays, the window says so once and Settings explains with a retry', async () => {
    const ui = await signedIn((hooks) => {
      hooks.notificationPermission = 'prompt';
      hooks.permissionAnswer = 'denied';
    });
    running(ui, 121);
    ui.app.checkFriendly();
    await tick();
    expect(ui.hooks.friendly).toEqual([]);
    expect(ui.$('#cheer')).not.toBeNull();
    expect(ui.app.state.settings.nativeStatus).toBe('denied');
    expect(ui.$('#native-notice-title').textContent).toBe('Desktop notifications are off');
    expect(ui.$('#native-notice-in-app')).toBeNull();
    // Later messages go straight to the toast, without asking again.
    ui.app.dismissNativeNotice();
    ui.app.show('settings');
    expect(ui.$('#native-status').textContent).toContain('turned off for Beacon Desktop in your system settings');
    ui.$<HTMLButtonElement>('#native-retry').click();
    expect(ui.app.state.settings.nativeStatus).toBe('unknown');
    ui.app.destroy();
  });

  it('a notification service that fails brings the toast back and is reported in Settings', async () => {
    const ui = await signedIn((hooks) => {
      hooks.notificationPermission = 'granted';
      hooks.friendlyFails = true;
    });
    loadLocal(localStorage);
    ui.app.state = { ...ui.app.state, settings: { ...ui.app.state.settings, nativeStatus: 'granted' } };
    running(ui, 121);
    ui.app.checkFriendly();
    // Granted before: no toast at first …
    expect(ui.$('#cheer')).toBeNull();
    await tick();
    // … but the OS did not show it: back in the window.
    expect(ui.$('#cheer')).not.toBeNull();
    expect(ui.app.state.settings.nativeStatus).toBe('failed');
    ui.app.show('settings');
    expect(ui.$('#native-status').textContent).toContain('did not show the last notification');
    ui.app.destroy();
  });

  it('a plain browser has none: toasts, and Settings says why (no retry)', async () => {
    const ui = await signedIn();
    running(ui, 121);
    ui.app.checkFriendly();
    await tick();
    expect(ui.$('#cheer')).not.toBeNull();
    expect(ui.$('#native-notice')).toBeNull();
    expect(ui.app.state.settings.nativeStatus).toBe('unsupported');
    ui.app.show('settings');
    expect(ui.$('#native-status').textContent).toContain('not available here');
    expect(ui.$('#native-retry')).toBeNull();
    // Turning the switch on again keeps "unsupported" (nothing to ask).
    ui.app.setDesktopNotifications(true);
    expect(ui.app.state.settings.nativeStatus).toBe('unsupported');
    ui.app.destroy();
  });

  it('the "daily done" toast goes out as a desktop notification too', async () => {
    const ui = await signedIn((hooks) => (hooks.notificationPermission = 'granted'));
    const timer = { id: 'E-2', taskId: 'T-9', taskTitle: 'Daily stand-up', startedAt: new Date(NOW - 15 * 60_000).toISOString() } as Timer;
    internals(ui.app).saved(timer, false);
    await tick();
    expect(ui.hooks.friendly[0]).toMatchObject({ title: 'Daily done', pose: expect.any(String) });
    expect(ui.$('#daily-toast')).toBeNull();
    // Granted now: the next one is never drawn in the window, unless the OS fails.
    ui.hooks.friendlyFails = true;
    internals(ui.app).saved(timer, false);
    expect(ui.$('#daily-toast')).toBeNull();
    await tick();
    expect(ui.$('#daily-toast')).not.toBeNull();
    ui.app.destroy();
  });
});

describe('pause friendly messages for an hour (tray and Settings)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('the tray item pauses and resumes; nothing is shown meanwhile', async () => {
    const ui = await signedIn();
    running(ui, 121);
    await ui.app.updateTray();
    expect(ui.hooks.trayMenu?.pauseFriendly).toEqual({ id: 'pause-friendly', label: 'Pause friendly messages for 1 h' });
    ui.hooks.trayAction('pause-friendly');
    await tick();
    expect(ui.hooks.trayMenu?.pauseFriendly?.id).toBe('resume-friendly');
    expect(ui.hooks.trayMenu?.pauseFriendly?.label).toMatch(/^Friendly messages paused until .+ · Resume$/);
    ui.app.checkFriendly();
    expect(ui.app.state.messages.card).toBeNull();
    // A daily stopped while paused: no "daily done" either.
    internals(ui.app).saved({ id: 'E-2', taskId: 'T-9', taskTitle: 'Daily stand-up', startedAt: new Date(NOW - 900_000).toISOString() } as Timer, false);
    expect(ui.app.dailyToast).toBeNull();
    ui.app.show('settings');
    expect(ui.$('#friendly-paused-text').textContent).toMatch(/^Paused until /);
    ui.$<HTMLButtonElement>('#friendly-resume').click();
    await tick();
    expect(ui.app.state.messages.pausedUntil).toBeNull();
    expect(ui.$('#friendly-pause-button')).not.toBeNull();
    ui.$<HTMLButtonElement>('#friendly-pause-button').click();
    await tick();
    expect(pausedAt(ui.app.state.messages, new Date(ui.now()))).toBe(true);
    // After the hour it lifts by itself.
    ui.advance(PAUSE_MINUTES + 1);
    ui.app.show('main');
    ui.app.checkFriendly();
    expect(ui.app.state.messages.card).not.toBeNull();
    ui.app.destroy();
  });

  it('no pause item with both switches off', async () => {
    const ui = await signedIn();
    ui.app.setFriendly('funMessages', false);
    ui.app.setFriendly('wellbeingReminders', false);
    await ui.app.updateTray();
    expect(ui.hooks.trayMenu?.pauseFriendly).toBeNull();
    ui.app.show('settings');
    expect(ui.$('#friendly-pause')).toBeNull();
    ui.app.destroy();
  });

  it('pure helpers', () => {
    const now = new Date(NOW);
    const paused = pauseMessages(EMPTY_MESSAGES, now);
    expect(paused.pausedUntil).toBe(new Date(NOW + PAUSE_MINUTES * 60_000).toISOString());
    expect(pausedAt(paused, now)).toBe(true);
    expect(pausedAt(paused, new Date(NOW + PAUSE_MINUTES * 60_000))).toBe(false);
    expect(resumeMessages(paused).pausedUntil).toBeNull();
  });
});

describe('notification titles', () => {
  it('every locale has a short title for every kind of notice', () => {
    const kinds = POOL_KINDS.filter((kind) => kind !== 'idle' && kind !== 'meetingIdle');
    for (const locale of MESSAGE_LOCALES) {
      expect(Object.keys(CATALOG[locale].titles).sort()).toEqual([...kinds].sort());
      for (const kind of kinds) {
        const title = noticeTitle(locale, kind);
        expect(title.length, `${locale}.${kind}`).toBeGreaterThan(2);
        expect(title.length, `${locale}.${kind}`).toBeLessThanOrEqual(28);
        expect(title, `${locale}.${kind}`).not.toMatch(/\d/);
      }
      if (locale !== 'en') expect(CATALOG[locale].titles).not.toEqual(CATALOG.en.titles);
    }
  });
});

describe('wake-ups from the host (on time while the window is hidden)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('asks for the idle threshold while a timer runs, then the end of the countdown', async () => {
    const ui = await signedIn();
    expect(ui.hooks.wakePlan).toEqual({ deadlineAt: null, idleAfterSeconds: null, reminderAt: null });
    running(ui, 30);
    const threshold = ui.app.idleSettings().thresholdMinutes;
    expect(ui.hooks.wakePlan).toEqual({ deadlineAt: null, idleAfterSeconds: threshold * 60, reminderAt: null });
    // The host says the idle threshold was reached: the check runs at once and asks.
    ui.hooks.idleSeconds = threshold * 60 + 5;
    ui.hooks.wake('idle');
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('asking');
    const askedAt = Date.parse((ui.app.state.idleCheck as { askedAt: string }).askedAt);
    expect(ui.hooks.wakePlan).toEqual({ deadlineAt: askedAt + IDLE_COUNTDOWN_MINUTES * 60_000, idleAfterSeconds: null, reminderAt: null });
    // The deadline passes (window hidden: no countdown ticker ran): the timer stops at the start of the idle time.
    ui.advance(IDLE_COUNTDOWN_MINUTES + 0.1);
    ui.hooks.wake('deadline');
    await tick(150);
    expect(ui.app.state.idleCheck.phase).toBe('away');
    expect(ui.hooks.wakePlan).toEqual({ deadlineAt: null, idleAfterSeconds: null, reminderAt: null });
    ui.app.destroy();
  });
});

describe('"Still there?" in its own window', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('opens once, the main window only points to it, answers come back and close it', async () => {
    const ui = await signedIn((hooks) => {
      hooks.nativePrompt = true;
      hooks.notifications.length = 0;
    });
    running(ui, 30);
    internals(ui.app).setIdleCheck(asking(ui));
    await tick();
    expect(ui.hooks.promptOpened).toBe(1);
    const view = ui.hooks.prompt as PromptView;
    expect(view).toMatchObject({ id: 'idle', title: 'Still there?', windowTitle: 'Still there?', lang: 'en', escapeHint: expect.any(String), openApp: 'Open Beacon Desktop' });
    ui.hooks.answerPrompt({ action: 'open-app' });
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('asking');
    expect(view.blocks.map((block) => block.kind)).toEqual(['text', 'text', 'text', 'choices', 'countdown']);
    expect(view.blocks[0]).toMatchObject({ kind: 'text', id: 'idle-quip', tone: 'quip' });
    // The main window shows no modal, only where the question is.
    expect(ui.$<HTMLElement>('#idle-modal').hidden).toBe(true);
    expect(ui.$('#idle')).toBeNull();
    expect(ui.$('#prompt-elsewhere-text').textContent).toContain('its own window');
    ui.$<HTMLButtonElement>('#prompt-show').click();
    expect(ui.hooks.promptFocused).toBe(1);
    // Re-rendering does not reopen it.
    ui.app.render();
    await tick();
    expect(ui.hooks.promptOpened).toBe(1);
    // "I was in a meeting" opens the form in the window, focused on the note.
    ui.hooks.answerPrompt({ action: 'meeting-open' });
    await tick();
    const meeting = ui.hooks.prompt as PromptView;
    expect(meeting.blocks.find((block) => block.kind === 'meeting')).toBeDefined();
    expect(meeting.focus).toBe('idle-note');
    ui.hooks.answerPrompt({ action: 'meeting-cancel' });
    await tick();
    expect((ui.hooks.prompt as PromptView).focus).toBe('idle-meeting');
    ui.hooks.answerPrompt({ action: 'escape' });
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('asking');
    ui.hooks.answerPrompt({ action: 'meeting-save', note: 'Sprint review' });
    await tick(150);
    expect(ui.app.state.idleCheck.phase).toBe('watching');
    expect(ui.hooks.prompt).toBeNull();
    expect(ui.$('#prompt-elsewhere')).toBeNull();
    // Its own window is the attention signal: no extra notification.
    expect(ui.hooks.notifications).toEqual([]);
    ui.app.destroy();
  });

  it('after an automatic stop: "Resume … now" from the window restarts the same task', async () => {
    const ui = await signedIn((hooks) => (hooks.nativePrompt = true));
    running(ui, 30);
    internals(ui.app).setIdleCheck({ phase: 'away', taskId: 'T-101', taskTitle: 'Write onboarding guide', from: new Date(NOW - 600_000).toISOString() });
    await tick();
    expect((ui.hooks.prompt as PromptView).id).toBe('idle-away');
    ui.hooks.answerPrompt({ action: 'resume-now' });
    await tick(150);
    expect(ui.app.state.activeTimer?.taskId).toBe('T-101');
    expect(ui.hooks.prompt).toBeNull();
    ui.app.destroy();
  });

  it('the gap question offers the other tasks and reassigns from the window', async () => {
    const ui = await signedIn((hooks) => (hooks.nativePrompt = true));
    internals(ui.app).setIdleCheck({ phase: 'gap', taskId: 'T-101', taskTitle: 'Write onboarding guide', from: new Date(NOW - 3_600_000).toISOString(), to: new Date(NOW - 600_000).toISOString() });
    await tick();
    const view = ui.hooks.prompt as PromptView;
    expect(view.id).toBe('gap');
    const choices = view.blocks.find((block) => block.kind === 'choices');
    expect(choices?.kind === 'choices' && choices.items.some((item) => item.kind === 'button' && item.action === 'reassign-open')).toBe(true);
    // "Reassign" opens the picker in the window; the tasks to choose from come with it.
    ui.hooks.answerPrompt({ action: 'reassign-open' });
    await tick();
    const picker = (ui.hooks.prompt as PromptView).blocks.find((block) => block.kind === 'picker');
    const target = picker?.kind === 'picker' ? picker.options[0] : undefined;
    expect(target).toBeDefined();
    ui.hooks.answerPrompt({ action: 'gap-reassign', taskId: 'nope' });
    await tick();
    expect(ui.app.state.idleCheck.phase).toBe('gap');
    ui.hooks.answerPrompt({ action: 'gap-reassign', taskId: target?.id });
    await tick(150);
    expect(ui.app.state.idleCheck.phase).not.toBe('gap');
    ui.app.destroy();
  });

  it('when the window cannot be opened the question comes back as the in-app modal', async () => {
    const ui = await signedIn((hooks) => {
      hooks.nativePrompt = true;
      hooks.promptFails = true;
    });
    running(ui, 30);
    internals(ui.app).setIdleCheck(asking(ui));
    await tick();
    expect(ui.app.promptWindowFailed).toBe(true);
    expect(ui.$('#idle')).not.toBeNull();
    expect(ui.$('#idle').getAttribute('role')).toBe('dialog');
    // The in-app modal is already in the main window: no "Open Beacon Desktop" there.
    expect(ui.$('#prompt-open-app')).toBeNull();
    expect(ui.$('#prompt-elsewhere')).toBeNull();
    ui.app.destroy();
  });
});

describe('in-app toast leaves room for the last rows', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('marks the page while a toast is up', async () => {
    const ui = await signedIn();
    running(ui, 121);
    ui.app.checkFriendly();
    expect(ui.root.classList.contains('with-toasts')).toBe(true);
    ui.$<HTMLButtonElement>('#cheer-dismiss').click();
    expect(ui.root.classList.contains('with-toasts')).toBe(false);
    ui.app.destroy();
  });
});

const VIEW: PromptView = {
  id: 'idle',
  moment: 'stillThere',
  pose: null,
  title: 'Still there?',
  windowTitle: 'Still there?',
  lang: 'en',
  theme: 'dark',
  escapeHint: 'This question needs an answer.',
  openApp: 'Open Beacon Desktop',
  focus: null,
  focusSeq: 0,
  blocks: [
    { kind: 'text', id: 'idle-text', text: 'No activity for 10 min.' },
    { kind: 'choices', layout: 'list', labelledBy: 'idle-title', items: [{ kind: 'button', id: 'idle-here', label: 'Yes', style: 'primary', action: 'here' }] },
    { kind: 'countdown', askedAt: new Date(NOW).toISOString(), totalSeconds: 120, template: 'Pauses in {time}.' },
  ],
};

describe('the prompt renderer and the prompt window', () => {
  it('countdown text, bar and expiry from the wall clock', () => {
    vi.useFakeTimers();
    let now = NOW + 30_000;
    const expired = vi.fn();
    const rendered = renderPrompt(VIEW, { onAnswer: () => undefined, onExpired: expired, now: () => new Date(now) });
    expect(rendered.element.querySelector('#idle-countdown-text')?.textContent).toBe('Pauses in 1:30.');
    now = NOW + 121_000;
    vi.advanceTimersByTime(1000);
    expect(expired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(expired).toHaveBeenCalledTimes(1);
    rendered.dispose();
    vi.useRealTimers();
    expect(clock(61)).toBe('1:01');
    expect(clock(-3)).toBe('0:00');
    expect(secondsLeft({ askedAt: new Date(NOW).toISOString(), totalSeconds: 120 }, new Date(NOW + 200_000))).toBe(0);
  });

  it('the window draws the view, keeps it on Esc (saying why) and reports answers', async () => {
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const hooks: BrowserPromptHooks = { view: VIEW, answers: [] };
    const mount = await startPromptWindow(root, browserPromptClient(hooks));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.title).toBe('Still there?');
    expect(document.activeElement?.id).toBe('idle-here');
    const card = root.querySelector('#idle') as HTMLElement;
    expect(card.getAttribute('aria-modal')).toBe('true');
    root.querySelector<HTMLButtonElement>('#idle-here')?.blur();
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#idle')).not.toBeNull();
    expect(root.querySelector('#prompt-escape-hint')?.textContent).toBe('This question needs an answer.');
    expect(document.activeElement?.id).toBe('idle-here');
    root.querySelector<HTMLButtonElement>('#idle-here')?.click();
    expect(hooks.answers).toEqual([{ action: 'escape' }, { action: 'here' }]);
    // "Open Beacon Desktop" brings the main window forward and is not an answer.
    root.querySelector<HTMLButtonElement>('#prompt-open-app')?.click();
    expect(hooks.openedMain).toBe(1);
    expect(hooks.answers).toHaveLength(2);
    // An update from the main window, asking for a focus.
    hooks.setView?.({
      ...VIEW,
      theme: null,
      focus: 'idle-note',
      focusSeq: 1,
      blocks: [{ kind: 'meeting', noteLabel: 'Note', noteHelp: 'Optional', noteMax: 500, countOnLabel: 'Count it on', sameTaskLabel: 'Same task', targets: [{ id: 'T-2', title: 'Other' }], saveLabel: 'Save', cancelLabel: 'Cancel' }],
    });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(document.activeElement?.id).toBe('idle-note');
    (root.querySelector('#idle-note') as HTMLInputElement).value = 'Sprint review';
    (root.querySelector('#idle-target') as HTMLSelectElement).value = 'T-2';
    root.querySelector<HTMLFormElement>('#idle-meeting-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(hooks.answers.at(-1)).toEqual({ action: 'meeting-save', note: 'Sprint review', taskId: 'T-2' });
    root.querySelector<HTMLButtonElement>('#idle-meeting-cancel')?.click();
    expect(hooks.answers.at(-1)).toEqual({ action: 'meeting-cancel' });
    mount.show(null);
    expect(root.querySelector('#idle')).toBeNull();
    mount.dispose();
  });

  it('gap reassign and moment art without a pose', () => {
    const answers: unknown[] = [];
    const region = document.createElement('div');
    document.body.append(region);
    const mount = new PromptMount(region, { onAnswer: (answer) => answers.push(answer) });
    mount.show({
      ...VIEW,
      id: 'gap',
      moment: 'gap',
      blocks: [
        {
          kind: 'choices',
          layout: 'row',
          items: [
            { kind: 'text', text: 'Old server', tone: 'muted', id: 'gap-unsupported' },
            { kind: 'reassign', label: 'Another task', options: [{ id: 'T-3', title: 'Three' }], button: { kind: 'button', id: 'gap-reassign', label: 'Count it there', style: 'secondary', action: 'gap-reassign' } },
            { kind: 'button', id: 'gap-resume', label: 'Resume', style: 'primary', action: 'resume', play: true },
          ],
        },
        { kind: 'text', text: 'small', tone: 'small' },
        { kind: 'text', text: 'quip', tone: 'quip', lang: 'es' },
      ],
    });
    expect(region.querySelector('img')?.getAttribute('data-moment')).toBe('gap');
    expect(region.querySelector('.row-actions')).not.toBeNull();
    expect(region.querySelector('#gap-resume svg')).not.toBeNull();
    region.querySelector<HTMLButtonElement>('#gap-reassign')?.click();
    expect(answers).toEqual([{ action: 'gap-reassign', taskId: 'T-3' }]);
    mount.dispose();
  });
});

describe('privacy and plain text (security review FN-L2, FN-I4)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('signing out deletes the friendly-message history (its slots name the entries)', async () => {
    const ui = await signedIn();
    running(ui, 121);
    ui.app.checkFriendly();
    const stored = loadLocal(localStorage).messages;
    expect(stored.card?.entry).toMatch(/^T-101@/);
    expect(stored.seen.some((slot) => slot.includes('T-101@'))).toBe(true);
    await ui.app.logout();
    const after = loadLocal(localStorage);
    expect(after.messages).toEqual(EMPTY_MESSAGES);
    expect(JSON.stringify(after)).not.toContain('T-101@');
    expect(ui.app.dailyToast).toBeNull();
    ui.app.destroy();
  });

  it('signing out deletes the last task, pinned tasks, nudge state and generic meeting task (GC-L2)', async () => {
    const ui = await signedIn();
    const task = { id: 'T-101', title: 'Secret project Falcon' } as Task;
    ui.app.state = {
      ...ui.app.state,
      lastTask: task,
      pinned: [task, { id: 'T-102', title: 'Payroll review' } as Task],
      nudge: { activeSince: new Date(NOW).toISOString(), measured: true, lastAt: new Date(NOW).toISOString(), recent: [1, 2] },
      settings: { ...ui.app.state.settings, meetingGeneric: { id: 'T-103', title: 'Board meeting' }, meetingDetection: true },
    };
    await ui.app.logout();
    const after = loadLocal(localStorage);
    expect(after.lastTask).toBeNull();
    expect(after.pinned).toEqual([]);
    expect(after.nudge).toEqual(EMPTY_NUDGE);
    expect(after.settings.meetingGeneric).toBeNull();
    // Other settings of this computer stay.
    expect(after.settings.meetingDetection).toBe(true);
    const text = JSON.stringify(after);
    for (const title of ['Falcon', 'Payroll', 'Board meeting', 'T-101', 'T-102', 'T-103']) expect(text).not.toContain(title);
    expect(JSON.stringify(ui.app.state)).not.toContain('Falcon');
    ui.app.destroy();
  });

  it('Linux notification bodies are plain text; other systems unchanged', () => {
    const title = 'Fix <b>bold</b> & <img src=x onerror=alert(1)>';
    expect(notificationBody(title, 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('Fix &lt;b&gt;bold&lt;/b&gt; &amp; &lt;img src=x onerror=alert(1)&gt;');
    expect(notificationBody(title, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(title);
    expect(notificationBody(title, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(title);
  });
});
