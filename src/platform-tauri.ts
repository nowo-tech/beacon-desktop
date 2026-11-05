/** Tauri implementation of Platform (thin bridge; covered by the Rust build and manual QA, not by unit tests). */
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { availableMonitors, currentMonitor, getCurrentWindow, type Monitor, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open as openFile } from '@tauri-apps/plugin-dialog';
import { notificationBody, type NotificationPermission, type Platform, type WindowHost, type PromptClient, type PromptHost, type UpdateCheck, type UpdateProgress, type WakeReason } from './platform';
import type { BrowserChoice, DetectedBrowser, OpenOutcome } from './lib/links';
import type { PromptAnswer, PromptView } from './ui/prompt';

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

export function tauriPlatform(): Platform {
  return {
    kind: 'tauri',
    // No redirects: the Bearer token stays bound to the configured server (audit CN D8).
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => tauriFetch(input, { ...init, maxRedirections: 0 })) as typeof fetch,
    appVersion: () => getVersion(),
    hostName: async () => (navigator.platform.toLowerCase().includes('mac') ? 'Mac' : navigator.platform.toLowerCase().includes('win') ? 'Windows PC' : 'Linux PC'),
    secretGet: () => invoke<string | null>('secret_get'),
    secretSet: (token) => invoke('secret_set', { token }),
    secretDelete: () => invoke('secret_delete'),
    idleSeconds: () => invoke<number>('idle_seconds'),
    // Every link: the system default (opener plugin, no `with`) or the chosen browser, from Rust (src-tauri/src/browser.rs).
    openExternal: (url, browser) => invoke<OpenOutcome>('open_external', { url, browser }),
    listBrowsers: () => invoke<DetectedBrowser[]>('list_browsers'),
    pickBrowser: async () => {
      const mac = navigator.userAgent.includes('Mac');
      const windows = navigator.userAgent.includes('Windows');
      const path = await openFile({
        multiple: false,
        directory: false,
        filters: windows ? [{ name: 'Browser', extensions: ['exe'] }] : mac ? [{ name: 'Browser', extensions: ['app'] }] : [],
      });
      if (typeof path !== 'string') return null;
      const checked = await invoke<DetectedBrowser>('check_browser', { path });
      return { kind: 'custom', path, name: checked.name } satisfies BrowserChoice;
    },
    onOpenExternal: (handler) => void listen<string>('open-external', (event) => handler(event.payload)),
    // Clipboard manager plugin, write-text permission only (capabilities/default.json).
    copyText: (text) => writeText(text),
    setTray: (status) => invoke('set_tray_status', { status }),
    setTrayMenu: (menu) => invoke('set_tray_menu', { menu }),
    setShortcut: (accelerator) => invoke('set_global_shortcut', { accelerator }),
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
    promptWindow: promptHost,
    windowHost: windowHost(),
    // Title bar / native menus follow the app's theme; `null` hands it back to the system (capability core:window:allow-set-theme).
    setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
    autostartEnabled: () => isEnabled(),
    setAutostart: (enabled) => (enabled ? enable() : disable()),
    checkUpdate: (server, token) => invoke<UpdateCheck>('check_update', { server, token }),
    installUpdate: async (server, token, onProgress) => {
      const stop = await listen<UpdateProgress>('update-progress', (event) => onProgress?.(event.payload));
      try {
        await invoke('install_update', { server, token });
      } finally {
        stop();
      }
    },
    onShortcut: (handler) => void listen('shortcut', handler),
    onTray: (handler) => void listen<string>('tray-action', (event) => handler(event.payload)),
  };
}
