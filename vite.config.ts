import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  clearScreen: false,
  define: {
    __BEACON_URL__: JSON.stringify((process.env.BEACON_URL ?? '').replace(/\/+$/, '')),
    __VERSION__: JSON.stringify(version),
  },
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: false },
});
