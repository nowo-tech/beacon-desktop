// @vitest-environment happy-dom
// Chat notifications (BD-3b, level None), the tray's chat items and `beacon-desktop://` links: the notifier's rules,
// then the shell against the in-process mock Beacon (opt-in card, a notification for a new message elsewhere, none for
// the conversation being read, pause from the tray, a click and a link opening the conversation or a task).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatNotifier, chatClickTarget, loadNotifyPrefs, MIN_GAP_MS, NOTIFY_KEY, parseChatClick, tomorrowMorning } from '../../src/chat/notifications';
import type { Conversation } from '../../src/chat/types';
import { browserPlatform } from '../../src/platform';
import { Shell } from '../../src/shell/shell';
import { DesktopApp } from '../../src/ui/app';
import { nodeFetch, startMock } from './helpers';

const row = (n: number, extra: Partial<Conversation> = {}): Conversation => ({
  uuid: `0c000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind: 'channel',
  title: `room-${n}`,
  subtitle: '',
  initials: 'RO',
  channelKey: null,
  peerStatus: null,
  unread: 0,
  archived: false,
  mutedUntil: null,
  lastMessageAt: '2026-11-27T10:00:00Z',
  lastMessageId: 10,
  preview: null,
  lastMine: false,
  ticketStatus: null,
  canSend: true,
  ...extra,
});

describe('chat notifier', () => {
  it('primes first, then notifies once per new message, never for one’s own, muted or the conversation read', () => {
    let now = 1_000_000;
    const notifier = new ChatNotifier(undefined, () => now);
    notifier.setEnabled(true);
    const state = { open: null, reading: false };
    expect(notifier.observe([row(1, { unread: 3 })], state)).toBeNull();
    expect(notifier.observe([row(1, { unread: 3 })], state)).toBeNull();
    expect(notifier.observe([row(1, { unread: 4, lastMessageId: 11 })], state)).toBe(row(1).uuid);
    now += MIN_GAP_MS + 1;
    expect(notifier.observe([row(1, { unread: 4, lastMessageId: 11 })], state)).toBeNull();
    expect(notifier.observe([row(1, { unread: 0, lastMessageId: 12 })], state)).toBeNull();
    expect(notifier.observe([row(1, { unread: 1, lastMessageId: 13, lastMine: true })], state)).toBeNull();
    expect(notifier.observe([row(1, { unread: 1, lastMessageId: 14, mutedUntil: '2099-01-01T00:00:00Z' })], state)).toBeNull();
    expect(notifier.observe([row(1, { unread: 1, lastMessageId: 15 })], { open: row(1).uuid, reading: true })).toBeNull();
    // Not reading (window in the background): it notifies. Several at once: the newest, once.
    expect(notifier.observe([row(1, { unread: 1, lastMessageId: 16 }), row(2, { unread: 1, lastMessageId: 3, lastMessageAt: '2026-11-27T11:00:00Z' })], { open: row(1).uuid, reading: false })).toBe(row(2).uuid);
    // Too soon after the last one.
    expect(notifier.observe([row(1, { unread: 1, lastMessageId: 17 })], state)).toBeNull();
    now += MIN_GAP_MS + 1;
    notifier.pause(now + 1000);
    expect(notifier.paused()).toBe(true);
    expect(notifier.observe([row(1, { unread: 1, lastMessageId: 18 })], state)).toBeNull();
    notifier.resume();
    notifier.setEnabled(false);
    expect(notifier.observe([row(1, { unread: 1, lastMessageId: 19 })], state)).toBeNull();
    // A reset (context switch) primes again.
    notifier.setEnabled(true);
    notifier.reset();
    expect(notifier.observe([row(1, { unread: 1, lastMessageId: 20 })], state)).toBeNull();
    expect(notifier.observe([row(3, { unread: 1, lastMessageId: null })], state)).toBeNull();
  });

  it('click targets carry the context they were notified in, and nothing else parses (BDA13-L3)', () => {
    const uuid = '0c000000-0000-4000-8000-000000000006';
    const org = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
    expect(chatClickTarget(org, uuid)).toBe(`chat-open:${org}:${uuid}`);
    expect(chatClickTarget('personal', uuid)).toBe(`chat-open:personal:${uuid}`);
    expect(chatClickTarget(null, uuid)).toBe(`chat-open:${uuid}`);
    expect(chatClickTarget('org:not-a-uuid', uuid)).toBe(`chat-open:${uuid}`);
    expect(parseChatClick(`chat-open:${org}:${uuid}`)).toEqual({ context: org, id: uuid });
    expect(parseChatClick(`chat-open:personal:${uuid.toUpperCase()}`)).toEqual({ context: 'personal', id: uuid });
    expect(parseChatClick(`chat-open:${uuid}`)).toEqual({ context: null, id: uuid });
    for (const bad of ['chat-open:', `chat-open::${uuid}`, `chat-open:evil:${uuid}`, `chat-open:org:x:${uuid}`, `chat-open:${org}`, `chat-open:personal${uuid}`, `schedule-stop`, `chat-open:${uuid}x`]) {
      expect(parseChatClick(bad), bad).toBeNull();
    }
  });

  it('keeps only the setting, and survives broken storage', () => {
    localStorage.clear();
    const notifier = new ChatNotifier(localStorage);
    expect(notifier.prefs).toEqual({ enabled: false, asked: false, pausedUntil: null });
    notifier.dismiss();
    expect(loadNotifyPrefs(localStorage)).toEqual({ enabled: false, asked: true, pausedUntil: null });
    notifier.setEnabled(true);
    notifier.pause(5);
    expect(loadNotifyPrefs(localStorage)).toEqual({ enabled: true, asked: true, pausedUntil: 5 });
    localStorage.setItem(NOTIFY_KEY, '{');
    expect(loadNotifyPrefs(localStorage).enabled).toBe(false);
    localStorage.setItem(NOTIFY_KEY, '{"enabled":true,"pausedUntil":"x"}');
    expect(loadNotifyPrefs(localStorage)).toEqual({ enabled: true, asked: false, pausedUntil: null });
    expect(loadNotifyPrefs(undefined).enabled).toBe(false);
    const broken = { getItem: () => null, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(() => new ChatNotifier(broken).setEnabled(true)).not.toThrow();
    const morning = new Date(tomorrowMorning(new Date(2026, 10, 27, 22, 0).getTime()));
    expect([morning.getDate(), morning.getHours(), morning.getMinutes()]).toEqual([28, 8, 0]);
  });
});

// ---- the shell ------------------------------------------------------------------------------------------------------

let env: Awaited<ReturnType<typeof startMock>>;
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  env = await startMock();
});
afterAll(() => env.mock.close());

async function until(ready: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ORG = 'org:6a0e1f8e-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const ENVELOPE = '0c000000-0000-4000-8000-000000000001';
const MAYA = '0c000000-0000-4000-8000-000000000006';

async function connected(beforeInit?: (platform: ReturnType<typeof browserPlatform>) => void) {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const platform = browserPlatform('0.1.0', nodeFetch);
  platform.hooks.notificationPermission = 'prompt';
  beforeInit?.(platform);
  const shell = new Shell(root, platform, { locale: 'en', storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, { storage: localStorage, locale: 'en', onRender: () => shell.onAppRender(), trayChat: () => shell.trayChat(), sleep: () => new Promise((resolve) => setTimeout(resolve, 5)), searchDelayMs: 1 });
  shell.attach(app);
  shell.freshSignIn = true;
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T;
  await app.init();
  const done = app.connect(env.url);
  await until(() => $('#user-code') !== null, 'the device code');
  await env.control('device/approve', { userCode: $('#user-code').textContent });
  await done;
  $<HTMLButtonElement>('#tab-chat').click();
  $<HTMLButtonElement>('#chat-connect').click();
  await until(() => $('#chat-user-code') !== null, 'the chat code');
  await env.control('device/approve', { userCode: $('#chat-user-code').textContent });
  await until(() => $('.side .conv') !== null, 'the conversations');
  $<HTMLButtonElement>(`.ctx-tile[data-context="${ORG}"]`).click();
  await until(() => $(`[data-conv="${ENVELOPE}"]`) !== null, 'the organization');
  return { platform, shell, app, $ };
}

describe('chat notifications, tray and links in the shell', () => {
  beforeEach(async () => {
    localStorage.clear();
    await env.control('reset', {});
    await env.control('config', { deviceInterval: 1 });
  });

  it('asks once, notifies a new message elsewhere at level None, opens it on click; tray pause and Open chat', async () => {
    const ui = await connected();
    expect(ui.$('#chat-ask .notif-ask')).not.toBeNull();
    ui.$<HTMLButtonElement>('#notify-on').click();
    await until(() => ui.shell.notifier.prefs.enabled, 'notifications on');
    expect(ui.platform.hooks.notificationPermission).toBe('granted');
    expect(ui.$('#chat-ask').hidden).toBe(true);
    // A message from Maya while envelope-v2 is open and read: one notification, no sender, no text.
    ui.$<HTMLButtonElement>(`[data-conv="${ENVELOPE}"]`).click();
    await until(() => ui.shell.chat.openUuid() === ENVELOPE, 'envelope');
    await env.control('chat/post', { conversation: MAYA, author: 'maya', text: 'Secret plans' });
    ui.platform.hooks.chatHint({ kind: 'message', conversationUuid: MAYA, messageId: 9999 });
    await until(() => ui.platform.hooks.friendly.length === 1, 'the notification');
    expect(ui.platform.hooks.friendly[0]).toEqual({ title: 'Beacon Desktop', body: 'New message in Beacon', pose: null, click: `chat-open:${ORG}:${MAYA}` });
    expect(JSON.stringify(ui.platform.hooks.friendly)).not.toContain('Secret');
    expect(JSON.stringify(ui.platform.hooks.friendly)).not.toContain('Maya');
    // The tray: Open chat (with the unread count) and Pause.
    await ui.app.updateTray();
    expect(ui.platform.hooks.trayMenu?.chat?.map((item) => item.id)).toEqual(['open-chat', 'pause-chat']);
    expect(ui.platform.hooks.trayMenu?.chat?.[0].label).toMatch(/^Open chat \(\d+ unread\)$/);
    ui.platform.hooks.trayAction('pause-chat');
    await until(() => ui.shell.notifier.paused(), 'paused');
    await ui.app.updateTray();
    expect(ui.platform.hooks.trayMenu?.chat?.[1].id).toBe('resume-chat');
    await env.control('chat/post', { conversation: MAYA, author: 'maya', text: 'Again' });
    ui.platform.hooks.chatHint({ kind: 'message', conversationUuid: MAYA, messageId: 9998 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(ui.platform.hooks.friendly).toHaveLength(1);
    ui.platform.hooks.trayAction('resume-chat');
    expect(ui.shell.notifier.paused()).toBe(false);
    // A click on the notification opens the conversation.
    ui.shell.show('time');
    ui.platform.hooks.notificationAction(`chat-open:${ORG}:${MAYA}`);
    await until(() => ui.shell.module === 'chat' && ui.shell.chat.openUuid() === MAYA, 'the conversation');
    ui.shell.show('time');
    ui.platform.hooks.trayAction('open-chat');
    expect(ui.shell.module).toBe('chat');
    // Settings: level, pause until tomorrow, resume, off.
    ui.shell.openSettings();
    expect(ui.$('#notify-level').textContent).toContain('no sender');
    ui.$<HTMLButtonElement>('#notify-pause-tomorrow').click();
    expect(ui.shell.notifier.paused()).toBe(true);
    ui.$<HTMLButtonElement>('#notify-resume').click();
    ui.$<HTMLButtonElement>('#notify-pause-hour').click();
    expect(ui.shell.notifier.paused()).toBe(true);
    (ui.$('#shell-settings [aria-label="Notifications"] [data-value="off"]') as HTMLButtonElement).click();
    await until(() => !ui.shell.notifier.prefs.enabled, 'off');
    expect(ui.shell.trayChat().map((item) => item.id)).toEqual(['open-chat']);
  });

  it('a refused permission says so; Not now hides the card', async () => {
    const ui = await connected((platform) => (platform.hooks.permissionAnswer = 'denied'));
    ui.$<HTMLButtonElement>('#notify-later').click();
    expect(ui.$('#chat-ask').hidden).toBe(true);
    expect(ui.shell.notifier.prefs).toMatchObject({ enabled: false, asked: true });
    await ui.shell.setNotifications(true);
    ui.shell.openSettings();
    expect(ui.$('#shell-settings').textContent).toContain('blocked for Beacon Desktop');
  });

  it('links: a conversation in another organization (asked first), an unknown one, a task without tasks, one at launch', async () => {
    const ui = await connected((platform) => (platform.hooks.pendingDeepLink = { kind: 'chat', id: ENVELOPE, context: null }));
    // The link the app was started with opened once the chat was ready (Personal has no envelope-v2: not found).
    expect(ui.platform.hooks.pendingDeepLink).toBeNull();
    const live = () => document.querySelector('#shell-live')?.textContent ?? '';
    // Another organization: never switched silently (BDA13-I1). Cancel stays and opens nothing.
    ui.platform.hooks.deepLink({ kind: 'chat', id: '0c000000-0000-4000-8000-000000000010', context: 'personal' });
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the link question');
    expect(ui.$('#shell-confirm .dlg-b').textContent).toBe('A link asks to open a conversation in Personal. You are in Lumen Works now.');
    // Another link while asked: not a second question over the first one.
    ui.platform.hooks.deepLink({ kind: 'task', id: 't-141', context: 'personal' });
    await until(() => live() === 'Stayed in Lumen Works. The link was not opened.', 'the second link declined');
    expect(ui.$('#shell-confirm .dlg-b').textContent).toContain('a conversation');
    ui.$('#shell-live').textContent = '';
    ui.$<HTMLButtonElement>('#confirm-cancel').click();
    await until(() => live() === 'Stayed in Lumen Works. The link was not opened.', 'declined');
    expect(ui.shell.context).toBe(ORG);
    expect(ui.shell.chat.openUuid()).not.toBe('0c000000-0000-4000-8000-000000000010');
    // Taken once: nothing is left in the host (BDA13-L1).
    expect(ui.platform.hooks.pendingDeepLink).toBeNull();
    ui.platform.hooks.deepLink({ kind: 'chat', id: '0c000000-0000-4000-8000-000000000010', context: 'personal' });
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the link question again');
    ui.$<HTMLButtonElement>('#confirm-link-switch').click();
    await until(() => ui.shell.context === 'personal' && ui.shell.chat.openUuid() === '0c000000-0000-4000-8000-000000000010', 'the personal conversation');
    ui.platform.hooks.deepLink({ kind: 'chat', id: ENVELOPE, context: ORG });
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the question for the organization');
    ui.$<HTMLButtonElement>('#confirm-link-switch').click();
    await until(() => ui.shell.context === ORG && ui.shell.chat.openUuid() === ENVELOPE, 'the organization conversation');
    // An organization the person does not have: no question, no switch, not found here.
    ui.platform.hooks.deepLink({ kind: 'chat', id: '0c000000-0000-4000-8000-0000000000ff', context: 'org:00000000-0000-4000-8000-000000000000' });
    await until(() => live() === 'That conversation is not available here.', 'not found');
    expect(ui.$<HTMLDialogElement>('#shell-confirm').open).toBe(false);
    ui.platform.hooks.deepLink({ kind: 'task', id: 't-141', context: null });
    await until(() => ui.shell.module === 'tasks', 'the tasks module');
    await until(() => live() === 'Connect tasks to open that task.', 'tasks off');
  });

  it('a link handled while running never opens again after sign-out and sign-in (BDA13-L1)', async () => {
    const ui = await connected();
    ui.platform.hooks.deepLink({ kind: 'chat', id: MAYA, context: null });
    await until(() => ui.shell.module === 'chat' && ui.shell.chat.openUuid() === MAYA, 'the conversation');
    expect(ui.platform.hooks.pendingDeepLink).toBeNull();
    ui.shell.show('time');
    await ui.app.logout();
    await until(() => ui.shell.root.dataset.bare === 'true', 'signed out');
    // A link that came in but was never taken is forgotten at sign-out too.
    ui.platform.hooks.pendingDeepLink = { kind: 'chat', id: ENVELOPE, context: ORG };
    await ui.platform.secretDelete();
    expect(ui.platform.hooks.pendingDeepLink).toBeNull();
    const done = ui.app.connect(env.url);
    await until(() => ui.$('#user-code') !== null, 'the device code');
    await env.control('device/approve', { userCode: ui.$('#user-code').textContent });
    await done;
    await until(() => ui.shell.root.dataset.bare === 'false', 'signed in again');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ui.shell.module).toBe('time');
    expect(ui.$<HTMLDialogElement>('#shell-confirm').open).toBe(false);
    expect(document.querySelector('#shell-live')?.textContent ?? '').not.toContain('not available');
  });

  it('a notification click goes back to the organization it was notified in; a running timer is asked about (BDA13-L3)', async () => {
    const ui = await connected();
    // Notified in Lumen Works, clicked after switching to Personal: back there, no link question.
    ui.$<HTMLButtonElement>('.ctx-tile[data-context="personal"]').click();
    await until(() => ui.shell.context === 'personal', 'personal');
    ui.platform.hooks.notificationAction(`chat-open:${ORG}:${MAYA}`);
    await until(() => ui.shell.context === ORG && ui.shell.chat.openUuid() === MAYA, 'the conversation in its organization');
    expect(ui.$<HTMLDialogElement>('#shell-confirm').open).toBe(false);
    // With a timer running in Lumen Works, a click for Personal asks the stop question first (Q4); Cancel stays.
    ui.shell.show('time');
    await until(() => !ui.app.busy, 'the time module');
    (ui.shell.timeRoot.querySelector('[data-task="T-104"] .row-action') as HTMLButtonElement).click();
    await until(() => ui.app.state.activeTimer !== null, 'the timer');
    ui.platform.hooks.notificationAction('chat-open:personal:0c000000-0000-4000-8000-000000000010');
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the stop question');
    expect(ui.$('#shell-confirm-title').textContent).toBe('Stop the timer in Lumen Works and switch?');
    ui.$<HTMLButtonElement>('#confirm-cancel').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ui.shell.context).toBe(ORG);
    expect(ui.app.state.activeTimer).not.toBeNull();
    // A link with a running timer: the stop question is the only one (no second link question).
    ui.platform.hooks.deepLink({ kind: 'chat', id: '0c000000-0000-4000-8000-000000000010', context: 'personal' });
    await until(() => ui.$<HTMLDialogElement>('#shell-confirm').open, 'the stop question for the link');
    expect(document.querySelector('#confirm-stop-switch')).not.toBeNull();
    expect(document.querySelector('#confirm-link-switch')).toBeNull();
    ui.$<HTMLButtonElement>('#confirm-stop-switch').click();
    await until(() => ui.shell.context === 'personal' && ui.shell.chat.openUuid() === '0c000000-0000-4000-8000-000000000010', 'switched and opened');
    expect(ui.app.state.activeTimer).toBeNull();
  });
});
