import { defineConfig } from '@playwright/test';

const MOCK_PORT = process.env.UXB4_MOCK_PORT ?? '8804';
const UI_PORT = process.env.UXB4_UI_PORT ?? '1437';
process.env.UXB4_MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** UX batch 4 screens (`UXB4_SHOTS=<dir> pnpm exec playwright test -c playwright.uxb4.config.ts`): mock API + vite preview. */
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: 'ux-b4.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${UI_PORT}`, viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'Europe/Madrid' },
  webServer: [
    { command: 'node mock-server/server.mjs', url: `http://127.0.0.1:${MOCK_PORT}/__mock/state`, env: { PORT: MOCK_PORT }, reuseExistingServer: process.env.UXB4_REUSE === '1' },
    { command: `BEACON_SERVER_FIELD=1 ./node_modules/.bin/vite build --outDir out/uxb4-ui --emptyOutDir && ./node_modules/.bin/vite preview --outDir out/uxb4-ui --port ${UI_PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${UI_PORT}`, reuseExistingServer: process.env.UXB4_REUSE === '1', timeout: 120_000 },
  ],
});
