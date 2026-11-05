import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __BEACON_URL__: JSON.stringify(''), __VERSION__: JSON.stringify('0.1.0'), __CHANNEL__: JSON.stringify('direct'), __STORE_URL__: JSON.stringify('') },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Friendly messages and schedule reminders depend on the local time: every test gets the same zone (tests that
    // need another one pass it explicitly).
    env: { TZ: 'UTC' },
    // DOM tests run at the compact window size (as the e2e tests); layout tests resize the fake window themselves.
    environmentOptions: { happyDOM: { width: 400, height: 640 } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/**/*.mjs'],
      // Entry point and the thin Tauri bridge run only inside the Tauri webview (covered by the Rust build).
      exclude: ['src/main.ts', 'src/platform-tauri.ts', 'src/**/*.d.ts', 'scripts/icons.mjs'],
      reporter: ['text-summary', 'lcov'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
