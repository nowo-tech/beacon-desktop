import { defineConfig } from '@playwright/test';

/**
 * Documentation screenshots (`pnpm screenshots`): the real UI built by Vite, served by `vite preview`, with the browser
 * platform's fake Tauri APIs and the mock Beacon, exactly as in the e2e tests. Writes docs/images/*.png (400 × 640).
 * Two builds: the default (direct) channel on :1420 and the Microsoft Store channel (`TIMETRACK_CHANNEL=store`) on :1421.
 */
export default defineConfig({
  testDir: 'tests/screenshots',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { viewport: { width: 400, height: 640 }, locale: 'en-US', timezoneId: 'UTC' },
  projects: [
    { name: 'direct', testMatch: 'direct.spec.ts', use: { baseURL: 'http://127.0.0.1:1420' } },
    { name: 'store', testMatch: 'store.spec.ts', use: { baseURL: 'http://127.0.0.1:1421' } },
  ],
  webServer: [
    {
      command: 'node mock-server/server.mjs',
      url: 'http://127.0.0.1:8787/__mock/state',
      env: { PORT: '8787' },
      reuseExistingServer: false,
    },
    {
      command: './node_modules/.bin/vite build && ./node_modules/.bin/vite preview --port 1420 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:1420',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        './node_modules/.bin/vite build --outDir out/screenshots-store --emptyOutDir && ./node_modules/.bin/vite preview --outDir out/screenshots-store --port 1421 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:1421',
      env: { TIMETRACK_CHANNEL: 'store' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
