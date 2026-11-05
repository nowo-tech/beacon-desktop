import type { PromptAnswer, PromptView } from './ui/prompt';

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
      /** False when this copy cannot install it itself (no updater public key, MSI / deb install): never block. */
      installable?: boolean;
    }
  /** Microsoft Store build: the Store updates the app. */
  | { status: 'disabled' }
  | { status: 'error'; message: string };

/** Download progress of an update (`update-progress` events of the Rust `install_update` command). */
export type UpdateProgress = { phase: 'downloading'; downloaded: number; total: number | null } | { phase: 'installing' };

/** Tray tooltip and title (title: macOS menu bar / Linux AppIndicator label; `null` hides it). */
export interface TrayStatus {
  title: string | null;
  tooltip: string;
  /** Status line at the top of the tray menu (disabled item). */
  status: string;
  running: boolean;
}

export interface TrayMenuItem {
  id: string;
  label: string;
}

/**
 * Tray menu, translated by the UI. Each item emits `tray-action` with its id: `stop`, `resume`, `switch:<taskId>`,
 * `search`, `open`, `open-beacon`, `my-time`, `settings` (`quit` is handled natively).
 */
export interface TrayMenu {
  /** Stop timer / Resume "{last}" (absent when there is nothing to stop or resume). */
  primary: TrayMenuItem | null;
  /** "Switch to ▸" submenu label and its tasks (pinned + recent, at most 7; absent when empty). */
  switchLabel: string;
  switchTo: TrayMenuItem[];
  search: string;
  open: string;
  /** Present only while connected to an https server (see lib/beacon.ts). */
  openBeacon: string | null;
  myTime: string | null;
  /** "Check for updates…" (absent in the Microsoft Store build). */
  checkUpdates: string | null;
  /** "Pause friendly messages for 1 h" (`pause-friendly`) / "Paused until … — resume" (`resume-friendly`); absent with both switches off. */
  pauseFriendly: TrayMenuItem | null;
  settings: string;
  quit: string;
}

/** Why the host woke the UI (Tauri: the Rust heartbeat, see src-tauri/src/heartbeat.rs; browser: a 30 s interval). */
export type WakeReason = 'tick' | 'deadline' | 'idle' | 'resumed';

/** What the UI wants to be woken for besides the 30 s tick (Unix ms / seconds). */
export interface WakePlan {
  deadlineAt: number | null;
  idleAfterSeconds: number | null;
}

/** A friendly message as a native notification: short localized title, the line, the mascot pose id. */
export interface FriendlyNotification {
  title: string;
  body: string;
  pose: string | null;
}

/** `unsupported`: the host has no desktop notifications (plain browser). */
export type NotificationPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** The "Still there?" window, as seen from the main window. */
export interface PromptHost {
  /** Opens it centred on the active monitor, always on top (or updates the open one). Rejects when it cannot. */
  open(view: PromptView): Promise<void>;
  /** Brings it forward again. */
  focus(): Promise<void>;
  close(): Promise<void>;
  onAnswer(handler: (answer: PromptAnswer) => void): void;
}

/** The prompt window's side: its content and where its answers go. */
export interface PromptClient {
  view(): Promise<PromptView | null>;
  onView(handler: (view: PromptView) => void): void;
  answer(answer: PromptAnswer): Promise<void>;
}

