import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 400, height: 640 }, locale: 'en-US' },
  webServer: [
    {
      command: 'node mock-server/server.mjs',
      url: 'http://127.0.0.1:8787/__mock/state',
      env: { PORT: '8787' },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: './node_modules/.bin/vite build && ./node_modules/.bin/vite preview --port 1420 --strictPort --host 127.0.0.1',
      url: 'http://127.0.0.1:1420',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
