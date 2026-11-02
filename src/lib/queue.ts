import { ApiError, type TimeTrackApi } from '../api/client';
import type { Timer } from '../api/types';

/**
 * Offline queue. Actions taken while the server is unreachable are kept locally (with the time they happened)
 * and replayed in order when the connection returns:
 * - stop at T → `timer/discard-idle {from: T, to: now, action: discard}` closes the entry at T (falls back to
 *   `timer/stop` when T is before the server's timer start);
 * - start → `timer/start` (the server records the start when it receives it: 1.9.0 has no backdated start);
 * - switch at T → stop at T, then start.
 */
export type QueuedAction =
  | { kind: 'start'; taskId: string; taskTitle: string; at: string }
  | { kind: 'stop'; at: string }
  | { kind: 'switch'; taskId: string; taskTitle: string; at: string };

export interface SyncResult {
  synced: number;
  dropped: { action: QueuedAction; code: string }[];
  timer: Timer | null | undefined;
}

const KEY = 'time-track-desktop.queue';

export class OfflineQueue {
  constructor(private readonly storage: Storage = localStorage) {}

  list(): QueuedAction[] {
    try {
      return JSON.parse(this.storage.getItem(KEY) ?? '[]') as QueuedAction[];
    } catch {
      return [];
    }
  }

  get size(): number {
    return this.list().length;
  }

  push(action: QueuedAction): void {
    this.storage.setItem(KEY, JSON.stringify([...this.list(), action]));
  }

  clear(): void {
    this.storage.removeItem(KEY);
  }

  private shift(): void {
    this.storage.setItem(KEY, JSON.stringify(this.list().slice(1)));
  }

  /**
   * Replays the queue. Stops at the first network error (the rest stays queued); a 401 is re-thrown so the UI asks
   * the user to sign in again; other API errors drop that action and are reported.
   */
  async sync(api: TimeTrackApi, now: () => Date = () => new Date()): Promise<SyncResult> {
    const result: SyncResult = { synced: 0, dropped: [], timer: undefined };
    for (let action = this.list()[0]; action !== undefined; action = this.list()[0]) {
      try {
        result.timer = await replay(api, action, now());
        result.synced++;
      } catch (error) {
        if (!(error instanceof ApiError) || error.isNetwork || error.isUnauthorized || error.status === 429) {
          throw error;
        }
        result.dropped.push({ action, code: error.code });
      }
      this.shift();
    }
    return result;
  }
}

async function stopAt(api: TimeTrackApi, at: Date, now: Date): Promise<void> {
  try {
    await api.discardIdle(at, now, 'discard');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'invalid_request') {
      await api.stop();
      return;
    }
    if (error instanceof ApiError && error.code === 'no_active_timer') {
      return;
    }
    throw error;
  }
}

async function replay(api: TimeTrackApi, action: QueuedAction, now: Date): Promise<Timer | null> {
  const at = new Date(action.at);
  if (action.kind === 'stop') {
    await stopAt(api, at > now ? now : at, now);
    return null;
  }
  if (action.kind === 'switch') {
    await stopAt(api, at > now ? now : at, now);
  }
  try {
    return await api.start(action.taskId);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'timer_running') {
      return (await api.switchTask(action.taskId)).timer;
    }
    throw error;
  }
}