/** Default global shortcut. `Ctrl+Alt+T` opens a terminal on Ubuntu / GNOME, so the default adds Shift. */
export const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Shift+T';

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
  copyText(text: string): Promise<void>;
  setTray(status: TrayStatus): Promise<void>;
  setTrayMenu(menu: TrayMenu): Promise<void>;
  /** Registers the global shortcut (replacing the previous one). Rejects when the OS refuses it (in use, invalid). */
  setShortcut(accelerator: string): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  /** A friendly message as a native notification (pose picture, click brings the window forward). False when it could not be shown. */
  notifyFriendly(note: FriendlyNotification): Promise<boolean>;
  notificationPermission(): Promise<NotificationPermission>;
  requestNotificationPermission(): Promise<NotificationPermission>;
  /** Wake-ups of the regular check, on time even while the window is hidden. */
  onWake(handler: (reason: WakeReason) => void): void;
  setWakePlan(plan: WakePlan): Promise<void>;
  /** The "Still there?" window; `null` when the host has none (the prompt is then a modal in the main window). */
  readonly promptWindow: PromptHost | null;
  /** Native window theme (title bar, menus): `null` follows the system. */
  setWindowTheme(theme: 'light' | 'dark' | null): Promise<void>;
  autostartEnabled(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
  checkUpdate(server: string, token: string): Promise<UpdateCheck>;
  /**
   * Downloads, verifies the signature, installs and relaunches (the promise only settles on failure in the real app,
   * which restarts). `onProgress` receives the download progress, then `installing`.
   */
  installUpdate(server: string, token: string, onProgress?: (progress: UpdateProgress) => void): Promise<void>;
  /** The global shortcut was pressed (the window is already shown). */
  onShortcut(handler: () => void): void;
  /** A tray menu item was chosen (see `TrayMenu`). */
  onTray(handler: (action: string) => void): void;
}

/** Test / development hooks of the browser fallback (set from Playwright through `window.__timeTrack`). */
export interface BrowserHooks {
  idleSeconds: number;
  opened: string[];
  copied: string[];
  notifications: string[];
  tray: TrayStatus;
  trayMenu: TrayMenu | null;
  shortcut: string | null;
  /** Accelerators the fake OS refuses. */
  refusedShortcuts: string[];
  installable: boolean;
  installError: string | null;
  /** Progress events the fake updater sends before it "installs". */
  installSteps: UpdateProgress[];
  /** Pause between fake progress events (ms), so e2e can see the progress bar. */
  installStepMs: number;
  /** Number of successful fake installs (the real app relaunches instead). */
  installed: number;
  /** Last native window theme asked for (`null` = follow the system; `undefined` = never set). */
  windowTheme: 'light' | 'dark' | null | undefined;
  /** Fake OS notification permission (`unsupported` by default: friendly messages stay in the app). */
  notificationPermission: NotificationPermission;
  /** What the fake OS answers when asked for the permission. */
  permissionAnswer: NotificationPermission;
  /** Native friendly notifications shown. */
  friendly: FriendlyNotification[];
  /** The fake notification service refuses to show them. */
  friendlyFails: boolean;
  /** Last wake plan the UI asked for. */
  wakePlan: WakePlan | null;
  /** A fake "Still there?" window (off by default: the in-app modal). */
  nativePrompt: boolean;
  /** Content of the fake prompt window (`null` = closed); how often it was opened and focused. */
  prompt: PromptView | null;
  promptOpened: number;
  promptFocused: number;
  /** The fake prompt window cannot be opened. */
  promptFails: boolean;
  shortcutPressed(): void;
  trayAction(action: string): void;
  /** The fake heartbeat fires. */
  wake(reason?: WakeReason): void;
  /** An answer from the fake prompt window. */
  answerPrompt(answer: PromptAnswer): void;
}

