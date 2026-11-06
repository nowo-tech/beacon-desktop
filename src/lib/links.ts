import { sameOriginHttps } from './beacon';
import { safeVerificationUri } from './urls';

/**
 * "Open Beacon in" (Settings, this computer only): the system default browser, one of the browsers detected on this
 * computer, or one picked by hand in the native file dialog. The host keeps it (src-tauri/src/browser.rs,
 * `get_browser` / `set_browser` / `pick_browser`); the webview only shows it and never passes it when opening a link
 * (audit GC-L1).
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

/** What the UI may ask the host for: the system default or a detected browser (by id). Never a path. */
export type BrowserRequest = { kind: 'system' } | { kind: 'detected'; id: string };

/** The choice as the host reports it, or the system default when it is missing or malformed. */
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
 * - `help`: any https page (no credentials), e.g. the Store listing;
 * - `meeting`: a meeting's *Join* link, only on the video-call hosts of `meetingJoinUrl`.
 */
export type LinkRule = { kind: 'beacon'; server: string | null | undefined } | { kind: 'device'; server: string } | { kind: 'help' } | { kind: 'meeting' };

/** Video-call providers of a *Join* link (contract §22.4, the same list as TimeTrackBundle's `MeetingLinkDetector`). */
export type JoinProvider = 'teams' | 'meet' | 'zoom' | 'jitsi' | 'webex';

/** Exact hosts and `*.` suffixes per provider. Self-hosted Jitsi hosts of the server's `jitsi_hosts` are not known here. */
const JOIN_HOSTS: readonly [JoinProvider, readonly string[], readonly string[]][] = [
  ['teams', ['teams.microsoft.com', 'teams.live.com'], []],
  ['meet', ['meet.google.com'], []],
  ['zoom', ['zoom.us', 'zoomgov.com'], ['.zoom.us', '.zoomgov.com']],
  ['jitsi', ['meet.jit.si'], []],
  ['webex', [], ['.webex.com']],
];

/** Control, whitespace (C0, space, DEL, C1) or quote-like characters: never in a link the app opens. */
const unsafeLinkChar = (char: string): boolean => {
  const code = char.codePointAt(0) as number;
  return code <= 0x20 || (code >= 0x7f && code <= 0x9f) || '"\'`<>\\'.includes(char);
};

/** Longest *Join* link accepted (as the server). */
export const MAX_JOIN_URL = 2048;

/**
 * A meeting's *Join* link checked again on this computer (defence in depth, contract §23.8): https on the default port,
 * no user info, no control, whitespace or quote characters, at most 2048 characters, and a host of the allow-list.
 * Anything else is `null` ("This link cannot be opened from TimeTrack").
 */
export function meetingJoinUrl(url: unknown): { url: string; provider: JoinProvider } | null {
  if (typeof url !== 'string' || url === '' || url.length > MAX_JOIN_URL || [...url].some(unsafeLinkChar)) return null;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' || target.username !== '' || target.password !== '' || target.port !== '') return null;
  const host = target.hostname.toLowerCase();
  const found = JOIN_HOSTS.find(([, exact, suffixes]) => exact.includes(host) || suffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length));
  return found === undefined || target.href.length > MAX_JOIN_URL ? null : { url: target.href, provider: found[0] };
}

export function externalUrl(url: string | null | undefined, rule: LinkRule): string | null {
  if (typeof url !== 'string' || url === '') return null;
  if (rule.kind === 'beacon') return sameOriginHttps(url, rule.server) ?? loopbackSameOrigin(url, rule.server);
  if (rule.kind === 'device') return safeVerificationUri(url, rule.server);
  if (rule.kind === 'meeting') return meetingJoinUrl(url)?.url ?? null;
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
