/**
 * `fetch` backed by the Rust command `beacon_fetch` (src-tauri/src/net.rs). The webview never reaches the network
 * itself: every Beacon request goes through the Rust HTTP client, which pins the TLS public keys of the official
 * Beacon host (docs/PINNING.md). Only the parts of `fetch` the API client uses are supported: a string / URL input,
 * GET / POST, plain headers and a string body.
 *
 * The session token never reaches the webview: Rust keeps it in the OS keychain and sets `Authorization` itself
 * (src-tauri/src/secret.rs). The API client still adds `Authorization: Bearer <SESSION_HANDLE>` to authenticated
 * requests; this bridge turns that header into `auth: true` and never forwards it.
 */

/**
 * What the app holds in place of the session token in the Tauri app (the sign-in answers carry it instead of the
 * token, `secret_status` maps to it). Not a credential. Same value as `secret::SESSION_HANDLE` in Rust.
 */
export const SESSION_HANDLE = 'stored-in-os-keychain';

/** What `sign_in_begin` rejects with when the person declines the native "Sign in to …?" confirmation (Rust `secret::SIGN_IN_DECLINED`). */
export const SIGN_IN_DECLINED = 'sign_in_declined';

/** The person declined the native sign-in confirmation: back to the sign-in view, no error. */
export function isSignInDeclined(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)) === SIGN_IN_DECLINED;
}

/** What `beacon_fetch` receives. */
export interface NativeRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
  /** Rust adds the stored session token (`Authorization`) to this request. */
  auth: boolean;
}

/** What `beacon_fetch` answers; `body` is base64. */
export interface NativeResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

/** Statuses whose `Response` must not have a body. */
const NULL_BODY = new Set([204, 205, 304]);

/** The headers to forward, without `Authorization` (its presence only marks the request as authenticated). */
function headerPairs(headers: HeadersInit | undefined): { pairs: [string, string][]; auth: boolean } {
  const pairs: [string, string][] = [];
  let auth = false;
  new Headers(headers).forEach((value, name) => {
    if (name.toLowerCase() === 'authorization') auth = true;
    else pairs.push([name, value]);
  });
  return { pairs, auth };
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Builds the `fetch` the API client uses; `send` is `invoke('beacon_fetch', { request })` in the app. */
export function nativeFetch(send: (request: NativeRequest) => Promise<NativeResponse>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('Only URL inputs are supported.');
    if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new TypeError('Only string bodies are supported.');
    let answer: NativeResponse;
    try {
      const { pairs, auth } = headerPairs(init?.headers);
      answer = await send({ url: input.toString(), method: init?.method ?? 'GET', headers: pairs, body: init?.body ?? null, auth });
    } catch (error) {
      // Tauri rejects with the command's error string (`beacon_untrusted_certificate: …` on a pin mismatch).
      throw error instanceof Error ? error : new TypeError(String(error));
    }
    return new Response(NULL_BODY.has(answer.status) ? null : decodeBase64(answer.body), {
      status: answer.status,
      statusText: answer.statusText,
      headers: answer.headers,
    });
  }) as typeof fetch;
}
