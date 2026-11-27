import { defineConfig } from '@playwright/test';

const MOCK_PORT = process.env.UXB1_MOCK_PORT ?? '8806';
const UI_PORT = process.env.UXB1_UI_PORT ?? '1439';
process.env.UXB1_MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** UX batch 1 "Tasks polish" screens (`UXB1_SHOTS=<dir> UXB1_PHASE=before|after pnpm exec playwright test -c playwright.uxb1.config.ts`). */
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: 'tasks-polish.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${UI_PORT}`, viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'Europe/Madrid',
    // Past the guided first run (UX batch 6): these screens start from the sign-in.
    storageState: { cookies: [], origins: [{ origin: `http://127.0.0.1:${UI_PORT}`, localStorage: [{ name: 'beacon-desktop-shell', value: '{"setup":"done","module":"time"}' }] }] },
  },
  webServer: [
    { command: 'node mock-server/server.mjs', url: `http://127.0.0.1:${MOCK_PORT}/__mock/state`, env: { PORT: MOCK_PORT }, reuseExistingServer: false },
    { command: `BEACON_SERVER_FIELD=1 ./node_modules/.bin/vite build --outDir out/uxb1-ui --emptyOutDir && ./node_modules/.bin/vite preview --outDir out/uxb1-ui --port ${UI_PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${UI_PORT}`, reuseExistingServer: false, timeout: 120_000 },
  ],
});
