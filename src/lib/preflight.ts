import { API_PREFIX, ApiError } from '../api/client';

/**
 * Connect preflight: `GET {server}/api/time-track/me` without a token, to tell "not a Beacon server" (404 / 405 /
 * redirect) from "can't reach it" before starting the device flow. `401` (or any 2xx / 403) means the API is there.
 * Sends no credentials and no data.
 */
export async function preflight(fetchImpl: typeof fetch, server: string): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${server}${API_PREFIX}/me`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch (error) {
    throw new ApiError(0, 'network_error', error instanceof Error ? error.message : 'Network error.');
  }
  const status = response.status;
  if (status === 401 || status === 403 || (status >= 200 && status < 300)) return;
  if (status === 404 || status === 405 || status === 0 || (status >= 300 && status < 400)) {
    throw new ApiError(status === 0 ? 404 : status, 'not_found', `GET ${API_PREFIX}/me answered HTTP ${status}.`);
  }
  if (status === 429) {
    const retry = Number(response.headers.get('Retry-After'));
    throw new ApiError(429, 'rate_limited', 'Too many requests.', Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  throw new ApiError(status, 'server_error', `GET ${API_PREFIX}/me answered HTTP ${status}.`);
}