export function browserPlatform(version: string, fetchImpl: typeof fetch = (i, o) => globalThis.fetch(i, o)): Platform & { hooks: BrowserHooks } {
  let secret: string | null = null;
  let autostart = false;
  const shortcutHandlers: (() => void)[] = [];
  const trayHandlers: ((action: string) => void)[] = [];
  const wakeHandlers: ((reason: WakeReason) => void)[] = [];
  const answerHandlers: ((answer: PromptAnswer) => void)[] = [];
  const hooks: BrowserHooks = {
    idleSeconds: 0,
    opened: [],
    copied: [],
    notifications: [],
    tray: { title: null, tooltip: '', status: '', running: false },
    trayMenu: null,
    shortcut: null,
    refusedShortcuts: [],
    installable: true,
    installError: null,
    installSteps: [
      { phase: 'downloading', downloaded: 0, total: 1000 },
      { phase: 'downloading', downloaded: 500, total: 1000 },
      { phase: 'downloading', downloaded: 1000, total: 1000 },
      { phase: 'installing' },
    ],
    installStepMs: 0,
    installed: 0,
    windowTheme: undefined,
    notificationPermission: 'unsupported',
    permissionAnswer: 'granted',
    friendly: [],
    friendlyFails: false,
    wakePlan: null,
    nativePrompt: false,
    prompt: null,
    promptOpened: 0,
    promptFocused: 0,
    promptFails: false,
    shortcutPressed: () => shortcutHandlers.forEach((handler) => handler()),
    trayAction: (action) => trayHandlers.forEach((handler) => handler(action)),
    wake: (reason = 'tick') => wakeHandlers.forEach((handler) => handler(reason)),
    answerPrompt: (answer) => answerHandlers.forEach((handler) => handler(answer)),
  };
  const promptHost: PromptHost = {
    open: async (view) => {
      if (hooks.promptFails) throw new Error('no prompt window');
      if (hooks.prompt === null) hooks.promptOpened += 1;
      hooks.prompt = view;
    },
    focus: async () => void (hooks.promptFocused += 1),
    close: async () => void (hooks.prompt = null),
    onAnswer: (handler) => void answerHandlers.push(handler),
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
    copyText: async (text) => void hooks.copied.push(text),
    setTray: async (status) => void (hooks.tray = status),
    setTrayMenu: async (menu) => void (hooks.trayMenu = menu),
    setShortcut: async (accelerator) => {
      if (hooks.refusedShortcuts.includes(accelerator)) throw new Error(`${accelerator} is already registered`);
      hooks.shortcut = accelerator;
    },
    notify: async (title, body) => void hooks.notifications.push(`${title}: ${body}`),
    notifyFriendly: async (note) => {
      if (hooks.friendlyFails || hooks.notificationPermission !== 'granted') return false;
      hooks.friendly.push(note);
      return true;
    },
    notificationPermission: async () => hooks.notificationPermission,
    requestNotificationPermission: async () => {
      if (hooks.notificationPermission === 'prompt') hooks.notificationPermission = hooks.permissionAnswer;
      return hooks.notificationPermission;
    },
    onWake: (handler) => void wakeHandlers.push(handler),
    setWakePlan: async (plan) => void (hooks.wakePlan = plan),
    get promptWindow() {
      return hooks.nativePrompt ? promptHost : null;
    },
    setWindowTheme: async (theme) => void (hooks.windowTheme = theme),
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
    installUpdate: async (_server, _token, onProgress) => {
      for (const step of hooks.installSteps) {
        if (hooks.installError !== null && step.phase === 'installing') break;
        onProgress?.(step);
        if (hooks.installStepMs > 0) await new Promise((resolve) => setTimeout(resolve, hooks.installStepMs));
      }
      if (hooks.installError !== null) throw new Error(hooks.installError);
      hooks.installed += 1;
    },
    onShortcut: (handler) => void shortcutHandlers.push(handler),
    onTray: (handler) => void trayHandlers.push(handler),
  };
}

/** Test / development hooks of the fake prompt window (`window.__timeTrackPrompt`, set from Playwright). */
export interface BrowserPromptHooks {
  view: PromptView | null;
  answers: PromptAnswer[];
  /** Replaces the content (as the main window's updates do). */
  setView?(view: PromptView): void;
}

/** The prompt window's side in a plain browser (`?window=prompt`): content and answers through `hooks`. */
export function browserPromptClient(hooks: BrowserPromptHooks): PromptClient {
  const handlers: ((view: PromptView) => void)[] = [];
  hooks.setView = (view) => {
    hooks.view = view;
    handlers.forEach((handler) => handler(view));
  };
  return {
    view: async () => hooks.view,
    onView: (handler) => void handlers.push(handler),
    answer: async (answer) => void hooks.answers.push(answer),
  };
}
