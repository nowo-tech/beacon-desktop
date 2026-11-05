import { browserPlatform, browserPromptClient, type BrowserPromptHooks, type Platform } from './platform';
import { tauriPlatform, tauriPromptClient } from './platform-tauri';
import { DesktopApp } from './ui/app';
import { startPromptWindow } from './ui/promptWindow';
import './styles.css';

const isTauri = '__TAURI_INTERNALS__' in window;
const root = document.getElementById('app');

if (root !== null && new URLSearchParams(location.search).get('window') === 'prompt') {
  // The "Still there?" window (src-tauri/src/prompt.rs): it only draws what the main window sends.
  const scope = window as unknown as { __timeTrackPrompt?: BrowserPromptHooks };
  scope.__timeTrackPrompt ??= { view: null, answers: [] };
  void startPromptWindow(root, isTauri ? tauriPromptClient() : browserPromptClient(scope.__timeTrackPrompt));
} else if (root !== null) {
  const platform: Platform = isTauri ? tauriPlatform() : browserPlatform(__VERSION__);
  const app = new DesktopApp(root, platform, {
    beaconUrl: __BEACON_URL__,
    channel: __CHANNEL__,
    ...(__STORE_URL__ !== '' ? { storeUrl: __STORE_URL__ } : {}),
  });
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
    (window as unknown as { __timeTrack: unknown }).__timeTrack = { app, hooks: (platform as ReturnType<typeof browserPlatform>).hooks };
  }
}
