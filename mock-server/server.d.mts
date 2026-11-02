import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export function createMockServer(options?: { allowedOrigins?: string[] | null }): {
  server: Server;
  listen(port?: number, host?: string): Promise<AddressInfo | string | null>;
  close(): Promise<void>;
};
