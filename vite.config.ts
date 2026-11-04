import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// `TIMETRACK_CHANNEL=store`: Microsoft Store build (no in-app updater); the Rust side reads the same variable.
const channel = process.env.TIMETRACK_CHANNEL === 'store' ? 'store' : 'direct';
const storeUrl = process.env.TIMETRACK_STORE_URL ?? '';
if (storeUrl !== '' && !/^https:\/\/apps\.microsoft\.com\/detail\/[A-Za-z0-9]+$/.test(storeUrl)) {
  throw new Error(`TIMETRACK_STORE_URL must be https://apps.microsoft.com/detail/<product id>, not ${storeUrl}`);
}

export default defineConfig({
  clearScreen: false,
  define: {
    __BEACON_URL__: JSON.stringify((process.env.BEACON_URL ?? '').replace(/\/+$/, '')),
    __VERSION__: JSON.stringify(version),
    __CHANNEL__: JSON.stringify(channel),
    __STORE_URL__: JSON.stringify(storeUrl),
  },
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: false },
});
