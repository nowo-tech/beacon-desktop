import { sameOriginHttps } from './beacon';
import { safeVerificationUri } from './urls';

/**
 * "Open Beacon in" (Settings, this computer only): the system default browser, one of the browsers detected on this
 * computer, or one picked by hand. Every link the app opens goes through `App.openExternal` with this choice.
 */
export type BrowserChoice =
  | { kind: 'system' }
  | { kind: 'detected'; id: string; name: string }
  | { kind: 'custom'; path: string; name: string };

/** An installed browser as reported by the host (`list_browsers`). */
export interface DetectedBrowser {
  id: string;
  name: string;
}

/** `fallback`: the chosen browser is gone (or did not start) and the system default opened the link instead. */
export type OpenOutcome = 'opened' | 'fallback';

export const SYSTEM_BROWSER: BrowserChoice = { kind: 'system' };

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : null);

/** The stored choice, or the system default when it is missing or malformed. */
export function sanitizeBrowser(raw: unknown): BrowserChoice {
  if (typeof raw !== 'object' || raw === null) return SYSTEM_BROWSER;
  const value = raw as Record<string, unknown>;
  const name = text(value.name, 200);
  if (value.kind === 'detected') {
    const id = text(value.id, 500);
    if (id !== null && name !== null) return { kind: 'detected', id, name };
  }
  if (value.kind === 'custom') {
    const path = text(value.path, 4096);
    if (path !== null && name !== null) return { kind: 'custom', path, name };
  }
  return SYSTEM_BROWSER;
}

/**
 * Which links a caller may open:
 * - `beacon`: a page of the connected Beacon (https, same origin, no credentials; http only for a Beacon on this
 *   computer);
 * - `device`: the sign-in verification page (https, or http to a Beacon on this computer; same host as the server);
 * - `help`: any https page (no credentials), e.g. the Store listing.
 */
export type LinkRule = { kind: 'beacon'; server: string | null | undefined } | { kind: 'device'; server: string } | { kind: 'help' };

export function externalUrl(url: string | null | undefined, rule: LinkRule): string | null {
  if (typeof url !== 'string' || url === '') return null;
  if (rule.kind === 'beacon') return sameOriginHttps(url, rule.server) ?? loopbackSameOrigin(url, rule.server);
  if (rule.kind === 'device') return safeVerificationUri(url, rule.server);
  try {
    const target = new URL(url);
    return target.protocol === 'https:' && target.hostname !== '' && target.username === '' && target.password === '' ? target.href : null;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A development Beacon on this computer (`http://localhost:8000`): its own pages only. */
function loopbackSameOrigin(url: string, server: string | null | undefined): string | null {
  try {
    const target = new URL(url);
    const base = new URL(server ?? '');
    const local = base.protocol === 'http:' && LOOPBACK.has(base.hostname) && target.protocol === 'http:';
    return local && target.origin === base.origin && target.username === '' && target.password === '' ? target.href : null;
  } catch {
    return null;
  }
}

/** Query parameters that may carry a secret; they never leave the app in a copied link. */
const SECRET_PARAMS = /^(access_?token|refresh_?token|id_?token|token|auth|authorization|api_?key|apikey|key|secret|client_secret|password|passwd|pwd|pass|sig|signature|session|session_?id|sid|jwt|bearer|code|otp)$/i;

/**
 * The link as copied to the clipboard: the same checks as opening it, then without user info, without query
 * parameters that may carry a secret (`token`, `key`, `signature` …, but not the sign-in `user_code` the person types
 * anyway) and without a fragment that looks like parameters (`#access_token=…`).
 */
export function copyableUrl(url: string | null | undefined, rule: LinkRule): string | null {
  const safe = externalUrl(url, rule);
  if (safe === null) return null;
  const target = new URL(safe);
  target.username = '';
  target.password = '';
  for (const name of [...target.searchParams.keys()]) if (SECRET_PARAMS.test(name)) target.searchParams.delete(name);
  if (target.hash.includes('=')) target.hash = '';
  return target.href;
}
