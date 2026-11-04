/**
 * Release gate for the updater public key (docs/RELEASE-PLAN-0.4.0.md, "Updater key").
 *
 * Runs before every `tauri build` (tauri.conf.json `beforeBuildCommand`) and in the release workflow. A direct-download
 * release build fails while tauri.conf.json still carries the committed placeholder and no `TAURI_UPDATER_PUBKEY` is
 * set, or when the key is not a minisign public key from `tauri signer generate`. Only the PUBLIC key is ever read
 * here; the private key stays with the owner and in the build secrets.
 *
 * Passes without a key for: the Microsoft Store channel (`TIMETRACK_CHANNEL=store`: the Store updates the app), debug
 * builds (`TAURI_ENV_DEBUG=true`) and explicit unsigned test builds (`TIMETRACK_ALLOW_UNSIGNED=1`, `pnpm
 * tauri:build:unsigned`), with a warning.
 *
 * CLI: node scripts/release/check-updater-key.mjs [path/to/tauri.conf.json]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Keep in sync with `PUBKEY_PLACEHOLDER` in src-tauri/src/lib.rs. */
export const PLACEHOLDER = 'REPLACE_WITH_TIMETRACK_UPDATER_PUBLIC_KEY';
export const CHANNELS = ['direct', 'store'];

/**
 * Decodes a Tauri updater public key (base64 of the minisign `.pub` file: an "untrusted comment" line, then the key
 * line starting with "RW"). Returns the key id from the comment, or throws.
 */
export function describePubkey(key) {
  const value = (key ?? '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('the updater public key is not base64 (paste the whole content of ~/.tauri/timetrack.key.pub)');
  }
  const text = Buffer.from(value, 'base64').toString('utf8');
  const [comment = '', line = ''] = text.split(/\r?\n/);
  const id = /^untrusted comment: minisign public key:?\s*([0-9A-F]+)?/i.exec(comment);
  if (id === null || !/^RW[A-Za-z0-9+/]{40,}={0,2}$/.test(line.trim())) {
    throw new Error('the updater public key is not a minisign public key from `tauri signer generate`');
  }
  return id[1] ?? 'unknown';
}

/**
 * @param {{config: {plugins?: {updater?: {pubkey?: string} | null}}, env: Record<string, string | undefined>}} input
 * @returns {{ok: boolean, level: 'ok' | 'warn' | 'error', message: string}}
 */
export function checkUpdaterKey({ config, env }) {
  const channel = (env.TIMETRACK_CHANNEL ?? '').trim() || 'direct';
  if (!CHANNELS.includes(channel)) {
    return { ok: false, level: 'error', message: `TIMETRACK_CHANNEL must be ${CHANNELS.join(' or ')}, not "${channel}"` };
  }
  if (channel === 'store') {
    return { ok: true, level: 'ok', message: 'Microsoft Store channel: no in-app updater, no updater key needed' };
  }
  const fromEnv = (env.TAURI_UPDATER_PUBKEY ?? '').trim();
  const fromConfig = (config.plugins?.updater?.pubkey ?? '').trim();
  const key = fromEnv !== '' ? fromEnv : fromConfig;
  const source = fromEnv !== '' ? 'TAURI_UPDATER_PUBKEY' : 'tauri.conf.json plugins.updater.pubkey';
  if (key === '' || key === PLACEHOLDER) {
    const unsignedOk = env.TAURI_ENV_DEBUG === 'true' || env.TIMETRACK_ALLOW_UNSIGNED === '1';
    const message =
      'no updater public key: tauri.conf.json still has the placeholder and TAURI_UPDATER_PUBKEY is not set. ' +
      'Put the content of ~/.tauri/timetrack.key.pub in plugins.updater.pubkey (docs/RELEASE-PLAN-0.4.0.md, owner step 1).';
    return unsignedOk
      ? { ok: true, level: 'warn', message: `${message} Allowed for this debug / unsigned build: it cannot install updates.` }
      : { ok: false, level: 'error', message };
  }
  try {
    const id = describePubkey(key);
    return { ok: true, level: 'ok', message: `updater public key ${id} (from ${source})` };
  } catch (error) {
    return { ok: false, level: 'error', message: `${source}: ${error.message}` };
  }
}

/* c8 ignore start */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2] ?? new URL('../../src-tauri/tauri.conf.json', import.meta.url);
  const result = checkUpdaterKey({ config: JSON.parse(readFileSync(path, 'utf8')), env: process.env });
  const prefix = { ok: 'updater key:', warn: 'updater key WARNING:', error: 'updater key ERROR:' }[result.level];
  (result.ok ? console.log : console.error)(`${prefix} ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}
/* c8 ignore stop */
