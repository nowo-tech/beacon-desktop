import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMockServer } from '../../mock-server/server.mjs';

/** Minimal fetch over node:http (independent of the DOM test environment). */
export const nodeFetch = ((input: string, init: RequestInit = {}) =>
  new Promise((resolve, reject) => {
    const req = request(input, { method: init.method ?? 'GET', headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? '',
          headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
          text: async () => body.toString('utf8'),
          json: async () => JSON.parse(body.toString('utf8')),
          blob: async () => new Blob([body]),
        } as unknown as Response);
      });
    });
    req.on('error', reject);
    if (init.body !== undefined && init.body !== null) req.write(init.body as string);
    req.end();
  })) as unknown as typeof fetch;

export async function startMock() {
  const mock = createMockServer();
  const address = (await mock.listen(0)) as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const control = async (path: string, body?: unknown) => {
    const response = await nodeFetch(`${url}/__mock/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.status === 204 ? null : response.json();
  };
  return { mock, url, control };
}
