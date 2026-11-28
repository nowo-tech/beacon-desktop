import { defineConfig } from '@playwright/test';

const MOCK_PORT = process.env.P0141_MOCK_PORT ?? '8814';
const UI_PORT = process.env.P0141_UI_PORT ?? '1447';
process.env.P0141_MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** 0.14.1 polish screens (`P0141_SHOTS=<dir> pnpm exec playwright test -c playwright.p0141.config.ts`): mock API + vite preview. */
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: 'polish-0141.spec.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${UI_PORT}`, viewport: { width: 900, height: 600 }, locale: 'en-US', timezoneId: 'Europe/Madrid',
    // Past the guided first run (UX batch 6): these screens start from the sign-in.
    storageState: { cookies: [], origins: [{ origin: `http://127.0.0.1:${UI_PORT}`, localStorage: [{ name: 'beacon-desktop-shell', value: '{"setup":"done","module":"time"}' }] }] },
  },
  webServer: [
    { command: 'node mock-server/server.mjs', url: `http://127.0.0.1:${MOCK_PORT}/__mock/state`, env: { PORT: MOCK_PORT }, reuseExistingServer: false },
    { command: `BEACON_SERVER_FIELD=1 ./node_modules/.bin/vite build --outDir out/p0141-ui --emptyOutDir && ./node_modules/.bin/vite preview --outDir out/p0141-ui --port ${UI_PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${UI_PORT}`, reuseExistingServer: false, timeout: 120_000 },
  ],
});
