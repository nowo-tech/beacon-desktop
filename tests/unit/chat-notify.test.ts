// @vitest-environment happy-dom
// Chat notifications (BD-3b, level None), the tray's chat items and `beacon-desktop://` links: the notifier's rules,
// then the shell against the in-process mock Beacon (opt-in card, a notification for a new message elsewhere, none for
// the conversation being read, pause from the tray, a click and a link opening the conversation or a task).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatNotifier, loadNotifyPrefs, MIN_GAP_MS, NOTIFY_KEY, tomorrowMorning } from '../../src/chat/notifications';
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
    expect(ui.platform.hooks.friendly[0]).toEqual({ title: 'Beacon Desktop', body: 'New message in Beacon', pose: null, click: `chat-open:${MAYA}` });
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
    ui.platform.hooks.notificationAction(`chat-open:${MAYA}`);
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

  it('links: a conversation in another organization (switching), an unknown one, a task without tasks, one at launch', async () => {
    const ui = await connected((platform) => (platform.hooks.pendingDeepLink = { kind: 'chat', id: ENVELOPE, context: null }));
    // The link the app was started with opened once the chat was ready (Personal has no envelope-v2: not found).
    expect(ui.platform.hooks.pendingDeepLink).toBeNull();
    ui.platform.hooks.deepLink({ kind: 'chat', id: '0c000000-0000-4000-8000-000000000010', context: 'personal' });
    await until(() => ui.shell.context === 'personal' && ui.shell.chat.openUuid() === '0c000000-0000-4000-8000-000000000010', 'the personal conversation');
    ui.platform.hooks.deepLink({ kind: 'chat', id: ENVELOPE, context: ORG });
    await until(() => ui.shell.context === ORG && ui.shell.chat.openUuid() === ENVELOPE, 'the organization conversation');
    ui.platform.hooks.deepLink({ kind: 'chat', id: '0c000000-0000-4000-8000-0000000000ff', context: 'org:00000000-0000-4000-8000-000000000000' });
    await until(() => document.querySelector('#shell-live')?.textContent === 'That conversation is not available here.', 'not found');
    ui.platform.hooks.deepLink({ kind: 'task', id: 't-141', context: null });
    await until(() => ui.shell.module === 'tasks', 'the tasks module');
    await until(() => document.querySelector('#shell-live')?.textContent === 'Connect tasks to open that task.', 'tasks off');
  });
});
