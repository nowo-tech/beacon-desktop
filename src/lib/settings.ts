import type { Scope, Task, Timer } from '../api/types';
import { DEFAULT_SHORTCUT } from '../platform';
import { EMPTY_MESSAGES, type MessageState, sanitizeMessages } from './friendly';
import { type BrowserChoice, sanitizeBrowser, SYSTEM_BROWSER } from './links';
import { type IdleCheckState, WATCHING } from './idleCheck';
import { DEFAULT_LEAD_MINUTES, EMPTY_SCHEDULE, LEAD_CHOICES, sanitizeSchedule, type ScheduleState } from './schedule';
import type { ServerFeatures } from './serverFeatures';
import { isTheme, type ThemePreference } from './theme';

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
  /** Opt-in "Still there?" check, used only when the server does not say (1.9). */
  idleDetection: boolean;
  /** Own "Still there?" threshold in minutes; `null` = the organisation's (or the local default). Only lengthens it. */
  idleMinutes: number | null;
  notifications: boolean;
  autostart: boolean;
  /** Global shortcut (Tauri accelerator syntax). */
  shortcut: string;
  /** Colour theme: follow the system (default), light or dark. */
  theme: ThemePreference;
  /** Friendly messages (0.5.0): varied "Still there?" phrasing, cheers, early start, Friday and weekend moments. */
  funMessages: boolean;
  /** Friendly messages (0.5.0): coffee, lunch, stretch / water and late-work nudges. */
  wellbeingReminders: boolean;
  /** Friendly messages as desktop notifications, outside the window (on by default); off = toasts inside the app. */
  desktopNotifications: boolean;
  /** What the OS said the last time a desktop notification was due (`unknown` until the first one). */
  nativeStatus: NativeStatus;
  /** The in-app note explaining that the messages now appear as desktop notifications was read. */
  nativeIntroSeen: boolean;
  /** Working-hours reminders (start, lunch, end of the day; on by default). */
  scheduleReminders: boolean;
  /** "Shall we start?" this many minutes before the start time (`LEAD_CHOICES`). */
  scheduleLeadMinutes: number;
  /** "Open Beacon in": the browser for every link the app opens (this computer only). */
  browser: BrowserChoice;
}

/**
 * Desktop notifications of the friendly messages: `granted` (shown by the OS), `denied` (turned off for the app in the
 * system settings), `failed` (no notification service answered), `unsupported` (no desktop notifications at all,
 * e.g. a plain browser). Anything but `granted` shows the messages inside the app, and Settings says why.
 */
export type NativeStatus = 'unknown' | 'granted' | 'denied' | 'failed' | 'unsupported';

const NATIVE_STATUSES: readonly string[] = ['unknown', 'granted', 'denied', 'failed', 'unsupported'];

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
  /** "Still there?" check (survives a restart, so an unanswered question or an auto-stop is not lost). */
  idleCheck: IdleCheckState;
  /** "I was in a meeting" note, sent with the next stop / switch of the running entry. */
  pendingNote: string | null;
  /** Server features as last seen on `GET me` (offline start). */
  features: ServerFeatures | null;
  /** Friendly messages: what was shown lately (no repeats, rate limit, once per window per day). Local only. */
  messages: MessageState;
  /** My schedule: local overrides of Beacon's working hours, local days off, reminders already shown. Local only. */
  schedule: ScheduleState;
}

export const DEFAULT_SETTINGS: Settings = {
  idleDetection: false,
  idleMinutes: null,
  notifications: false,
  autostart: false,
  shortcut: DEFAULT_SHORTCUT,
  theme: 'system',
  funMessages: true,
  wellbeingReminders: true,
  desktopNotifications: true,
  nativeStatus: 'unknown',
  nativeIntroSeen: false,
  scheduleReminders: true,
  scheduleLeadMinutes: DEFAULT_LEAD_MINUTES,
  browser: SYSTEM_BROWSER,
};

const KEY = 'time-track-desktop';

export function emptyState(): LocalState {
  return {
    session: null,
    lastServer: null,
    activeTimer: null,
    settings: { ...DEFAULT_SETTINGS },
    consents: {},
    pinned: [],
    lastTask: null,
    idleCheck: WATCHING,
    pendingNote: null,
    features: null,
    messages: { ...EMPTY_MESSAGES },
    schedule: { ...EMPTY_SCHEDULE },
  };
}

export function loadLocal(storage: Storage = localStorage): LocalState {
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? '{}') as Partial<LocalState>;
    return {
      ...emptyState(),
      ...raw,
      // 0.2 stored the old default (10) for everyone: only a different value was the person's own choice.
      settings: {
        ...DEFAULT_SETTINGS,
        ...(raw.settings ?? {}),
        idleMinutes: typeof raw.settings?.idleMinutes === 'number' && raw.settings.idleMinutes !== 10 ? raw.settings.idleMinutes : null,
        theme: isTheme(raw.settings?.theme) ? raw.settings.theme : DEFAULT_SETTINGS.theme,
        funMessages: typeof raw.settings?.funMessages === 'boolean' ? raw.settings.funMessages : DEFAULT_SETTINGS.funMessages,
        wellbeingReminders: typeof raw.settings?.wellbeingReminders === 'boolean' ? raw.settings.wellbeingReminders : DEFAULT_SETTINGS.wellbeingReminders,
        desktopNotifications: typeof raw.settings?.desktopNotifications === 'boolean' ? raw.settings.desktopNotifications : DEFAULT_SETTINGS.desktopNotifications,
        nativeStatus: NATIVE_STATUSES.includes(raw.settings?.nativeStatus as string) ? (raw.settings?.nativeStatus as NativeStatus) : DEFAULT_SETTINGS.nativeStatus,
        nativeIntroSeen: raw.settings?.nativeIntroSeen === true,
        scheduleReminders: typeof raw.settings?.scheduleReminders === 'boolean' ? raw.settings.scheduleReminders : DEFAULT_SETTINGS.scheduleReminders,
        scheduleLeadMinutes: LEAD_CHOICES.includes(raw.settings?.scheduleLeadMinutes as number) ? (raw.settings?.scheduleLeadMinutes as number) : DEFAULT_SETTINGS.scheduleLeadMinutes,
        browser: sanitizeBrowser(raw.settings?.browser),
      },
      messages: sanitizeMessages(raw.messages),
      schedule: sanitizeSchedule(raw.schedule),
      idleCheck: typeof raw.idleCheck === 'object' && raw.idleCheck !== null && 'phase' in raw.idleCheck ? raw.idleCheck : WATCHING,
      pinned: Array.isArray(raw.pinned) ? raw.pinned.slice(0, MAX_PINNED) : [],
    };
  } catch {
    return emptyState();
  }
}

/** Every key this app writes to its local storage (for "Clear local data"). */
export const LOCAL_KEYS = [KEY, `${KEY}.queue`];

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
