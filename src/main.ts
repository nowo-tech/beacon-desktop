import { browserMiniClient, browserPlatform, hostOs, browserPromptClient, type BrowserMiniHooks, type BrowserPromptHooks, type Platform } from './platform';
import { tauriMiniClient, tauriPlatform, tauriPromptClient } from './platform-tauri';
import { startMiniWindow } from './ui/miniWindow';
import { DesktopApp } from './ui/app';
import { Shell } from './shell/shell';
import { detectLocale } from './lib/i18n';
import { startPromptWindow } from './ui/promptWindow';
import './styles.css';
// After styles.css: the shell's rules win over the Time module's element defaults.
import './chat/chat.css';
import './tasks/tasks.css';
// UX batch 6: the Time module in the shell's grammar, the one Settings and the guided first run.
import './shell/shell.css';
// UX batch 4: the status strip and the toast region with Undo.
import './ui/feedback.css';

const isTauri = '__TAURI_INTERNALS__' in window;
const root = document.getElementById('app');

if (root !== null && new URLSearchParams(location.search).get('window') === 'prompt') {
  // The "Still there?" window (src-tauri/src/prompt.rs): it only draws what the main window sends.
  const scope = window as unknown as { __timeTrackPrompt?: BrowserPromptHooks };
  scope.__timeTrackPrompt ??= { view: null, answers: [] };
  void startPromptWindow(root, isTauri ? tauriPromptClient() : browserPromptClient(scope.__timeTrackPrompt));
} else if (root !== null && new URLSearchParams(location.search).get('window') === 'mini') {
  // The mini timer (src-tauri/src/mini.rs): it only draws what the main window sends and reports its buttons.
  const scope = window as unknown as { __timeTrackMini?: BrowserMiniHooks };
  scope.__timeTrackMini ??= { view: null, actions: [] };
  void startMiniWindow(root, isTauri ? tauriMiniClient() : browserMiniClient(scope.__timeTrackMini));
} else if (root !== null) {
  const platform: Platform = isTauri ? tauriPlatform() : browserPlatform(__VERSION__);
  // The shell (BD-2): rail, title bar, Chat and Time modules; the time tracker lives in the Time module.
  // The time tracker keeps `#app` (styles.css); the shell takes the page.
  root.id = 'shell-mount';
  document.documentElement.dataset.os = hostOs();
  const shell = new Shell(root, platform, { locale: detectLocale(globalThis.navigator?.language), storage: localStorage });
  const app = new DesktopApp(shell.timeRoot, platform, {
    onRender: () => shell.onAppRender(),
    beforeSignOut: () => shell.revokeOnServer(),
    trayChat: () => shell.trayChat(),
    trayTasks: () => shell.trayTasks(),
    // UX batch 7: the update offer is a pill in the shell's title bar.
    updateInShell: true,
    showUpdate: () => shell.openUpdate(),
    askAllocation: (request) => shell.askAllocation(request),
    onContextRefused: (context) => void shell.timeContextRefused(context),
    contextLabel: () => shell.contextLabel(),
    contextLabelOf: (context) => shell.contextLabelOf(context),
    beaconUrl: __BEACON_URL__,
    // Release builds: always https://beacon.nowo.tech, no address field (owner decision 2026-11-27).
    ...(__SERVER_FIELD__ ? {} : { fixedServer: __BEACON_URL__ }),
    channel: __CHANNEL__,
    ...(__STORE_URL__ !== '' ? { storeUrl: __STORE_URL__ } : {}),
  });
  shell.attach(app);
  // A session restored at launch follows the landing rule (owner Q1); a first sign-in in this run opens the guided setup.
  shell.freshSignIn = app.state.session === null;
  void app.init();
  // The regular check: in the Tauri app the Rust heartbeat wakes it, on time while the window is hidden
  // (platform.onWake, src-tauri/src/heartbeat.rs); in a plain browser a 30 s interval does.
  if (!isTauri) setInterval(() => (platform as ReturnType<typeof browserPlatform>).hooks.wake('tick'), 30_000);
  setInterval(() => void (app.state.session !== null && app.refresh()), 5 * 60_000);
  // Startup check runs in init(); then every 6 hours (Store build: only GET me's minimum, the Store updates the app).
  setInterval(() => void app.checkUpdates(), 6 * 3600_000);
  window.addEventListener('online', () => void (app.state.session !== null && app.refresh()));
  if (!isTauri) {
    // Development / e2e only (plain browser): expose the app and the fake platform hooks.
    (window as unknown as { __timeTrack: unknown }).__timeTrack = { app, shell, hooks: (platform as ReturnType<typeof browserPlatform>).hooks };
  }
}
