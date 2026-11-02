import type { Scope, Timer } from '../api/types';

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
}

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
}

export const DEFAULT_SETTINGS: Settings = { idleDetection: false, idleMinutes: 10, notifications: false, autostart: false };

const KEY = 'time-track-desktop';

export function emptyState(): LocalState {
  return { session: null, lastServer: null, activeTimer: null, settings: { ...DEFAULT_SETTINGS }, consents: {} };
}

export function loadLocal(storage: Storage = localStorage): LocalState {
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? '{}') as Partial<LocalState>;
    return { ...emptyState(), ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) } };
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
