/**
 * What the user types in "Beacon address": tolerant input, strict result.
 *
 * - trims, adds `https://` when there is no scheme (`beacon.example.com` → `https://beacon.example.com`);
 * - accepts the URL of any Beacon page (`…/dashboard/…`, `…/login`, `…/device`) and keeps the part before it;
 * - rejects credentials, `http:` on a non-loopback host and anything `new URL()` cannot parse.
 * The final check is still `normalizeServerUrl()` of the API client.
 */
export type ServerUrlProblem = 'empty' | 'invalid' | 'credentials' | 'insecure';

export type ServerUrlResult = { ok: true; url: string } | { ok: false; problem: ServerUrlProblem };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Beacon paths people paste from the browser bar; the server URL is what comes before them. */
const KNOWN_PATHS = /\/(dashboard|login|logout|device|api\/time-track)(\/.*)?$/i;

export function prepareServerUrl(input: string): ServerUrlResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, problem: 'empty' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.hostname === '' || (url.protocol !== 'https:' && url.protocol !== 'http:')) return { ok: false, problem: 'invalid' };
  if (url.username !== '' || url.password !== '') return { ok: false, problem: 'credentials' };
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) return { ok: false, problem: 'insecure' };
  const path = url.pathname.replace(KNOWN_PATHS, '').replace(/\/+$/, '');
  return { ok: true, url: `${url.origin}${path}` };
}

/** Host shown in messages ("Can't reach beacon.example.com"). */
export function hostOf(server: string | null | undefined): string {
  if (!server) return '';
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}
