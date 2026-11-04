/**
 * What the UI needs from the host. In the Tauri app it is backed by Rust commands and plugins (platform-tauri.ts);
 * in a plain browser (development, e2e) by the in-memory fallback below.
 */
export type UpdateCheck =
  | { status: 'up_to_date'; min_supported_version?: string | null }
  | { status: 'unauthorized' }
  | {
      status: 'available';
      version: string;
      notes?: string | null;
      min_supported_version?: string | null;
      /** False when the build has no updater public key (cannot verify, so never block). */
      installable?: boolean;
    }
  | { status: 'error'; message: string };

export type PlatformEvent = 'tray-stop' | 'tray-open-beacon' | 'shortcut';

export interface Platform {
  readonly kind: 'tauri' | 'browser';
  fetch: typeof fetch;
  appVersion(): Promise<string>;
  hostName(): Promise<string>;
  secretGet(): Promise<string | null>;
  secretSet(token: string): Promise<void>;
  secretDelete(): Promise<void>;
  /** Seconds since the last input, read locally from the OS. Never sent. */
  idleSeconds(): Promise<number>;
  openUrl(url: string): Promise<void>;
  /**
   * Tray status text, "Stop timer" enabled state and the "Open Beacon" item: `beaconLabel` is its translated label, or
   * `null` to hide it (not connected, or the server is not https).
   */
  setTray(text: string, running: boolean, beaconLabel: string | null): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  autostartEnabled(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
  checkUpdate(server: string, token: string): Promise<UpdateCheck>;
  installUpdate(server: string, token: string): Promise<void>;
  /** Tray "Stop timer", tray "Open Beacon" and the global shortcut. */
  on(event: PlatformEvent, handler: () => void): void;
}

/** Test / development hooks of the browser fallback (set from Playwright through `window.__timeTrack`). */
export interface BrowserHooks {
  idleSeconds: number;
  opened: string[];
  notifications: string[];
  tray: { text: string; running: boolean; beacon: string | null };
  installable: boolean;
  installError: string | null;
  emit(event: PlatformEvent): void;
}

export function browserPlatform(version: string, fetchImpl: typeof fetch = (i, o) => globalThis.fetch(i, o)): Platform & { hooks: BrowserHooks } {
  let secret: string | null = null;
  let autostart = false;
  const handlers: Record<string, (() => void)[]> = {};
  const hooks: BrowserHooks = {
    idleSeconds: 0,
    opened: [],
    notifications: [],
    tray: { text: '', running: false, beacon: null },
    installable: true,
    installError: null,
    emit: (event) => (handlers[event] ?? []).forEach((handler) => handler()),
  };
  return {
    kind: 'browser',
    hooks,
    fetch: fetchImpl,
    appVersion: async () => version,
    hostName: async () => 'Browser',
    secretGet: async () => secret,
    secretSet: async (token) => void (secret = token),
    secretDelete: async () => void (secret = null),
    idleSeconds: async () => hooks.idleSeconds,
    openUrl: async (url) => void hooks.opened.push(url),
    setTray: async (text, running, beacon) => void (hooks.tray = { text, running, beacon }),
    notify: async (title, body) => void hooks.notifications.push(`${title}: ${body}`),
    autostartEnabled: async () => autostart,
    setAutostart: async (enabled) => void (autostart = enabled),
    checkUpdate: async (server, token) => {
      const response = await fetchImpl(`${server}/api/time-track/updates/desktop/linux/x86_64/${version}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const headerMin = response.headers.get('X-Min-Supported-Version');
      if (response.status === 204) return { status: 'up_to_date', min_supported_version: headerMin };
      if (response.status === 401) return { status: 'unauthorized' };
      if (response.status !== 200) return { status: 'error', message: `HTTP ${response.status}` };
      const body = (await response.json()) as { version: string; notes?: string; min_supported_version?: string };
      return { status: 'available', installable: hooks.installable, ...body, min_supported_version: body.min_supported_version ?? headerMin };
    },
    installUpdate: async () => {
      if (hooks.installError !== null) throw new Error(hooks.installError);
    },
    on: (event, handler) => void (handlers[event] ??= []).push(handler),
  };
}
