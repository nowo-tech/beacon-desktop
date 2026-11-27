import { defineConfig } from '@playwright/test';

const MOCK_PORT = process.env.CHAT_MOCK_PORT ?? '8797';
const UI_PORT = process.env.CHAT_UI_PORT ?? '1430';
process.env.CHAT_MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** Chat screens only (`CHAT_SHOTS=<dir> pnpm exec playwright test -c playwright.chat.config.ts`): mock API + vite preview. */
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: 'chat.spec.ts',
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${UI_PORT}`, viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'Europe/Madrid' },
  webServer: [
    { command: 'node mock-server/server.mjs', url: `http://127.0.0.1:${MOCK_PORT}/__mock/state`, env: { PORT: MOCK_PORT }, reuseExistingServer: process.env.CHAT_REUSE === '1' },
    { command: `BEACON_SERVER_FIELD=1 ./node_modules/.bin/vite build --outDir out/chat-ui --emptyOutDir && ./node_modules/.bin/vite preview --outDir out/chat-ui --port ${UI_PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${UI_PORT}`, reuseExistingServer: process.env.CHAT_REUSE === '1', timeout: 120_000 },
  ],
});
