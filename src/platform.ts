import type { Rect, Screens } from './lib/layout';
import type { BrowserChoice, DetectedBrowser, OpenOutcome } from './lib/links';
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
  /**
   * While a timer runs: the start (Unix ms) and the translated title / tooltip with `{time}` (elapsed, `H:MM`) and
   * `{today}`, which the host keeps current every minute on its own (src-tauri/src/tray_clock.rs). `null` when stopped.
   */
  clock?: TrayClock | null;
}

export interface TrayClock {
  startedAt: number;
  title: string;
  tooltip: string;
  /** Seconds tracked today without the running entry's elapsed time. */
  todayBaseSeconds: number;
}

/** Screen lock and system sleep, from the OS (src-tauri/src/session.rs). Local only. */
export type SessionEvent = 'lock' | 'unlock' | 'suspend' | 'resume';

/** Which global shortcut: `open` shows the window and the search, `resume` starts the last task again. */
export type ShortcutSlot = 'open' | 'resume';

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
  /** "Full view" (`layout-full`) / "Compact view" (`layout-compact`): the other view (absent while signed out). */
  layout?: TrayMenuItem | null;
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
export type WakeReason = 'tick' | 'deadline' | 'idle' | 'reminder' | 'resumed';

/** What the UI wants to be woken for besides the 30 s tick (Unix ms / seconds). */
export interface WakePlan {
  deadlineAt: number | null;
  idleAfterSeconds: number | null;
  /** The next working-hours reminder (lib/schedule.ts). */
  reminderAt: number | null;
}

/** A notification button: the id sent back when pressed (`schedule-start` …) and its translated label. */
export interface NotificationAction {
  id: string;
  label: string;
}

/** A friendly message as a native notification: short localized title, the line, the mascot pose id, an optional button. */
export interface FriendlyNotification {
  title: string;
  body: string;
  pose: string | null;
  action?: NotificationAction | null;
  /** Up to two buttons ("Working without a timer?"); the host drops unknown ids. */
  actions?: NotificationAction[];
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
  /** Brings the main window forward. */
  openMain(): Promise<void>;
}

/**
 * Text of a system notification. Linux notification servers that advertise `body-markup` render `<b>`, `<a>` or `<img>`
 * from the body, and a task title comes from Beacon: there it is escaped to plain text. Other systems show text as is.
 */
export function notificationBody(text: string, os: string): string {
  if (!/linux|x11|freebsd|openbsd/i.test(os)) return text;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The main window's size and position, in physical pixels (lib/layout.ts). */
export interface WindowHost {
  /** Outer position and inner size; `null` while maximised or minimised (nothing worth remembering). */
  bounds(): Promise<Rect | null>;
  screens(): Promise<Screens>;
  /** Restores a maximised window first. */
  setBounds(rect: Rect): Promise<void>;
  /** The window was moved or resized (by the person or by `setBounds`). */
  onChange(handler: () => void): void;
}

/** Default global shortcut. `Ctrl+Alt+T` opens a terminal on Ubuntu / GNOME, so the default adds Shift. */
export const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Shift+T';
/** Default "Continue the last task" shortcut (Ctrl+Alt+Space, ⌘⌥Space on macOS). */
export const DEFAULT_RESUME_SHORTCUT = 'CommandOrControl+Alt+Space';

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
  /**
   * Opens an https link (already checked by the caller) in the system default browser or the chosen one
   * (`open_external`); `fallback` when the chosen browser is gone and the default opened it. Rejects when nothing could.
   */
  openExternal(url: string, browser: BrowserChoice): Promise<OpenOutcome>;
  /** Browsers installed on this computer (Settings → Open Beacon in). */
  listBrowsers(): Promise<DetectedBrowser[]>;
  /** Settings → Open Beacon in → Custom…: the file picker, checked by the host. `null` = cancelled; rejects when refused. */
  pickBrowser(): Promise<BrowserChoice | null>;
  /** A link the webview tried to open by itself (`target=_blank`, `window.open`, a navigation): the host refused it. */
  onOpenExternal(handler: (url: string) => void): void;
  copyText(text: string): Promise<void>;
  setTray(status: TrayStatus): Promise<void>;
  setTrayMenu(menu: TrayMenu): Promise<void>;
  /** Registers a global shortcut (replacing the slot's previous one). Rejects when the OS refuses it (in use, invalid). */
  setShortcut(accelerator: string, slot?: ShortcutSlot): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  /** A friendly message as a native notification (pose picture, click brings the window forward). False when it could not be shown. */
  notifyFriendly(note: FriendlyNotification): Promise<boolean>;
  notificationPermission(): Promise<NotificationPermission>;
  requestNotificationPermission(): Promise<NotificationPermission>;
  /** Wake-ups of the regular check, on time even while the window is hidden. */
  onWake(handler: (reason: WakeReason) => void): void;
  /** A notification button was pressed (its `NotificationAction.id`). */
  onNotificationAction(handler: (id: string) => void): void;
  setWakePlan(plan: WakePlan): Promise<void>;
  /** The "Still there?" window; `null` when the host has none (the prompt is then a modal in the main window). */
  readonly promptWindow: PromptHost | null;
  /** Size and position of the main window ("Compact view" / "Full view"). */
  readonly windowHost: WindowHost;
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
  /** The "Continue the last task" shortcut was pressed (the window stays as it is, hidden or not). */
  onResumeShortcut(handler: () => void): void;
  /** The screen was locked / unlocked or the computer went to sleep / woke up. */
  onSessionEvent(handler: (event: SessionEvent) => void): void;
  /** A tray menu item was chosen (see `TrayMenu`). */
  onTray(handler: (action: string) => void): void;
}

