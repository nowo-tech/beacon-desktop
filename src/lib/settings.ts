import type { Scope, Task, Timer } from '../api/types';
import { DEFAULT_SHORTCUT } from '../platform';

/** Opt-in features. Each one is off by default and keeps a dated consent record. */
export type Feature = 'idleDetection' | 'notifications' | 'autostart';

export interface ConsentRecord {
  granted: boolean;
  /** ISO date of the decision. */
  at: string;
  /** Version of the information text the user saw. */
  textVersion: number;
}

/** Bump when the information text of an opt-in feature changes, so consent is asked again. */
export const CONSENT_TEXT_VERSION = 1;

export interface Settings {
  idleDetection: boolean;
  idleMinutes: number;
  notifications: boolean;
  autostart: boolean;
  /** Global shortcut (Tauri accelerator syntax). */
  shortcut: string;
}

/** At most 9 pinned tasks (`Alt+1…9`). */
export const MAX_PINNED = 9;

/** Connection metadata. The token itself lives in the OS keychain only. */
export interface SessionInfo {
  server: string;
  identifier: string;
  displayName: string | null;
  scopes: Scope[];
  expiresAt: string;
}

export interface LocalState {
  session: SessionInfo | null;
  lastServer: string | null;
  activeTimer: Timer | null;
  settings: Settings;
  consents: Partial<Record<Feature, ConsentRecord>>;
  /** Pinned tasks, local only (ids and titles as last seen). */
  pinned: Task[];
  /** Last task tracked on this computer, for "Resume". */
  lastTask: Task | null;
}

export const DEFAULT_SETTINGS: Settings = {
  idleDetection: false,
  idleMinutes: 10,
  notifications: false,
  autostart: false,
  shortcut: DEFAULT_SHORTCUT,
};

const KEY = 'time-track-desktop';

export function emptyState(): LocalState {
  return { session: null, lastServer: null, activeTimer: null, settings: { ...DEFAULT_SETTINGS }, consents: {}, pinned: [], lastTask: null };
}

export function loadLocal(storage: Storage = localStorage): LocalState {
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? '{}') as Partial<LocalState>;
    return {
      ...emptyState(),
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      pinned: Array.isArray(raw.pinned) ? raw.pinned.slice(0, MAX_PINNED) : [],
    };
  } catch {
    return emptyState();
  }
}

export function saveLocal(state: LocalState, storage: Storage = localStorage): void {
  storage.setItem(KEY, JSON.stringify(state));
}

export function recordConsent(state: LocalState, feature: Feature, granted: boolean, now: Date = new Date()): LocalState {
  return {
    ...state,
    settings: { ...state.settings, [feature]: granted },
    consents: { ...state.consents, [feature]: { granted, at: now.toISOString(), textVersion: CONSENT_TEXT_VERSION } },
  };
}

export function hasConsent(state: LocalState, feature: Feature): boolean {
  const record = state.consents[feature];
  return state.settings[feature] === true && record !== undefined && record.granted && record.textVersion === CONSENT_TEXT_VERSION;
}
