/**
 * Links back to the Beacon web app ("Open Beacon", "My time", "Open in Beacon" per task).
 *
 * Every link is checked with `new URL()` before it is shown or opened: it must be an absolute `https:` URL without
 * credentials whose origin (scheme, host and port) equals the origin of the server the user connected to. Anything
 * else — another host, `http:`, `javascript:`, `data:`, a relative path, userinfo, another port, or no server at all —
 * yields `null`, and the UI hides the link. Task URLs come from the API (`url` on `tasks` and `timer`) and are never
 * trusted beyond this check.
 *
 * Keep this file identical in time-track-desktop and time-track-extension.
 */

/** Path of Beacon's dashboard, relative to the connected server URL. */
export const DASHBOARD_PATH = '/dashboard';

/** Path of the user's "My time" page, relative to the connected server URL. */
export const MY_TIME_PATH = '/dashboard/tasks/time';

/**
 * Returns `candidate` normalised when it may be opened for `server`, otherwise `null`.
 *
 * @param candidate absolute URL (from the API or built from the server URL)
 * @param server the connected server URL (`null` / `undefined` before connecting)
 */
export function sameOriginHttps(candidate: unknown, server: string | null | undefined): string | null {
  if (typeof candidate !== 'string' || candidate === '' || typeof server !== 'string' || server === '') return null;
  let target: URL;
  let base: URL;
  try {
    target = new URL(candidate);
    base = new URL(server);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' || base.protocol !== 'https:') return null;
  if (target.username !== '' || target.password !== '') return null;
  return target.origin === base.origin ? target.href : null;
}

/** `<server><path>` when the server is https, otherwise `null`. */
function serverLink(server: string | null | undefined, path: string): string | null {
  if (typeof server !== 'string' || server === '') return null;
  return sameOriginHttps(`${server.replace(/\/+$/, '')}${path}`, server);
}

/** "Open Beacon": `<server>/dashboard`. */
export function dashboardUrl(server: string | null | undefined): string | null {
  return serverLink(server, DASHBOARD_PATH);
}

/** "My time": `<server>/dashboard/tasks/time`. */
export function myTimeUrl(server: string | null | undefined): string | null {
  return serverLink(server, MY_TIME_PATH);
}

/** The task page from the API's `url` field, when present and same-origin https. */
export function taskUrl(url: unknown, server: string | null | undefined): string | null {
  return sameOriginHttps(url, server);
}
