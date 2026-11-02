import type { TimeTrackApi } from '../api/client';
import type { DeviceCode, LoginResult, Scope } from '../api/types';

export type DeviceFlowFailure = 'expired' | 'denied' | 'invalid_scope' | 'cancelled';

export class DeviceFlowError extends Error {
  constructor(public readonly reason: DeviceFlowFailure) {
    super(`Device sign-in ${reason}`);
    this.name = 'DeviceFlowError';
  }
}

export interface DeviceFlowOptions {
  clientName: string;
  scopes?: readonly Scope[];
  onCode(code: DeviceCode): void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * RFC 8628 device flow against TimeTrackBundle 1.9.0: `device/code`, show the user code, poll `device/token` every
 * `interval` seconds; `slow_down` adds 5 s; `expired_token`, `access_denied`, `invalid_scope` end the flow.
 */
export async function runDeviceFlow(api: TimeTrackApi, options: DeviceFlowOptions): Promise<LoginResult> {
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  let code: DeviceCode;
  try {
    code = await api.deviceCode(options.clientName, options.scopes);
  } catch (error) {
    if ((error as { code?: string }).code === 'invalid_scope') throw new DeviceFlowError('invalid_scope');
    throw error;
  }
  await options.onCode(code);
  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;
  for (;;) {
    await sleep(interval * 1000);
    if (options.signal?.aborted) throw new DeviceFlowError('cancelled');
    if (now() >= deadline) throw new DeviceFlowError('expired');
    const result = await api.deviceToken(code.deviceCode);
    switch (result.status) {
      case 'pending':
        break;
      case 'slow_down':
        interval += 5;
        break;
      case 'approved':
        return { token: result.token, expiresAt: result.expiresAt, scopes: result.scopes };
      default:
        throw new DeviceFlowError(result.status);
    }
  }
}
