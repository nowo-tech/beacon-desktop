/** Tauri implementation of Platform (thin bridge; covered by the Rust build and manual QA, not by unit tests). */
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import { type NativeRequest, type NativeResponse, nativeFetch } from './lib/nativeFetch';
import { type ConnectionSecurity, notificationBody, type NotificationPermission, type Platform, type PromptClient, type PromptHost, type UpdateCheck, type UpdateProgress, type WakeReason } from './platform';
import type { PromptAnswer, PromptView } from './ui/prompt';

const permission = (state: string): NotificationPermission => (state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt');

/** The "Still there?" window (src-tauri/src/prompt.rs): its content goes over `prompt_open`, answers come back as events. */
const promptHost: PromptHost = {
  open: (view) => invoke('prompt_open', { view }),
  focus: () => invoke('prompt_focus'),
  close: () => invoke('prompt_close'),
  onAnswer: (handler) => void listen<PromptAnswer>('prompt-answer', (event) => handler(event.payload)),
};

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
    // Rust HTTP client with TLS public-key pinning for the official Beacon host (src-tauri/src/net.rs, docs/PINNING.md).
    // No redirects: the Bearer token stays bound to the configured server (audit CN D8).
    fetch: nativeFetch((request: NativeRequest) => invoke<NativeResponse>('beacon_fetch', { request })),
    connectionSecurity: (server) => invoke<ConnectionSecurity>('connection_security', { server }),
    // Every request and the updater are bound to this origin in Rust (audit FY-L1).
    bindServer: (server) => invoke('beacon_bind', { server }),
    appVersion: () => getVersion(),
    hostName: async () => (navigator.platform.toLowerCase().includes('mac') ? 'Mac' : navigator.platform.toLowerCase().includes('win') ? 'Windows PC' : 'Linux PC'),
    secretGet: () => invoke<string | null>('secret_get'),
    secretSet: (token) => invoke('secret_set', { token }),
    secretDelete: () => invoke('secret_delete'),
    idleSeconds: () => invoke<number>('idle_seconds'),
    openUrl: (url) => openUrl(url),
    copyText: async (text) => {
      // The webview's async clipboard API (secure context, user gesture); no clipboard plugin / capability needed.
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const area = document.createElement('textarea');
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    },
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