/** Test / development hooks of the browser fallback (set from Playwright through `window.__timeTrack`). */
export interface BrowserHooks {
  idleSeconds: number;
  opened: string[];
  /** Browser choice of each opened link (same order as `opened`). */
  openedWith: BrowserChoice[];
  /** Fake installed browsers. */
  browsers: DetectedBrowser[];
  /** Ids / paths of chosen browsers that are gone (the link opens in the default: `fallback`). */
  goneBrowsers: string[];
  /** Opening any link fails (no browser at all). */
  openFails: boolean;
  /** What the fake file picker returns (`null` = cancelled) or the refusal it throws. */
  pickResult: BrowserChoice | null;
  pickError: string | null;
  /** Copying fails (no clipboard). */
  copyFails: boolean;
  /** The webview tried to open a link by itself. */
  openExternal(url: string): void;
  copied: string[];
  notifications: string[];
  tray: TrayStatus;
  trayMenu: TrayMenu | null;
  shortcut: string | null;
  /** "Continue the last task" shortcut registered. */
  resumeShortcut: string | null;
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
  /** Fake main window: its bounds (`null` = maximised), the screens and every `setBounds` asked for. */
  window: { bounds: Rect | null; screens: Screens; set: Rect[] };
  /** The fake window was moved or resized. */
  windowChanged(): void;
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
  resumeShortcutPressed(): void;
  /** The fake OS locks / unlocks the screen or sleeps / wakes. */
  sessionEvent(event: SessionEvent): void;
  trayAction(action: string): void;
  /** The fake heartbeat fires. */
  wake(reason?: WakeReason): void;
  /** The button of a fake notification is pressed. */
  notificationAction(id: string): void;
  /** An answer from the fake prompt window. */
  answerPrompt(answer: PromptAnswer): void;
}

