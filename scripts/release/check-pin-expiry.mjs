/**
 * Pin set expiry tripwire (docs/PINNING.md, audit FY-L2). Fails when `src-tauri/pins.json` expires in fewer than
 * `--min-days` days (default 90, the same threshold as the Rust test
 * `shipped_pin_set_is_valid_and_covers_the_production_host`), or when the file is not a usable pin set.
 *
 * Runs weekly and on demand (.github/workflows/pins.yml, 90 days) and as a gate before every release build
 * (.github/workflows/release.yml, 180 days: a shipped build should keep its pinning for most of its life).
 *
 * CLI: node scripts/release/check-pin-expiry.mjs [--min-days N] [path/to/pins.json]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MIN_DAYS = 90;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → milliseconds at 00:00 UTC, or NaN. */
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.NaN;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return new Date(ms).toISOString().startsWith(value) ? ms : Number.NaN;
}

/**
 * @param {{pins: unknown, now: Date, minDays?: number}} input
 * @returns {{ok: boolean, daysLeft: number | null, message: string}}
 */
export function checkPinExpiry({ pins, now, minDays = DEFAULT_MIN_DAYS }) {
  const file = /** @type {{version?: unknown, expires?: unknown, hosts?: unknown, pins?: unknown}} */ (pins ?? {});
  if (!Number.isInteger(file.version) || !Array.isArray(file.hosts) || file.hosts.length === 0 || !Array.isArray(file.pins) || file.pins.length === 0) {
    return { ok: false, daysLeft: null, message: 'pins.json is not a pin set (version, hosts and pins are required)' };
  }
  const expires = parseDate(file.expires);
  if (Number.isNaN(expires)) {
    return { ok: false, daysLeft: null, message: `pins.json: invalid expiry ${JSON.stringify(file.expires)}` };
  }
  const daysLeft = Math.floor((expires - now.getTime()) / DAY_MS);
  const what = `pin set v${file.version} expires on ${file.expires} (${daysLeft} days left, minimum ${minDays})`;
  return daysLeft >= minDays
    ? { ok: true, daysLeft, message: what }
    : { ok: false, daysLeft, message: `${what}: rotate it (docs/PINNING.md)` };
}

/** `--min-days N` and an optional path. */
export function parseArgs(args) {
  let minDays = DEFAULT_MIN_DAYS;
  let path = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--min-days') {
      minDays = Number(args[(i += 1)]);
      if (!Number.isInteger(minDays) || minDays < 0) throw new Error('--min-days needs a whole number of days');
    } else {
      path = args[i];
    }
  }
  return { minDays, path };
}

/* c8 ignore start */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { minDays, path } = parseArgs(process.argv.slice(2));
  const file = path ?? new URL('../../src-tauri/pins.json', import.meta.url);
  const result = checkPinExpiry({ pins: JSON.parse(readFileSync(file, 'utf8')), now: new Date(), minDays });
  (result.ok ? console.log : console.error)(`${result.ok ? 'pin set:' : 'pin set ERROR:'} ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}
/* c8 ignore stop */
