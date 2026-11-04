import type { TimeTrackApi } from '../api/client';
import { type QueuedAction, type SyncResult, syncQueue } from './replay';
import type { ServerFeatures } from './serverFeatures';

export type { QueuedAction, SyncResult } from './replay';

const KEY = 'time-track-desktop.queue';

/**
 * Offline queue of the desktop app, in localStorage (survives a restart). The replay rules (real start / stop times,
 * clamp reports, 1.9 fallbacks) are in `replay.ts`, shared with the extension.
 */
export class OfflineQueue {
  constructor(private readonly storage: Storage = localStorage) {}

  list(): QueuedAction[] {
    try {
      const parsed = JSON.parse(this.storage.getItem(KEY) ?? '[]') as unknown;
      return Array.isArray(parsed) ? (parsed as QueuedAction[]) : [];
    } catch {
      return [];
    }
  }

  get size(): number {
    return this.list().length;
  }

  push(...actions: QueuedAction[]): void {
    this.write([...this.list(), ...actions]);
  }

  clear(): void {
    this.storage.removeItem(KEY);
  }

  private write(actions: QueuedAction[]): void {
    if (actions.length === 0) this.storage.removeItem(KEY);
    else this.storage.setItem(KEY, JSON.stringify(actions));
  }

  sync(api: TimeTrackApi, now: () => Date = () => new Date(), features?: ServerFeatures): Promise<SyncResult> {
    return syncQueue({ read: () => this.list(), write: (actions) => this.write(actions) }, api, now, features);
  }
}
