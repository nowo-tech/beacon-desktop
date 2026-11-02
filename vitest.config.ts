import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __BEACON_URL__: JSON.stringify(''), __VERSION__: JSON.stringify('0.1.0') },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
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
