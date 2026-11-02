const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The device-flow verification URI comes from the server. It is opened in the browser only when it is https (or
 * loopback http for a loopback server) on the same host as the server the user typed; otherwise the UI shows it as
 * text and the user decides (audit CN D3).
 */
export function safeVerificationUri(uri: string | null | undefined, server: string): string | null {
  if (!uri) return null;
  try {
    const target = new URL(uri);
    const base = new URL(server);
    const loopback = LOOPBACK.has(base.hostname) && target.protocol === 'http:';
    if ((target.protocol !== 'https:' && !loopback) || target.username !== '' || target.password !== '') return null;
    return target.host === base.host ? target.toString() : null;
  } catch {
    return null;
  }
}

/** Beacon's Apps page (manual download of installers). */
export function appsPage(server: string): string {
  return `${server.replace(/\/+$/, '')}/dashboard/tasks/time/apps`;
}
