/** Tauri implementation of Platform (thin bridge; the keychain and fetch parts are unit-tested with a mocked `invoke`, tests/unit/token-bridge.test.ts). */
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { availableMonitors, currentMonitor, getCurrentWindow, type Monitor, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { type NativeRequest, type NativeResponse, nativeFetch, SESSION_HANDLE } from './lib/nativeFetch';
import { type ChatHost, type ChatRealtimeMode, type TasksHost, type ConnectionSecurity, notificationBody, type NotificationPermission, type Platform, type WindowHost, type PromptClient, type PromptHost, type MiniHost, type SessionEvent, type UpdateCheck, type UpdateProgress, type WakeReason } from './platform';
import { type BrowserChoice, type DetectedBrowser, type OpenOutcome, sanitizeBrowser } from './lib/links';
import type { PromptAnswer, PromptView } from './ui/prompt';
import type { MiniAction, MiniClient, MiniView } from './ui/miniWindow';

const permission = (state: string): NotificationPermission => (state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt');

/** The "Still there?" window (src-tauri/src/prompt.rs): its content goes over `prompt_open`, answers come back as events. */
const promptHost: PromptHost = {
  open: (view) => invoke('prompt_open', { view }),
  focus: () => invoke('prompt_focus'),
  close: () => invoke('prompt_close'),
  onAnswer: (handler) => void listen<PromptAnswer>('prompt-answer', (event) => handler(event.payload)),
};

const workArea = (monitor: Monitor) => ({ x: monitor.workArea.position.x, y: monitor.workArea.position.y, width: monitor.workArea.size.width, height: monitor.workArea.size.height });

/** The main window's bounds (capabilities core:window:allow-set-size / allow-set-position / allow-unmaximize). */
function windowHost(): WindowHost {
  const win = getCurrentWindow();
  return {
    bounds: async () => {
      if ((await win.isMaximized()) || (await win.isMinimized())) return null;
      const [position, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
      return { x: position.x, y: position.y, width: size.width, height: size.height };
    },
    screens: async () => {
      const [all, current, scale] = await Promise.all([availableMonitors(), currentMonitor(), win.scaleFactor()]);
      return { areas: all.map(workArea), current: current === null ? null : workArea(current), scale };
    },
    setBounds: async (rect) => {
      if (await win.isMaximized()) await win.unmaximize();
      await win.setSize(new PhysicalSize(rect.width, rect.height));
      await win.setPosition(new PhysicalPosition(rect.x, rect.y));
    },
    onChange: (handler) => {
      void win.onResized(handler);
      void win.onMoved(handler);
    },
    // core:window:allow-show / allow-unminimize / allow-set-focus (main window only).
    bringForward: async () => {
      await win.show();
      await win.unminimize();
      await win.setFocus();
    },
  };
}

/** The mini timer window (src-tauri/src/mini.rs): the view goes over `mini_open` / `mini_update`, buttons come back as events. */
const miniHost: MiniHost = {
  open: (view) => invoke('mini_open', { view }),
  update: (view) => invoke('mini_update', { view }),
  close: () => invoke('mini_close'),
  onAction: (handler) => void listen<MiniAction>('mini-action', (event) => handler(event.payload)),
};

/** Inside the mini timer window: its view and its buttons only (capabilities/mini.json). */
export function tauriMiniClient(): MiniClient {
  return {
    view: () => invoke<MiniView | null>('mini_view'),
    onView: (handler) => void listen<MiniView>('mini-view', (event) => handler(event.payload)),
    action: (action) => invoke('mini_action', { action }),
  };
}

/** Inside the prompt window. */
export function tauriPromptClient(): PromptClient {
  return {
    view: () => invoke<PromptView | null>('prompt_view'),
    onView: (handler) => void listen<PromptView>('prompt-view', (event) => handler(event.payload)),
    answer: (answer) => invoke('prompt_answer', { answer }),
    openMain: () => invoke('prompt_show_main'),
  };
}

/** Chat (BD-2): the chat token stays in Rust (src-tauri/src/secret.rs), the stream too (src-tauri/src/realtime.rs). */
const chatHost: ChatHost = {
  token: async () => ((await invoke<boolean>('chat_status')) ? SESSION_HANDLE : null),
  tokenSet: async (token) => {
    if (token !== SESSION_HANDLE) throw new Error('The chat token is stored by the app from the connect answer only.');
  },
  connectBegin: () => invoke('chat_connect_begin', { locale: typeof document === 'undefined' ? null : document.documentElement.lang || null }),
  disconnect: () => invoke('chat_disconnect'),
  realtimeStart: (server, context) => invoke('chat_realtime_start', { server, context }),
  realtimeStop: () => invoke('chat_realtime_stop'),
  onHint: (handler) => void listen<unknown>('chat-hint', (event) => handler(event.payload)),
  onRealtime: (handler) => void listen<ChatRealtimeMode>('chat-realtime', (event) => handler(event.payload)),
  openLink: async (url) => void (await invoke<string>('open_chat_link', { url })),
  setUnreadBadge: (count) => invoke('set_unread_badge', { count: Math.max(0, Math.min(Math.trunc(count), 9999)) }),
};

/** Tasks (BD-3b): the tasks token stays in Rust (src-tauri/src/secret.rs, `tasks-token`). */
const tasksHost: TasksHost = {
  token: async () => ((await invoke<boolean>('tasks_status')) ? SESSION_HANDLE : null),
  tokenSet: async (token) => {
    if (token !== SESSION_HANDLE) throw new Error('The tasks token is stored by the app from the connect answer only.');
  },
  connectBegin: () => invoke('tasks_connect_begin', { locale: typeof document === 'undefined' ? null : document.documentElement.lang || null }),
  disconnect: () => invoke('tasks_disconnect'),
};

export function tauriPlatform(): Platform {
  return {
    kind: 'tauri',
    chat: chatHost,
    tasks: tasksHost,
    // Rust HTTP client with TLS public-key pinning for the official Beacon host (src-tauri/src/net.rs, docs/PINNING.md).
    // No redirects: the Bearer token stays bound to the configured server (audit CN D8).
    fetch: nativeFetch((request: NativeRequest) => invoke<NativeResponse>('beacon_fetch', { request })),
    connectionSecurity: (server) => invoke<ConnectionSecurity>('connection_security', { server }),
    // Every request and the updater are bound to this origin in Rust (audit FY-L1).
    bindServer: (server) => invoke('beacon_bind', { server }),
    // Rust asks the person in a native dialog the webview cannot answer ("Sign in to <host>?"), then keeps the token
    // of this sign-in only (audit GM-L2, GM-D-1). `locale` only picks the dialog's language.
    beginSignIn: (server) => invoke('sign_in_begin', { server, locale: typeof document === 'undefined' ? null : document.documentElement.lang || null }),
    appVersion: () => getVersion(),
    hostName: async () => (navigator.platform.toLowerCase().includes('mac') ? 'Mac' : navigator.platform.toLowerCase().includes('win') ? 'Windows PC' : 'Linux PC'),
    // The session token stays in Rust (src-tauri/src/secret.rs): the app only learns whether one is stored and holds
    // SESSION_HANDLE in its place. Rust stores the token from the sign-in answer itself, before the webview sees it.
    secretGet: async () => ((await invoke<boolean>('secret_status')) ? SESSION_HANDLE : null),
    secretSet: async (token) => {
      if (token !== SESSION_HANDLE) throw new Error('The session token is stored by the app from the sign-in answer only.');
    },
    secretDelete: () => invoke('secret_delete'),
    idleSeconds: () => invoke<number>('idle_seconds'),
    // Every link: the system default (opener plugin, no `with`) or the browser Rust keeps for "Open Beacon in"
    // (src-tauri/src/browser.rs). Only the URL crosses; the browser (and any executable path) never comes from here.
    openExternal: (url) => invoke<OpenOutcome>('open_external', { url }),
    listBrowsers: () => invoke<DetectedBrowser[]>('list_browsers'),
    getBrowser: async () => sanitizeBrowser(await invoke<BrowserChoice>('get_browser')),
    setBrowser: async (choice) => sanitizeBrowser(await invoke<BrowserChoice>('set_browser', { choice })),
    // The native file dialog is opened by Rust, which checks and keeps the picked file.
    pickBrowser: async () => {
      const picked = await invoke<BrowserChoice | null>('pick_browser');
      return picked === null ? null : sanitizeBrowser(picked);
    },
    onOpenExternal: (handler) => void listen<string>('open-external', (event) => handler(event.payload)),
    // Clipboard manager plugin, write-text permission only (capabilities/default.json).
    copyText: (text) => writeText(text),
    setTray: (status) => invoke('set_tray_status', { status }),
    setTrayMenu: (menu) => invoke('set_tray_menu', { menu }),
    setShortcut: (accelerator, slot = 'open') => invoke('set_global_shortcut', { accelerator, slot }),
    notify: async (title, body) => {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (granted) sendNotification({ title, body: notificationBody(body, navigator.userAgent) });
    },
    // Native notification with the pose and click-to-open, from Rust (src-tauri/src/notify.rs).
    notifyFriendly: async (note) => {
      try {
        await invoke('notify_friendly', { note });
        return true;
      } catch {
        return false;
      }
    },
    notificationPermission: async () => ((await isPermissionGranted()) ? 'granted' : 'prompt'),
    requestNotificationPermission: async () => permission(await requestPermission()),
    // The Rust heartbeat keeps the checks on time while the window is hidden (src-tauri/src/heartbeat.rs).
    onWake: (handler) => void listen<{ reason: WakeReason }>('wake', (event) => handler(event.payload.reason)),
    setWakePlan: (plan) => invoke('set_wake_plan', { plan }),
    // A button of a working-hours reminder notification (src-tauri/src/notify.rs, known ids only).
    onNotificationAction: (handler) => void listen<string>('notification-action', (event) => handler(event.payload)),
    // Meeting detection: what holds the microphone, from the heartbeat (src-tauri/src/meeting, app ids only).
    onMic: (handler) => void listen<unknown>('mic', (event) => handler(event.payload)),
    promptWindow: promptHost,
    miniWindow: miniHost,
    windowHost: windowHost(),
    // Title bar / native menus follow the app's theme; `null` hands it back to the system (capability core:window:allow-set-theme).
    setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
    // Rust command: on Windows only the app's own HKCU value and its Task Manager state.
    autostartEnabled: () => invoke<boolean>('get_autostart'),
    // Rust command: on Windows an HKCU-only, quoted Run value (never the plugin's HKLM / unquoted write).
    setAutostart: (enabled) => invoke('set_autostart', { enabled }),
    // Rust adds the stored token itself; the `token` argument (SESSION_HANDLE here) is not sent.
    checkUpdate: (server) => invoke<UpdateCheck>('check_update', { server }),
    installUpdate: async (server, _token, onProgress) => {
      const stop = await listen<UpdateProgress>('update-progress', (event) => onProgress?.(event.payload));
      try {
        await invoke('install_update', { server });
      } finally {
        stop();
      }
    },
    onShortcut: (handler) => void listen('shortcut', handler),
    // Emitted by Rust without showing the window (src-tauri/src/lib.rs, global shortcut handler).
    onResumeShortcut: (handler) => void listen('shortcut-resume', handler),
    // Screen lock / sleep from the OS (src-tauri/src/session.rs).
    onSessionEvent: (handler) => void listen<SessionEvent>('session-event', (event) => handler(event.payload)),
    onTray: (handler) => void listen<string>('tray-action', (event) => handler(event.payload)),
  };
}