export function browserPlatform(version: string, fetchImpl: typeof fetch = (i, o) => globalThis.fetch(i, o)): Platform & { hooks: BrowserHooks } {
  let secret: string | null = null;
  let autostart = false;
  const shortcutHandlers: (() => void)[] = [];
  const resumeHandlers: (() => void)[] = [];
  const sessionHandlers: ((event: SessionEvent) => void)[] = [];
  const trayHandlers: ((action: string) => void)[] = [];
  const wakeHandlers: ((reason: WakeReason) => void)[] = [];
  const actionHandlers: ((id: string) => void)[] = [];
  const answerHandlers: ((answer: PromptAnswer) => void)[] = [];
  const windowHandlers: (() => void)[] = [];
  const externalHandlers: ((url: string) => void)[] = [];
  const hooks: BrowserHooks = {
    idleSeconds: 0,
    opened: [],
    openedWith: [],
    browsers: [],
    goneBrowsers: [],
    openFails: false,
    pickResult: null,
    pickError: null,
    copyFails: false,
    openExternal: (url) => externalHandlers.forEach((handler) => handler(url)),
    copied: [],
    notifications: [],
    tray: { title: null, tooltip: '', status: '', running: false },
    trayMenu: null,
    shortcut: null,
    resumeShortcut: null,
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
    window: { bounds: { x: 760, y: 220, width: 400, height: 640 }, screens: { areas: [{ x: 0, y: 0, width: 1920, height: 1040 }], current: { x: 0, y: 0, width: 1920, height: 1040 }, scale: 1 }, set: [] },
    windowChanged: () => windowHandlers.forEach((handler) => handler()),
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
    resumeShortcutPressed: () => resumeHandlers.forEach((handler) => handler()),
    sessionEvent: (event) => sessionHandlers.forEach((handler) => handler(event)),
    trayAction: (action) => trayHandlers.forEach((handler) => handler(action)),
    wake: (reason = 'tick') => wakeHandlers.forEach((handler) => handler(reason)),
    notificationAction: (id) => actionHandlers.forEach((handler) => handler(id)),
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
    openExternal: async (url, browser) => {
      if (hooks.openFails) throw new Error('no browser');
      hooks.opened.push(url);
      hooks.openedWith.push(browser);
      const gone = browser.kind === 'detected' ? hooks.goneBrowsers.includes(browser.id) || !hooks.browsers.some((item) => item.id === browser.id) : browser.kind === 'custom' && hooks.goneBrowsers.includes(browser.path);
      return gone ? 'fallback' : 'opened';
    },
    listBrowsers: async () => [...hooks.browsers],
    pickBrowser: async () => {
      if (hooks.pickError !== null) throw new Error(hooks.pickError);
      return hooks.pickResult;
    },
    onOpenExternal: (handler) => void externalHandlers.push(handler),
    copyText: async (text) => {
      if (hooks.copyFails) throw new Error('no clipboard');
      hooks.copied.push(text);
    },
    setTray: async (status) => void (hooks.tray = status),
    setTrayMenu: async (menu) => void (hooks.trayMenu = menu),
    setShortcut: async (accelerator, slot = 'open') => {
      const other = slot === 'resume' ? hooks.shortcut : hooks.resumeShortcut;
      if (hooks.refusedShortcuts.includes(accelerator) || other?.toLowerCase() === accelerator.toLowerCase()) throw new Error(`${accelerator} is already registered`);
      if (slot === 'resume') hooks.resumeShortcut = accelerator;
      else hooks.shortcut = accelerator;
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
    onNotificationAction: (handler) => void actionHandlers.push(handler),
    setWakePlan: async (plan) => void (hooks.wakePlan = plan),
    get promptWindow() {
      return hooks.nativePrompt ? promptHost : null;
    },
    windowHost: {
      bounds: async () => hooks.window.bounds,
      screens: async () => hooks.window.screens,
      setBounds: async (rect) => {
        hooks.window.set.push(rect);
        hooks.window.bounds = rect;
      },
      onChange: (handler) => void windowHandlers.push(handler),
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
    onResumeShortcut: (handler) => void resumeHandlers.push(handler),
    onSessionEvent: (handler) => void sessionHandlers.push(handler),
    onTray: (handler) => void trayHandlers.push(handler),
  };
}

/** Test / development hooks of the fake prompt window (`window.__timeTrackPrompt`, set from Playwright). */
export interface BrowserPromptHooks {
  view: PromptView | null;
  answers: PromptAnswer[];
  /** Times "Open TimeTrack" was pressed. */
  openedMain?: number;
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
    openMain: async () => void (hooks.openedMain = (hooks.openedMain ?? 0) + 1),
  };
}
