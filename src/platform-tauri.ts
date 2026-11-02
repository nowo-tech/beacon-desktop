/** Tauri implementation of Platform (thin bridge; covered by the Rust build and manual QA, not by unit tests). */
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Platform, UpdateCheck } from './platform';

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
    setTray: (text, running) => invoke('set_tray_status', { text, running }),
    notify: async (title, body) => {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (granted) sendNotification({ title, body });
    },
    autostartEnabled: () => isEnabled(),
    setAutostart: (enabled) => (enabled ? enable() : disable()),
    checkUpdate: (server, token) => invoke<UpdateCheck>('check_update', { server, token }),
    installUpdate: (server, token) => invoke('install_update', { server, token }),
    on: (event, handler) => void listen(event, handler),
  };
}
