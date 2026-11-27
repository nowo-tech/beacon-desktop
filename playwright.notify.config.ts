import { defineConfig } from '@playwright/test';

const MOCK_PORT = process.env.NOTIFY_MOCK_PORT ?? '8801';
const UI_PORT = process.env.NOTIFY_UI_PORT ?? '1434';
process.env.NOTIFY_MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** Notification screens only (`NOTIFY_SHOTS=<dir> pnpm exec playwright test -c playwright.tasks.config.ts`): mock API + vite preview. */
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: 'notify.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${UI_PORT}`, viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'Europe/Madrid' },
  webServer: [
    { command: 'node mock-server/server.mjs', url: `http://127.0.0.1:${MOCK_PORT}/__mock/state`, env: { PORT: MOCK_PORT }, reuseExistingServer: process.env.NOTIFY_REUSE === '1' },
    { command: `./node_modules/.bin/vite build --outDir out/notify-ui --emptyOutDir && ./node_modules/.bin/vite preview --outDir out/tasks-ui --port ${UI_PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${UI_PORT}`, reuseExistingServer: process.env.NOTIFY_REUSE === '1', timeout: 120_000 },
  ],
});
