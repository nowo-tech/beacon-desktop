/**
 * `fetch` backed by the Rust command `beacon_fetch` (src-tauri/src/net.rs). The webview never reaches the network
 * itself: every Beacon request goes through the Rust HTTP client, which pins the TLS public keys of the official
 * Beacon host (docs/PINNING.md). Only the parts of `fetch` the API client uses are supported: a string / URL input,
 * GET / POST, plain headers and a string body.
 */

/** What `beacon_fetch` receives. */
export interface NativeRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
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

function headerPairs(headers: HeadersInit | undefined): [string, string][] {
  const pairs: [string, string][] = [];
  new Headers(headers).forEach((value, name) => pairs.push([name, value]));
  return pairs;
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
      answer = await send({ url: input.toString(), method: init?.method ?? 'GET', headers: headerPairs(init?.headers), body: init?.body ?? null });
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
