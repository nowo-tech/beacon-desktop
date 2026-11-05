/** Tauri implementation of Platform (thin bridge; covered by the Rust build and manual QA, not by unit tests). */
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Platform, UpdateCheck, UpdateProgress } from './platform';

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
      if (granted) sendNotification({ title, body });
    },
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
