import { browserPlatform, type Platform } from './platform';
import { tauriPlatform } from './platform-tauri';
import { DesktopApp } from './ui/app';
import './styles.css';

const isTauri = '__TAURI_INTERNALS__' in window;
const platform: Platform = isTauri ? tauriPlatform() : browserPlatform(__VERSION__);
const root = document.getElementById('app');

if (root !== null) {
  const app = new DesktopApp(root, platform, {
    beaconUrl: __BEACON_URL__,
    channel: __CHANNEL__,
    ...(__STORE_URL__ !== '' ? { storeUrl: __STORE_URL__ } : {}),
  });
  void app.init();
  setInterval(() => void app.tick(), 30_000);
  setInterval(() => void (app.state.session !== null && app.refresh()), 5 * 60_000);
  // Startup check runs in init(); then every 6 hours (Store build: only GET me's minimum, the Store updates the app).
  setInterval(() => void app.checkUpdates(), 6 * 3600_000);
  window.addEventListener('online', () => void (app.state.session !== null && app.refresh()));
  if (!isTauri) {
    // Development / e2e only (plain browser): expose the app and the fake platform hooks.
    (window as unknown as { __timeTrack: unknown }).__timeTrack = { app, hooks: (platform as ReturnType<typeof browserPlatform>).hooks };
  }
}
