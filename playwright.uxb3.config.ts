import { defineConfig } from '@playwright/test';

const MOCK_PORT = process.env.UXB3_MOCK_PORT ?? '8803';
const UI_PORT = process.env.UXB3_UI_PORT ?? '1436';
process.env.UXB3_MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** UX batches 2 + 3 screens (`UXB3_SHOTS=<dir> pnpm exec playwright test -c playwright.uxb3.config.ts`): mock API + vite preview. */
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: 'ux-b3.spec.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'Europe/Madrid',
    // Past the guided first run (UX batch 6): these screens connect chat and tasks themselves.
    storageState: { cookies: [], origins: [{ origin: `http://127.0.0.1:${UI_PORT}`, localStorage: [{ name: 'beacon-desktop-shell', value: '{"setup":"done","module":"time"}' }] }] },
  },
  webServer: [
    { command: 'node mock-server/server.mjs', url: `http://127.0.0.1:${MOCK_PORT}/__mock/state`, env: { PORT: MOCK_PORT }, reuseExistingServer: process.env.UXB3_REUSE === '1' },
    { command: `BEACON_SERVER_FIELD=1 ./node_modules/.bin/vite build --outDir out/uxb3-ui --emptyOutDir && ./node_modules/.bin/vite preview --outDir out/uxb3-ui --port ${UI_PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${UI_PORT}`, reuseExistingServer: process.env.UXB3_REUSE === '1', timeout: 120_000 },
  ],
});
