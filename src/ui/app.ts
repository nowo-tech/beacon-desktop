import { ApiError, TimeTrackApi, normalizeServerUrl } from '../api/client';
import { ALL_SCOPES, type DeviceCode, type Entry, type Me, MEETINGS_SCOPE, type Task, type Timer } from '../api/types';
import { dashboardUrl, myTimeUrl, sameOriginHttps, taskUrl } from '../lib/beacon';
import { DeviceFlowError, runDeviceFlow } from '../lib/deviceFlow';
import { type ErrorStage, type ErrorView, describeError, isUntrustedCertificate } from '../lib/errors';
import { type Card, type Switches, afterStop, beaconLocale, beaconTimeZone, CARD_TTL_MINUTES, CATALOG, DAILY_TOAST_MS, EMPTY_MESSAGES, IDLE_COUNTDOWN_MINUTES, lineText, MEETING_COUNTDOWN_MINUTES, messageLocale, MIN_GAP_MINUTES, nextCard, noticeTitle, pausedAt, pauseMessages, pickDailyDone, pickIdleLine, resumeMessages, taskKind, visibleCard, zonedParts } from '../lib/friendly';
import type { NoticeKind, PoseId, TaskKind } from '../lib/messages/types';
import { createTranslator, detectLocale, type Locale, type MessageKey, type Translate } from '../lib/i18n';
import { type GapChoice, type IdleCheckState, type IdleChoice, WATCHING, decide, decideGap, observeIdle, promptSpan } from '../lib/idleCheck';
import { lockReturn, meetingTask, pickerTasks, reassignMode, reassignWhileAsking } from '../lib/idleChoices';
import { composeNudge, EMPTY_NUDGE, NUDGE_MINUTES_CHOICES, type NudgeAction, nudgeActionOf, type NudgeNote, observeActivity, watchingActivity, workingNow } from '../lib/nudge';
import { preflight } from '../lib/preflight';
import { isSignInDeclined, isSignInWait } from '../lib/nativeFetch';
import { OfflineQueue } from '../lib/queue';
import { type ClampNote, type QueuedAction, type SyncResult, applyLocally } from '../lib/replay';
import { type ServerFeatures, effectiveThreshold, serverFeatures, thresholdChoices } from '../lib/serverFeatures';
import { hostOf, prepareServerUrl, type ServerUrlProblem } from '../lib/serverUrl';
import { type Feature, type LocalState, DEFAULT_SETTINGS, LOCAL_KEYS, MAX_PINNED, emptyState, hasConsent, loadLocal, recordConsent, saveLocal } from '../lib/settings';
import { computeTotals, formatHoursMinutes, recentTasks, startOfDay, startOfWeek, taskContext, todayByTask, type Totals } from '../lib/summary';
import { elapsedSeconds, formatElapsed } from '../lib/time';
import { applyTheme, forcedTheme, THEMES, type ThemePreference } from '../lib/theme';
import { appsPage, tasksPage } from '../lib/urls';
import { type BrowserChoice, copyableUrl, type DetectedBrowser, externalUrl, type LinkRule, SYSTEM_BROWSER } from '../lib/links';
import { EMPTY_POSES, EMPTY_TEXTS, type EmptyState, PIN_HINT, quickEmptyState } from '../lib/emptyStates';
import { compareVersions, isVersion, updateRequired } from '../lib/version';
import { ACTION_IDS, actionOfId, composeReminder, type ReminderNote } from '../lib/reminders';
import {
  type DayField,
  type DayOff,
  type Merged,
  type ReminderAction,
  type ReminderLineKind,
  type Week,
  type Weekday,
  EMPTY_SCHEDULE,
  LEAD_CHOICES,
  WEEKDAYS,
  addDays,
  allDaysOff,
  beaconDaysOff,
  beaconPart,
  beaconWeek,
  dayOffOn,
  dueReminder,
  markSeen,
  mergeWeek,
  nextReminderAt,
  setOverride,
  toggleLocalDayOff,
  weekdayOf,
  zonedInstant,
} from '../lib/schedule';
import {
  allowedAt,
  cacheExpiry,
  coveredByReminder,
  dueNow,
  fired,
  FRESH_POLL,
  GROUP_OVER,
  groupNote,
  isStale,
  type KeyedMeeting,
  LEAD_PRESETS,
  MAX_CUSTOM_LEAD,
  MAX_TRAY_MEETINGS,
  MeetingStore,
  type MeetingNote as ReminderMeetingNote,
  type MeetingSupport,
  meetingSupport,
  meetingTitle,
  MIN_CUSTOM_LEAD,
  nextDueAt,
  type NoteContext,
  parseMeetingsPage,
  parseReminderActionId,
  pausedNote,
  type PlanInput,
  pollDue,
  pollFailed,
  pollStarted,
  pollSucceeded,
  type PollState,
  putMark,
  RECHECK_ME_MINUTES,
  type ReminderActionKind,
  type ReminderMark,
  reminderNote,
  remindersEnabled,
  type ScheduleGate,
  sha256Hex,
  shortKey,
  type SnoozeChoice,
  snoozeChoices,
  snoozeUntil,
  START_WINDOW_MINUTES,
  startNote,
  todayMeetings,
  withKeys,
} from '../lib/meetingReminders';
import { MEETING_REMINDERS } from '../lib/messages/meetingReminders';
import { renderReminderSettings, renderReminderToast, renderTodayMeetings } from './meetingReminders';
import { withinWorkingHours } from '../lib/workingHours';
import { type LayoutMode, layoutFor, loadWindowMemory, otherMode, placeWindow, saveWindowMemory, WINDOW_KEY, type WindowMemory } from '../lib/layout';
import { type DaySpan, todaySpans, weekByTask, weekDays } from '../lib/week';
import { askNote, callMinutes, endedNote, finishMeeting, ignoreCall, inCall, MEETING_ACTION_IDS, meetingActionOfId, meetingCandidates, type MeetingNote, type MicSignal, MIC_POLL_SECONDS, NO_MEETING, observeMic, parseMicSignal, searchTasks, type TaskRef, tracking, withinWorkingDay } from '../lib/meetings';
import type { MeetingAction } from '../lib/messages/types';
import { meetingStatus, type PickerMode, renderMeetingSettings, renderMeetingToast } from './meetings';
import type { ConnectionSecurity, FriendlyNotification, Platform, SessionEvent, ShortcutSlot, TrayMenu, UpdateCheck, UpdateProgress, WakePlan } from '../platform';
import { h, patch, type Child } from './dom';
import { icon, type IconName } from './icons';
import { art, emptyArt, ERROR_POSES, moment, poseArt, variant, type Moment } from './mascot';
import { toastAction, toastActions } from './toast';
import { PromptMount, type PromptAnswer, type PromptBlock, type PromptButton, type PromptPicker, type PromptTaskOption, type PromptText, type PromptView } from './prompt';

export type View = 'loading' | 'login' | 'device' | 'main' | 'settings' | 'privacy' | 'update-required';

/** Sections of the full layout's sidebar (the compact layout shows the tasks section). */
export type Section = 'tasks' | 'quick' | 'time';

export interface AppDeps {
  storage?: Storage;
  now?: () => Date;
  locale?: Locale;
  beaconUrl?: string;
  /** Device-flow sleep (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
  searchDelayMs?: number;
  /** Auto-dismiss delay of info notices (ms). */
  noticeMs?: number;
  /** `store`: Microsoft Store build (the Store updates the app; no in-app updater, no autostart). Default `direct`. */
  channel?: Channel;
  /** Store listing of the app (`https://apps.microsoft.com/detail/<product id>`), store build only. */
  storeUrl?: string;
  /** Random source of the friendly messages (tests pin it). */
  random?: () => number;
  /** Width of the window's content in CSS px (layout breakpoint); default `window.innerWidth`. */
  viewportWidth?: () => number;
  /** Pause before a moved / resized window is remembered (ms). */
  windowSaveMs?: number;
}

export type Channel = 'direct' | 'store';

/**
 * Update card stages: offered (Update now · Later · What's new), asking because a timer runs, waiting for the timer to
 * stop, downloading (progress), installing (the app restarts).
 */
export type UpdateStage = 'offer' | 'confirm-running' | 'after-stop' | 'downloading' | 'installing';

type DeviceState = 'waiting' | 'expired' | 'denied' | 'scope';

const URL_PROBLEMS: Record<ServerUrlProblem, MessageKey> = {
  empty: 'urlEmpty',
  invalid: 'urlInvalid',
  credentials: 'urlCredentials',
  insecure: 'urlInsecure',
};

const MAX_TRAY_TASKS = 7;
/** Two checks further apart than this mean the computer slept in between (checks run every 30 s). */
const SUSPEND_GAP_MS = 90_000;
/** Server limit of a note (`NOTE_MAX_LENGTH`). */
const NOTE_MAX = 500;
/** Entries pages fetched for the week totals (100 each). */
const MAX_ENTRY_PAGES = 5;
/** A timer running this long gets a calm "still going?" nudge (once per entry, dismissible). */
export const LONG_RUNNING_HOURS = 8;
/** Success copy after a stop: the n-th stop of the session gets variant n mod 3. */
const SAVED_VARIANTS: MessageKey[] = ['savedA', 'savedB', 'savedC'];
const THEME_LABELS: Record<ThemePreference, MessageKey> = { system: 'themeSystem', light: 'themeLight', dark: 'themeDark' };

/** `m:ss` for the device-code countdown. */
function countdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** An accelerator as people read it on this system: `CommandOrControl+Alt+Space` → `Ctrl+Alt+Space` (⌘⌥Space on a Mac). */
export function shortcutLabel(accelerator: string, mac = /mac/i.test(globalThis.navigator?.platform ?? '')): string {
  const keys = accelerator.split('+').map((key) => key.trim()).filter((key) => key !== '');
  const names: Record<string, [string, string]> = {
    commandorcontrol: ['⌘', 'Ctrl'],
    cmdorctrl: ['⌘', 'Ctrl'],
    command: ['⌘', 'Cmd'],
    cmd: ['⌘', 'Cmd'],
    control: ['⌃', 'Ctrl'],
    ctrl: ['⌃', 'Ctrl'],
    alt: ['⌥', 'Alt'],
    option: ['⌥', 'Alt'],
    shift: ['⇧', 'Shift'],
    super: ['⌘', 'Super'],
  };
  const parts = keys.map((key) => names[key.toLowerCase()]?.[mac ? 0 : 1] ?? key);
  return parts.join(mac ? '' : '+');
}

interface MainRegions {
  root: HTMLElement;
  banners: HTMLElement;
  /** The "Still there?" modal (forces an answer; everything else is inert while it is open). */
  modal: HTMLElement;
  prompt: PromptMount;
  timer: HTMLElement;
  totals: HTMLElement;
  search: HTMLInputElement;
  quick: HTMLElement;
  list: HTMLElement;
  /** Full layout, "My time": today's entries and the week by day. */
  time: HTMLElement;
  /** The only part of the main screen that scrolls: banners, pinned + recent, task list, "My time". */
  scroller: HTMLElement;
  footer: HTMLElement;
}

/**
 * Desktop UI. The DOM is made of stable regions updated in place (header, status / alert messages, view; on the main
 * screen: banners, timer card, totals, search, pinned + recent, task list, footer). The search input is never
 * re-created and `patch()` gives focus back to the same control after a region changes. DOM nodes only (no innerHTML);
 * all platform access goes through `Platform`.
 */
export class DesktopApp {
  view: View = 'loading';
  state: LocalState;
  tasks: Task[] = [];
  /** Own entries of this week (for totals, "today" per task and recents). `null` when not readable. */
  entries: Entry[] | null = null;
  me: Me | null = null;
  device: DeviceCode | null = null;
  deviceState: DeviceState = 'waiting';
  /** Times the server recorded differently from what was asked (offline replay, idle check): shown until dismissed. */
  clampNotes: ClampNote[] = [];
  /** "I was in a meeting" form of the prompt is open. */
  meetingOpen = false;
  /** "Reassign to another task" picker of the prompt is open, with its search and results. */
  reassignOpen = false;
  reassignQuery = '';
  reassignResults: Task[] | null = null;
  reassignStatus: string | null = null;
  /** Screen locked / computer asleep (OS events, local only) and since when. */
  private session = { locked: false, asleep: false };
  lockedAt: Date | null = null;
  /** "Working without a timer?" shown inside the window (desktop notifications off or failing). */
  nudgeToast: NudgeNote | null = null;
  /** Result of saving the "Continue last" shortcut (Settings). */
  resumeShortcutMessage: { text: string; ok: boolean } | null = null;
  /** "Clear local data" asks for confirmation first. */
  confirmClear = false;
  update: { version: string; min: string | null; installable: boolean; notes: string | null } | null = null;
  updateStage: UpdateStage = 'offer';
  updateProgress: { downloaded: number; total: number | null } | null = null;
  /** "What's new" of the update card is open. */
  updateNotesOpen = false;
  /** "Later" on the update card: that version stays hidden until a manual check or the next launch. */
  updateLater: string | null = null;
  /** Result of the last manual "Check for updates" (shown in About). */
  updateStatus: string | null = null;
  /** `minSupportedVersion` of GET me: below it, the update is forced like the updater's minimum. */
  meMinimum: string | null = null;
  readonly channel: Channel;
  /** Non-blocking update message (no automatic update possible, or it failed): shown with a Beacon download link. */
  updateMessage: string | null = null;
  /** "Remind me later" on the update-required screen: hidden until the next launch. */
  updateDismissed = false;
  /** Verification URI that failed the same-host check: shown as text, never opened. */
  deviceUntrusted: string | null = null;
  /** The current failure (error catalogue), shown with its actions until dismissed or resolved. */
  error: ErrorView | null = null;
  notice: string | null = null;
  /** Mascot shown with the notice (success moments), if any. */
  noticeMoment: Moment | null = null;
  /** "You're in" card after a sign-in, until dismissed or a timer starts. */
  welcome = false;
  /** Entry (task + start) whose long-running nudge was answered "Keep going". */
  longRunningOk: string | null = null;
  /** Stops of this session (picks the success copy variant). */
  saves = 0;
  /** Last screen-reader announcement (visually hidden). */
  live = '';
  /** Value typed in the server field: never cleared by an error. */
  serverDraft: string;
  serverProblem: ServerUrlProblem | null = null;
  showWhere = false;
  shortcutMessage: { text: string; ok: boolean } | null = null;
  offline = false;
  /** TLS pinning state of the connected server, shown in Settings (`null`: unknown or not asked yet). */
  connectionSecurity: ConnectionSecurity | null = null;
  /** This build's pin set expired for the signed-in server (FY-I1): a card in the main view until dismissed. */
  pinExpired = false;
  busy = false;
  query = '';
  version = '0.0.0';
  readonly locale: Locale;
  readonly t: Translate;
  readonly queue: OfflineQueue;
  private lastCheck: Date | null = null;
  private updateCheck: Promise<void> | null = null;
  private token: string | null = null;
  private abort: AbortController | null = null;
  private deviceUrl: string | null = null;
  /** Server of the sign-in in progress (the verification page must be on it). */
  private deviceServer = '';
  private deviceStarted = 0;
  private deviceAnnounced = false;
  private retryAction: (() => Promise<void>) | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private deviceTicker: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Element the prompt focuses after its next update (`focusPrompt`). */
  private promptFocus: { id: string | null; seq: number } = { id: null, seq: 0 };
  /** The prompt window's answers are listened to. */
  private promptAnswers = false;
  /** Last content sent to the prompt window ('' = closed). */
  private promptWindowKey = '';
  /** The prompt window could not be opened: the in-app modal is used instead. */
  promptWindowFailed = false;
  /** Last wake plan sent to the host. */
  private wakePlanKey = '';
  /** In-app note about the desktop notifications: the first one was shown (`intro`), or the OS refused them (`off`). */
  nativeNotice: 'intro' | 'off' | null = null;
  /** Working-hours reminder shown as a toast (desktop notifications off, refused or failing). */
  reminderToast: ReminderNote | null = null;
  /** Day of the schedule open in Settings (`<details>`), kept across renders. */
  private openDays = new Set<Weekday>();
  /** "Add a day off" date typed in Settings. */
  private dayOffDraft = '';
  /** Last microphone report of the host (meeting detection; memory only, shown in Settings). */
  micSignal: MicSignal | null = null;
  /** "Choose task" of the meeting question is open (for the meeting, or to set the generic meeting once). */
  meetingPicker: PickerMode | null = null;
  meetingQuery = '';
  /** Meeting reminders (contract §23): what the server offers, today's and tomorrow's meetings, the dedupe marks. */
  meetingSupport: MeetingSupport = { kind: 'unsupported' };
  meetings: KeyedMeeting[] = [];
  /** When the list was fetched and when it expires (Unix ms; `null` without a list). */
  meetingsFetchedAt: number | null = null;
  private meetingsExpireAt: number | null = null;
  private meetingMarks: ReminderMark[] = [];
  meetingPoll: PollState = FRESH_POLL;
  /** Account (`server|identifier`) whose store is loaded. */
  private meetingAccount: string | null = null;
  private accountHash: { source: string; hash: string } | null = null;
  /** Fetch at the next check even before the regular interval (wake from sleep, network back). */
  private meetingsForce = false;
  private meetingsPolling: Promise<void> | null = null;
  /** The app was offline at the last check. */
  private meetingsOffline = false;
  /** Last `GET me` made only to see whether the meetings came back (no calendar, stopped). */
  private meetingMeCheckAt = 0;
  private readonly meetingStore: MeetingStore;
  /** The reminder, start prompt, automatic pause or grouped reminder shown in the window, and until when. */
  meetingReminder: ReminderMeetingNote | null = null;
  private meetingReminderUntil = 0;
  /** *Track the meeting* without a linked task: the picker of the reminder toast is open. */
  meetingReminderPicker: { query: string } | null = null;
  /** The timer paused automatically at a meeting's start: what *Undo* starts again. */
  private pausedForMeeting: { key: string; task: Task } | null = null;
  /** Settings: "Custom…" lead time chosen (the field shows even before a value), and a refused value. */
  customLead = false;
  leadError = false;
  /** The "Reconnect your calendar" banner was closed (until the next start). */
  reconnectDismissed = false;
  /** A re-consent device flow is running (its Cancel goes back to the main window, not to the sign-in). */
  private reconsent = false;
  /** "Daily done" toast after a daily-type timer stops. */
  dailyToast: { text: string; pose: PoseId; locale: string } | null = null;
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Toasts last rendered (re-rendered only when they change, so the polite live region speaks once). */
  private toastKey = '';
  private readonly toastRegion: HTMLElement;
  /** Settings → Open Beacon in: the browsers found on this computer (`null` until asked). */
  browsers: DetectedBrowser[] | null = null;
  /** "Open Beacon in" as the host keeps it (read at start and when Settings opens; never sent back when opening). */
  browserChoice: BrowserChoice = SYSTEM_BROWSER;
  /** Settings → Open Beacon in: why the picked browser was refused. */
  browserMessage: string | null = null;
  /** Right-click / long-press menu of a Beacon link (Open / Copy link). */
  linkMenu: { url: string; rule: LinkRule; x: number; y: number } | null = null;
  private readonly menuRegion: HTMLElement;
  private lastTrayMenu = '';
  private main: MainRegions | null = null;
  /** Layout drawn now (from the window width, lib/layout.ts). */
  layout: LayoutMode;
  /** Full layout: sidebar section shown in the main pane. */
  section: Section = 'tasks';
  /** Full layout: task shown in the detail pane (`null`: the running one, if any). */
  selectedTaskId: string | null = null;
  /** View last used and the window's bounds in each one (per device). */
  windowMemory: WindowMemory;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** A render is under way: focus moved back by `patch` is not a selection. */
  private rendering = false;
  /** Full layout: sections sidebar · main pane (messages and view) · detail pane. */
  private readonly sidebar: HTMLElement;
  private readonly center: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly header: HTMLElement;
  private readonly status: HTMLElement;
  /** Persistent polite live region: only its text changes, so an announcement is read once, not on every render. */
  private readonly liveRegion: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly body: HTMLElement;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly storage: Storage;
  private readonly timeFormat: Intl.DateTimeFormat;
  private readonly dateFormat: Intl.DateTimeFormat;

  constructor(
    private readonly root: HTMLElement,
    private readonly platform: Platform,
    private readonly deps: AppDeps = {},
  ) {
    this.storage = deps.storage ?? localStorage;
    this.channel = deps.channel ?? 'direct';
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.locale = deps.locale ?? detectLocale(globalThis.navigator?.language);
    this.t = createTranslator(this.locale);
    // The OS locale when it is a variant of the app's language (en-GB → 24 h), else the app's (es → 24 h, en → 12 h).
    const os = globalThis.navigator?.language;
    const formatLocale = typeof os === 'string' && os.toLowerCase().startsWith(this.locale) ? os : this.locale;
    this.timeFormat = new Intl.DateTimeFormat(formatLocale, { hour: 'numeric', minute: '2-digit' });
    this.dateFormat = new Intl.DateTimeFormat(formatLocale, { dateStyle: 'medium', timeStyle: 'short' });
    this.state = loadLocal(this.storage);
    this.serverDraft = this.state.lastServer ?? deps.beaconUrl ?? '';
    this.queue = new OfflineQueue(this.storage);
    this.meetingStore = new MeetingStore(this.storage);
    document.documentElement.lang = this.locale;
    applyTheme(this.state.settings.theme);
    this.header = h('header', { class: 'bar' });
    this.status = h('div', { class: 'messages', id: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.alert = h('div', { class: 'messages', id: 'alerts', attrs: { role: 'alert' } });
    this.body = h('div', { class: 'view', id: 'view' });
    this.liveRegion = h('p', { class: 'sr-only', id: 'live', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    this.toastRegion = h('div', { class: 'toasts', id: 'toasts', attrs: { 'aria-live': 'polite', 'aria-relevant': 'additions' } });
    this.windowMemory = loadWindowMemory(this.storage);
    this.layout = layoutFor(this.viewportWidth());
    this.sidebar = h('nav', { class: 'sidebar pane', id: 'sidebar', attrs: { hidden: true, tabindex: '-1' } });
    this.center = h('div', { class: 'main-pane pane', id: 'main-pane', attrs: { tabindex: '-1' } }, this.status, this.alert, this.body);
    this.detail = h('aside', { class: 'detail pane', id: 'detail', attrs: { hidden: true, tabindex: '-1', 'aria-labelledby': 'detail-title' } });
    this.menuRegion = h('div', { class: 'link-menu-region', id: 'link-menu-region' });
    this.root.replaceChildren(this.header, h('div', { class: 'frame', id: 'frame' }, this.sidebar, this.center, this.detail), this.liveRegion, this.toastRegion, this.menuRegion);
    document.addEventListener('keydown', (event) => this.onKey(event));
    globalThis.addEventListener?.('resize', () => this.relayout());
    // Any other link in the window (no handler of its own) goes through openExternal too, never into the app window.
    this.root.addEventListener('click', (event) => {
      this.closeLinkMenu();
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (event.defaultPrevented || !(link instanceof HTMLAnchorElement) || !/^https?:/i.test(link.href)) return;
      event.preventDefault();
      this.openLink(link.href);
    });
  }

  private viewportWidth(): number {
    return this.deps.viewportWidth?.() ?? globalThis.innerWidth ?? 0;
  }

  async init(): Promise<void> {
    this.version = await this.platform.appVersion();
    await this.syncWindowTheme();
    this.platform.onTray((action) => void this.trayAction(action));
    // Links the webview tried to open by itself (target=_blank, window.open, a navigation), refused by the host.
    this.platform.onOpenExternal((url) => this.openLink(url));
    // The regular check, woken by the host (on time while the window is hidden).
    this.platform.onWake((reason) => {
      // Back from sleep: today's meetings may have changed meanwhile (contract §23.5).
      if (reason === 'resumed') this.meetingsForce = true;
      void this.tick();
    });
    // A button of a notification: working-hours reminder (Start / Stop / Resume), "Working without a timer?" or a
    // meeting question.
    this.platform.onNotificationAction((id) => void this.notificationAction(id));
    // Meeting detection: what holds the microphone (only while it is on, see `wakePlan`).
    this.platform.onMic((signal) => this.onMic(signal));
    this.platform.onShortcut(() => this.focusSearch());
    // "Continue last": works with the window hidden in the tray (the shortcut does not show it).
    this.platform.onResumeShortcut(() => void this.continueLast());
    this.platform.onSessionEvent((event) => void this.sessionEvent(event));
    await this.restoreWindow();
    await this.applyShortcut(this.state.settings.shortcut, false);
    await this.applyShortcut(this.state.settings.resumeShortcut, false, 'resume');
    await this.loadBrowserChoice();
    this.token = await this.platform.secretGet();
    if (this.state.session === null || this.token === null) {
      // A token without a saved session (local data cleared) cannot be used or replaced: sign in again.
      if (this.token !== null) await this.forgetToken();
      // A saved session without its token (signed out elsewhere, a re-sign-in quit half way): the person is signed
      // out, so the account's local data goes now, before anyone else signs in (audit GO-L1).
      if (this.state.session !== null) {
        await this.prepareMeetingAccount();
        this.clearAccountData();
      }
      this.show('login');
      await this.updateTray();
      return;
    }
    try {
      await this.platform.bindServer(this.state.session.server);
    } catch {
      // The saved server is not allowed by this build (e.g. loopback http in a release build), or is not the server
      // that issued the stored token (the host refuses it): sign in again. The old session cannot be revoked from
      // here (its server is not bound), so the notice points to Beacon (audit GM-D-2).
      await this.forgetToken();
      await this.prepareMeetingAccount();
      this.clearAccountData();
      this.show('login');
      this.setNotice(this.t('signedOutRevoke'));
      await this.updateTray();
      return;
    }
    await this.prepareMeetingAccount();
    this.show('main');
    await this.refresh();
    await this.checkUpdates();
    await this.checkPinExpiry();
  }

  destroy(): void {
    this.abort?.abort();
    for (const timer of [this.ticker, this.deviceTicker]) if (timer !== null) clearInterval(timer);
    for (const timer of [this.searchTimer, this.noticeTimer, this.dailyTimer, this.windowTimer]) if (timer !== null) clearTimeout(timer);
    this.main?.prompt.dispose();
  }

  private api(): TimeTrackApi {
    return new TimeTrackApi({
      baseUrl: this.state.session?.server ?? this.state.lastServer ?? 'https://invalid.invalid',
      token: this.token,
      source: 'desktop',
      fetchImpl: this.platform.fetch,
    });
  }

  private persist(patch: Partial<LocalState>): void {
    this.state = { ...this.state, ...patch };
    saveLocal(this.state, this.storage);
  }

  show(view: View): void {
    if (view !== this.view) {
      this.showWhere = false;
      this.announce('');
      if (this.notice !== null) this.setNotice(null);
    }
    this.view = view;
    this.linkMenu = null;
    if (view === 'settings' && this.browsers === null) void this.loadBrowsers();
    this.render();
    if (view === 'settings') void this.loadConnectionSecurity();
  }

  /** Asks the host how the connection to the server is protected (TLS pinning, docs/PINNING.md). */
  private async loadConnectionSecurity(): Promise<void> {
    const server = this.state.session?.server ?? null;
    let security: ConnectionSecurity | null = null;
    try {
      security = server === null ? null : await this.platform.connectionSecurity(server);
    } catch {
      // Unknown: nothing is shown.
    }
    this.connectionSecurity = security;
    if (this.view === 'settings') this.render();
  }

  /**
   * The pin set of this build expired (FY-I1): a card in the main view and, once per pin set version, a desktop
   * notification, so "update the app" is seen without opening Settings.
   */
  async checkPinExpiry(): Promise<void> {
    await this.loadConnectionSecurity();
    const security = this.connectionSecurity;
    if (security?.status !== 'expired') return;
    this.pinExpired = true;
    this.render();
    if (this.state.settings.pinExpiryNotified === security.pinSetVersion) return;
    this.persist({ settings: { ...this.state.settings, pinExpiryNotified: security.pinSetVersion } });
    try {
      await this.platform.notify(this.t('pinExpiredTitle'), this.t('connPinExpired', { host: hostOf(this.state.session?.server) }));
    } catch {
      // The card in the main view is enough.
    }
  }

  dismissPinExpired(): void {
    this.pinExpired = false;
    this.render();
  }

  /** Info notice in the status region (optionally with a mascot moment); dismissed after a few seconds. */
  setNotice(text: string | null, art: Moment | null = null): void {
    this.notice = text;
    this.noticeMoment = text === null ? null : art;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = text === null ? null : setTimeout(() => this.setNotice(null), this.deps.noticeMs ?? 6000);
    this.renderMessages();
  }

  // ---- connection -------------------------------------------------------------------------------------------------

  /**
   * Device-flow sign-in: validates and completes the typed address, checks the server (`preflight`), asks for a code,
   * opens the verification page and polls until approved. Expired / denied codes stay on the device screen.
   */
  async connect(input: string = this.serverDraft): Promise<void> {
    this.serverDraft = input;
    const prepared = prepareServerUrl(input);
    if (!prepared.ok) {
      this.serverProblem = prepared.problem;
      this.error = null;
      this.render();
      this.body.querySelector<HTMLInputElement>('#server')?.focus();
      return;
    }
    let server: string;
    try {
      server = normalizeServerUrl(prepared.url);
    } catch {
      this.serverProblem = 'invalid';
      this.render();
      return;
    }
    this.serverProblem = null;
    this.serverDraft = server;
    this.abort = new AbortController();
    const api = new TimeTrackApi({ baseUrl: server, source: 'desktop', fetchImpl: this.platform.fetch });
    let stage: ErrorStage = 'preflight';
    await this.guard(
      async () => {
        try {
          // The host asks "Sign in to <host>?" natively, binds the server and keeps the token of this sign-in only
          // (the token never reaches the UI). Declined: back to the sign-in view, no error.
          try {
            await this.platform.beginSignIn(server);
          } catch (error) {
            const wait = isSignInWait(error);
            if (!wait && !isSignInDeclined(error)) throw error;
            this.device = null;
            // A declined re-sign-in (meeting reminders) leaves the person signed out, as the card said.
            if (!(await this.endReconsent())) this.view = 'login';
            // Declined moments ago: the host shows no dialog for a while (audit GM-D2-1).
            if (wait) this.setNotice(this.t('signInWait'));
            return;
          }
          await preflight(this.platform.fetch, server);
          stage = 'deviceCode';
          const login = await runDeviceFlow(api, {
            clientName: `TimeTrack desktop (${await this.platform.hostName()})`,
            // `meetings:read` (TimeTrack 1.14) is never granted implicitly; an older server refuses the unknown scope,
            // and the sign-in goes on without it.
            scopes: [...ALL_SCOPES, MEETINGS_SCOPE],
            fallbackScopes: ALL_SCOPES,
            sleep: this.deps.sleep,
            signal: this.abort?.signal,
            onCode: async (code) => {
              stage = 'action';
              const uri = code.verificationUriComplete ?? code.verificationUri;
              this.device = code;
              this.deviceState = 'waiting';
              this.deviceStarted = this.now().getTime();
              this.deviceAnnounced = false;
              this.deviceUrl = externalUrl(uri, { kind: 'device', server });
              this.deviceServer = server;
              this.deviceUntrusted = this.deviceUrl === null ? uri : null;
              this.show('device');
              if (this.deviceUrl !== null) await this.openExternal(this.deviceUrl, { kind: 'device', server });
            },
          });
          await this.platform.secretSet(login.token);
          this.token = login.token;
          api.setToken(login.token);
          const me = await api.me();
          // Another account than the saved one (a re-sign-in approved for someone else, or any sign-in after a
          // session that was left behind): the previous account's local data goes, as on sign-out (audit GO-L1).
          const previous = this.state.session;
          if (previous !== null && (previous.server !== server || previous.identifier !== me.identifier)) this.clearAccountData();
          this.me = me;
          this.persist({
            lastServer: server,
            session: { server, identifier: me.identifier, displayName: me.displayName ?? null, scopes: login.scopes, expiresAt: login.expiresAt },
          });
          await this.prepareMeetingAccount();
          this.device = null;
          this.view = 'main';
          this.welcome = !this.reconsent;
          this.reconsent = false;
          this.meetingPoll = FRESH_POLL;
          this.setNotice(null);
          await this.load(api);
          await this.checkPinExpiry();
        } catch (error) {
          if (error instanceof DeviceFlowError) {
            if (error.reason === 'cancelled') {
              await this.endReconsent();
              return;
            }
            this.deviceState = error.reason === 'expired' ? 'expired' : error.reason === 'denied' ? 'denied' : 'scope';
            this.view = 'device';
            return;
          }
          this.device = null;
          // A failed re-sign-in leaves the person signed out (the old session was already revoked).
          if (!(await this.endReconsent())) this.view = 'login';
          throw error;
        }
      },
      undefined,
      () => ({ stage, server }),
      () => this.connect(server),
    );
  }

  /** Deletes a stored token that cannot be used (best effort: a keychain refusal keeps it, and sign-in says so). */
  private async forgetToken(): Promise<void> {
    try {
      await this.platform.secretDelete();
    } catch {
      // Reported by the next sign-in attempt.
    }
    this.token = null;
  }

  cancelDevice(): void {
    this.abort?.abort();
    this.device = null;
    if (this.reconsent) {
      void this.endReconsent();
      return;
    }
    this.show('login');
  }

  /**
   * Ends a re-sign-in for meeting reminders that did not complete (declined, cancelled, failed): the old session was
   * revoked before it started, so the person is now signed out, and told so. False when no re-sign-in was running.
   */
  private async endReconsent(): Promise<boolean> {
    if (!this.reconsent) return false;
    this.reconsent = false;
    await this.signedOut(this.t('meetingRemindersReconsentSignedOut'));
    return true;
  }

  async logout(): Promise<void> {
    try {
      await this.api().logout();
    } catch {
      // Local sign-out never depends on the server.
    }
    await this.signedOut(null);
  }

  private async signedOut(notice: string | null): Promise<void> {
    await this.platform.secretDelete();
    this.token = null;
    this.clearAccountData();
    this.view = 'login';
    this.setNotice(notice);
    this.render();
    await this.updateTray();
  }

  /** The signed-in account's local data (not the token): on sign-out, and when a re-sign-in brings another account. */
  private clearAccountData(): void {
    // The friendly-message history goes too (its slots name the entries, `<task id>@<start>`), and the schedule
    // (overrides, days off, Beacon's copy) belongs to the person who signs out. So do the task ids and titles that
    // notifications and buttons can show (audit GC-L2): the last task ("Continue last", "Back to {task}?", "Start
    // {task}"), the pinned tasks, the "Working without a timer?" stretch and the generic meeting task — the next
    // person (maybe on another Beacon) never sees them or starts the previous account's task.
    // The account's store key, before the session goes.
    const account = this.meetingAccount ?? this.meetingAccountKey();
    this.persist({
      session: null,
      activeTimer: null,
      idleCheck: WATCHING,
      pendingNote: null,
      messages: { ...EMPTY_MESSAGES },
      schedule: { ...EMPTY_SCHEDULE },
      meeting: { ...NO_MEETING },
      lastTask: null,
      pinned: [],
      nudge: { ...EMPTY_NUDGE },
      settings: { ...this.state.settings, meetingGeneric: null },
    });
    this.reminderToast = null;
    this.meetingPicker = null;
    // The meetings list goes with the session (contract §23.5), and so do the account's dedupe marks (audit GO-I6).
    this.clearMeetings();
    if (account !== null) this.meetingStore.dropMarks(account);
    this.meetingSupport = { kind: 'unsupported' };
    this.meetingAccount = null;
    this.meetingPoll = FRESH_POLL;
    this.reconnectDismissed = false;
    this.queue.clear();
    this.dailyToast = null;
    this.nativeNotice = null;
    this.tasks = [];
    this.entries = null;
    this.me = null;
    this.clampNotes = [];
    this.meetingOpen = false;
    this.welcome = false;
    this.main?.prompt.dispose();
    this.main = null;
    this.query = '';
    this.section = 'tasks';
    this.selectedTaskId = null;
    this.error = null;
  }

  // ---- timer ------------------------------------------------------------------------------------------------------

  async refresh(): Promise<void> {
    // During a re-sign-in the old token is already gone: nothing to refresh until it ends.
    if (this.reconsent) return;
    await this.guard(() => this.load(this.api()));
  }

  private async load(api: TimeTrackApi): Promise<void> {
    if (this.queue.size > 0) {
      const me = await api.me();
      this.setMe(me);
      this.report(await this.queue.sync(api, this.now, serverFeatures(me)), true);
    }
    const [timer, tasks, me, entries] = await Promise.all([api.timer(), api.tasks({ search: this.query }), api.me(), this.loadEntries(api)]);
    this.offline = false;
    this.tasks = tasks;
    this.setMe(me);
    this.entries = entries;
    await this.setTimer(timer);
    // Start (or a refresh): today's meetings now, not at the next regular poll.
    await this.pollMeetings(true);
  }

  private setMe(me: Me): void {
    this.me = me;
    this.updateMeetingSupport(me);
    this.persist({ features: serverFeatures(me), schedule: { ...this.state.schedule, beacon: beaconPart(me) } });
    const minimum = isVersion(me.minSupportedVersion) ? me.minSupportedVersion : null;
    if (minimum !== this.meMinimum) {
      this.meMinimum = minimum;
      // A new minimum above this version forces the update (validated, never blocking without a way out).
      if (minimum !== null && updateRequired(this.version, minimum)) void this.checkUpdates();
    }
  }

  /** What the server can do: from `GET me`, else as last seen (offline start), else a 1.9 server. */
  features(): ServerFeatures {
    return this.me !== null ? serverFeatures(this.me) : (this.state.features ?? serverFeatures(null));
  }

  /** Tells the person what the replay did: count, dropped actions and every time the server moved (clamp). */
  private report(result: SyncResult, announceSynced: boolean): void {
    if (announceSynced && result.synced > 0) this.setNotice(this.t('synced', { count: result.synced }));
    if (result.dropped.length > 0) this.setNotice(this.t('dropped', { count: result.dropped.length }));
    if (result.clamps.length > 0) this.clampNotes = [...this.clampNotes, ...result.clamps].slice(-5);
  }

  /**
   * Runs actions through the queue (idle-check decisions, auto-stop, gap answers): sent now when online, else kept and
   * replayed in order later; the screen shows their effect meanwhile.
   */
  private async runActions(actions: QueuedAction[]): Promise<void> {
    if (actions.length === 0) return;
    const before = this.state.activeTimer;
    this.queue.push(...actions);
    await this.guard(
      async () => {
        const result = await this.queue.sync(this.api(), this.now, this.features());
        this.offline = false;
        this.report(result, false);
        if (result.timer !== undefined) await this.setTimer(result.timer);
      },
      () => this.setTimer(applyLocally(before, actions)),
    );
    if (this.entries !== null) await this.reloadEntries();
  }

  /** Takes the pending "meeting" note (sent with the stop or switch that closes the entry). */
  private takeNote(): string | undefined {
    const note = this.state.pendingNote ?? undefined;
    if (note !== undefined) this.persist({ pendingNote: null });
    return note;
  }

  /** This week's own entries (newest first), or `null` when the token cannot read entries. Pages until done. */
  private async loadEntries(api: TimeTrackApi): Promise<Entry[] | null> {
    const from = startOfWeek(this.now());
    const result: Entry[] = [];
    try {
      for (let page = 0; page < MAX_ENTRY_PAGES; page++) {
        const { entries, limit } = await api.entries({ from, to: this.now(), offset: page * 100 });
        result.push(...entries.filter((entry) => Date.parse(entry.endedAt) >= from.getTime()));
        if (entries.length < limit) break;
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
    return result;
  }

  async search(query: string): Promise<void> {
    this.query = query;
    await this.guard(async () => {
      this.tasks = await this.api().tasks({ search: query });
    });
    if (this.view === 'main' && query.trim() !== '' && this.query === query) this.announce(this.t('resultsCount', { count: this.visibleTasks().length }));
  }

  /** Starts `task` (switching from the running timer). `meeting`: *Track the meeting* (metadata origin, 1.14 servers). */
  async start(task: Task, options: { meeting?: boolean } = {}): Promise<void> {
    const running = this.state.activeTimer;
    this.welcome = false;
    if (running !== null) this.persist({ messages: afterStop(this.state.messages, this.timerKind(running), running.startedAt, this.now()) });
    this.persist({ lastTask: this.taskRef(task) });
    await this.guard(
      async () => {
        const api = this.api();
        const meeting = options.meeting === true && this.me?.features?.meetings === true;
        await this.setTimer(running !== null ? (await api.switchTask(task.id, this.state.pendingNote ?? undefined, { meeting })).timer : await api.start(task.id));
        if (running !== null) this.takeNote();
      },
      () => {
        const at = this.now().toISOString();
        const note = running !== null ? this.takeNote() : undefined;
        if (note !== undefined) {
          this.queue.push({ kind: 'stop', at, note }, { kind: 'start', taskId: task.id, taskTitle: task.title, at });
        } else if (running !== null) {
          this.queue.push({ kind: 'switch', taskId: task.id, taskTitle: task.title, at });
        } else {
          this.queue.push({ kind: 'start', taskId: task.id, taskTitle: task.title, at });
        }
        return this.setTimer({ id: 'offline', taskId: task.id, taskTitle: task.title, startedAt: at, url: task.url ?? null });
      },
      () => ({ stage: 'action', task: task.title }),
    );
    if (this.entries !== null && running !== null) await this.reloadEntries();
  }

  async stop(): Promise<void> {
    const timer = this.state.activeTimer;
    if (timer === null) return;
    this.persist({ lastTask: this.taskRef(this.timerTask(timer)) });
    let queued = false;
    await this.guard(
      async () => {
        await this.api().stop(this.state.pendingNote ?? undefined);
        this.takeNote();
        await this.setTimer(null);
      },
      () => {
        queued = true;
        const note = this.takeNote();
        this.queue.push({ kind: 'stop', at: this.now().toISOString(), ...(note !== undefined ? { note } : {}) });
        return this.setTimer(null);
      },
    );
    if (this.state.activeTimer === null && this.error === null) this.saved(timer, queued);
    if (this.entries !== null) await this.reloadEntries();
  }

  /** Success moment after a stop: what was saved, in one of a few friendly wordings (queued: kept here for now). */
  private saved(timer: Timer, queued: boolean): void {
    const params = { time: formatHoursMinutes(elapsedSeconds(timer.startedAt, this.now())), task: timer.taskTitle };
    this.setNotice(queued ? this.t('savedOffline', params) : this.t(variant(SAVED_VARIANTS, this.saves++), params), 'saved');
    const kind = this.timerKind(timer);
    const messages = afterStop(this.state.messages, kind, timer.startedAt, this.now());
    const locale = this.messageLocale();
    const daily = kind === 'daily' && !pausedAt(messages, this.now()) ? pickDailyDone(messages, locale, this.random, this.switches()) : null;
    this.persist({ messages: daily?.state ?? messages });
    if (daily !== null) {
      const toast = { text: daily.line.text, pose: daily.line.pose, locale };
      // A desktop notification when the OS shows them, else (or until it answers) the toast in the window.
      if (this.nativeGranted()) {
        void this.sendNative('dailyDone', toast.text, toast.pose, locale).then((ok) => void (ok || this.showDailyToast(toast)));
      } else {
        this.showDailyToast(toast);
        if (this.nativeUsable()) void this.sendNative('dailyDone', toast.text, toast.pose, locale).then((ok) => void (ok && this.showDailyToast(null)));
      }
    }
  }

  private showDailyToast(toast: { text: string; pose: PoseId; locale: string } | null): void {
    this.dailyToast = toast;
    if (this.dailyTimer !== null) clearTimeout(this.dailyTimer);
    this.dailyTimer = toast === null ? null : setTimeout(() => this.showDailyToast(null), DAILY_TOAST_MS);
    this.render();
  }

  /** Meeting-like kind of a timer's task (daily, meeting, technical session, training), from Beacon's data or its name. */
  timerKind(timer: Pick<Timer, 'taskId' | 'taskTitle'>): TaskKind | null {
    return taskKind({ ...(this.findTask(timer.taskId) ?? {}), taskTitle: timer.taskTitle }, this.messageLocale());
  }

  /** Whether a meeting-like task is running, or a call goes on (softer "Still in the meeting?", longer countdown). */
  inMeeting(): boolean {
    if (this.meetingOn() && inCall(this.state.meeting)) return true;
    const timer = this.state.activeTimer;
    const state = this.state.idleCheck;
    if (timer !== null) return this.timerKind(timer) !== null;
    return state.phase !== 'watching' && this.timerKind({ taskId: state.taskId, taskTitle: state.taskTitle }) !== null;
  }

  /** The running entry has been on the clock for `LONG_RUNNING_HOURS` or more and nobody said "Keep going". */
  longRunning(): boolean {
    const timer = this.state.activeTimer;
    if (timer === null || this.longRunningOk === this.entryKey(timer)) return false;
    return elapsedSeconds(timer.startedAt, this.now()) >= LONG_RUNNING_HOURS * 3600;
  }

  private entryKey(timer: Timer): string {
    return `${timer.taskId}@${timer.startedAt}`;
  }

  keepGoing(): void {
    const timer = this.state.activeTimer;
    if (timer !== null) this.longRunningOk = this.entryKey(timer);
    this.render();
    this.main?.root.querySelector<HTMLButtonElement>('#stop')?.focus();
  }

  // ---- Friendly messages (local only) -----------------------------------------------------------------------------

  /** Language of the friendly messages: the Beacon user's (`GET me.locale`), else the app's, else English. */
  messageLocale(): ReturnType<typeof messageLocale> {
    return messageLocale(beaconLocale(this.me), this.locale);
  }

  private switches(): Switches {
    return { fun: this.state.settings.funMessages, wellbeing: this.state.settings.wellbeingReminders };
  }

  /**
   * The cheer / time-of-day card of the running timer, when one is due (called on every tick, also while the window
   * is hidden or shows another view). It goes out as a desktop notification when the OS shows them, else as a toast
   * in the window; never takes focus.
   */
  checkFriendly(): void {
    const timer = this.state.activeTimer;
    if (this.state.session === null || this.view === 'update-required') return;
    const shown = this.toastRegion.querySelector('#cheer') !== null;
    const card = this.currentCard();
    // One at a time: a card shown as a desktop notification is not "visible" here, but the rate limit of nextCard
    // (MIN_GAP_MINUTES, longer than a card lives) keeps the next one away.
    if (timer !== null && card === null && this.state.idleCheck.phase === 'watching' && !this.longRunning()) {
      const locale = this.messageLocale();
      const next = nextCard({
        now: this.now(),
        startedAt: timer.startedAt,
        entry: this.entryKey(timer),
        switches: this.switches(),
        windows: CATALOG[locale].windows,
        timeZone: beaconTimeZone(this.me),
        state: this.state.messages,
        locale,
        rng: this.random,
      });
      if (next !== null) {
        const desktop = this.nativeGranted();
        this.persist({ messages: desktop ? { ...next.state, card: { ...next.card, delivered: 'desktop' } } : next.state });
        this.render();
        if (this.nativeUsable()) void this.deliverCard(next.card, timer);
        return;
      }
    }
    if (shown !== (this.currentCard() !== null)) this.render();
  }

  /** Sends `card` as a desktop notification; on failure it comes back as the toast (and the other way round). */
  private async deliverCard(card: Card, timer: Timer): Promise<void> {
    const line = lineText(card.locale, card.kind, card.line, { hours: Math.floor(elapsedSeconds(timer.startedAt, this.now()) / 3600) });
    if (line === null) return;
    const ok = await this.sendNative(card.kind, line.text, line.pose, card.locale);
    const current = this.state.messages.card;
    if (current === null || current.shownAt !== card.shownAt || current.entry !== card.entry) return;
    if (ok === (current.delivered === 'desktop')) return;
    this.persist({ messages: { ...this.state.messages, card: { ...current, delivered: ok ? 'desktop' : undefined } } });
    this.render();
  }

  /** Desktop notifications are on and the OS showed the last one. */
  private nativeGranted(): boolean {
    return this.state.settings.desktopNotifications && this.state.settings.nativeStatus === 'granted';
  }

  /** Desktop notifications are on and may work (granted, or not asked yet). */
  private nativeUsable(): boolean {
    return this.state.settings.desktopNotifications && (this.state.settings.nativeStatus === 'granted' || this.state.settings.nativeStatus === 'unknown');
  }

  /**
   * A friendly message as a desktop notification. The first time, the OS permission is asked for (macOS prompts; the
   * others just allow it) and the window explains, once, where the messages went; a refusal or a missing notification
   * service is remembered (Settings says so) and the messages stay inside the app.
   */
  async sendNative(kind: NoticeKind, text: string, pose: PoseId, locale: ReturnType<typeof messageLocale>): Promise<boolean> {
    return this.sendNativeNote({ title: noticeTitle(locale, kind), body: text, pose });
  }

  /** `sendNative` for a ready note (title, body, pose and an optional button). */
  async sendNativeNote(note: FriendlyNotification): Promise<boolean> {
    const before = this.state.settings.nativeStatus;
    let status = before;
    if (status !== 'granted') {
      let permission = await this.platform.notificationPermission();
      if (permission === 'prompt') permission = await this.platform.requestNotificationPermission();
      status = permission === 'granted' ? 'granted' : permission === 'unsupported' ? 'unsupported' : 'denied';
    }
    const ok = status === 'granted' && (await this.platform.notifyFriendly(note));
    if (status === 'granted' && !ok) status = 'failed';
    const intro = ok && !this.state.settings.nativeIntroSeen;
    if (status !== this.state.settings.nativeStatus || intro) {
      this.persist({ settings: { ...this.state.settings, nativeStatus: status, nativeIntroSeen: this.state.settings.nativeIntroSeen || intro } });
    }
    const notice = intro ? 'intro' : !ok && (status === 'denied' || status === 'failed') && status !== before ? 'off' : null;
    if (notice !== null) {
      this.nativeNotice = notice;
      this.render();
    }
    return ok;
  }

  dismissNativeNotice(): void {
    this.nativeNotice = null;
    this.render();
  }

  /** Settings → Friendly messages → "Show them as desktop notifications" (a new try asks the OS again). */
  setDesktopNotifications(on: boolean): void {
    const status = this.state.settings.nativeStatus;
    this.persist({ settings: { ...this.state.settings, desktopNotifications: on, nativeStatus: on && status !== 'unsupported' ? 'unknown' : status } });
    this.nativeNotice = null;
    this.render();
  }

  /** Tray / Settings: pause the friendly messages for an hour, or resume them. */
  async pauseFriendly(pause: boolean): Promise<void> {
    this.persist({ messages: pause ? pauseMessages(this.state.messages, this.now()) : resumeMessages(this.state.messages) });
    this.render();
    await this.updateTray();
  }

  /** The card to show now: one at a time, not over the "Still there?" prompt or the long-running nudge. */
  currentCard(): Card | null {
    const timer = this.state.activeTimer;
    if (this.state.idleCheck.phase !== 'watching' || this.longRunning()) return null;
    return visibleCard(this.state.messages, timer !== null ? this.entryKey(timer) : null, this.now(), this.switches());
  }

  dismissCheer(): void {
    const card = this.state.messages.card;
    if (card !== null) this.persist({ messages: { ...this.state.messages, card: { ...card, dismissed: true } } });
    this.render();
    this.main?.root.querySelector<HTMLButtonElement>('#stop')?.focus();
  }

  // ---- Working-hours reminders (local only) -----------------------------------------------------------------------

  /** Beacon's week (live, else as last seen), the effective week with the local overrides, days off, time zone. */
  scheduleView(): { beacon: Week | null; merged: Merged; daysOff: DayOff[]; timeZone: string | null } {
    const source = this.me ?? this.state.schedule.beacon;
    const beacon = beaconWeek(source === null ? null : (source as { workingHours?: unknown }).workingHours);
    return {
      beacon,
      merged: mergeWeek(beacon, this.state.schedule.overrides),
      daysOff: allDaysOff(beaconDaysOff(source), this.state.schedule.daysOff),
      timeZone: beaconTimeZone(source),
    };
  }

  private remindersOn(): boolean {
    return this.state.session !== null && this.state.settings.scheduleReminders;
  }

  /** The next reminder instant for the host's wake-up (null with the reminders off). */
  private nextReminderAt(): number | null {
    if (!this.remindersOn()) return null;
    const view = this.scheduleView();
    return nextReminderAt({ now: this.now(), timeZone: view.timeZone, week: view.merged.week, daysOff: view.daysOff, leadMinutes: this.state.settings.scheduleLeadMinutes, seen: this.state.schedule.seen });
  }

  /**
   * On every tick: the working-hours reminder that is due (start, lunch, end of the day), or the one "working on a day
   * off?" line when a timer runs on a holiday. They follow their own switch and the pause, never the 50-minute gap
   * (they are functional), and set it for the cards that come after them. Not over the "Still there?" question.
   */
  checkReminders(): void {
    // A toast that expired (or whose button no longer applies) goes away on the next check.
    if (this.reminderToast !== null && this.visibleReminder() === null) this.showReminderToast(null);
    if (!this.remindersOn() || this.view === 'update-required') return;
    const now = this.now();
    if (pausedAt(this.state.messages, now) || this.state.idleCheck.phase !== 'watching') return;
    const view = this.scheduleView();
    const timer = this.state.activeTimer;
    const schedule = this.state.schedule;
    const today = zonedParts(now, view.timeZone).date;
    if (timer !== null && dayOffOn(today, view.daysOff) !== null && !schedule.seen.includes(`dayOff:${today}`)) {
      this.fireReminder('dayOff', `dayOff:${today}`, [], today);
      return;
    }
    const due = dueReminder({
      now,
      timeZone: view.timeZone,
      week: view.merged.week,
      daysOff: view.daysOff,
      leadMinutes: this.state.settings.scheduleLeadMinutes,
      running: timer !== null,
      hasLastTask: this.lastTask() !== null,
      seen: schedule.seen,
    });
    if (due.reminder !== null) this.fireReminder(due.reminder.kind, due.reminder.slot, due.skip, due.reminder.date);
    else if (due.skip.length > 0) this.persist({ schedule: { ...schedule, seen: markSeen(schedule.seen, due.skip) } });
  }

  private fireReminder(kind: ReminderLineKind, slot: string, skip: readonly string[], date: string): void {
    const now = this.now();
    const timer = this.state.activeTimer;
    const last = kind === 'start' || kind === 'lunchEnd' ? this.lastTask() : null;
    const total = kind === 'end' ? formatHoursMinutes(computeTotals(this.entries ?? [], timer, now).today) : null;
    const { note, state } = composeReminder({ kind, slot, locale: this.messageLocale(), state: this.state.schedule, rng: this.random, now, task: last?.title ?? null, total });
    // The end-of-day reminder replaces that evening's "it's getting late" card.
    const messages = this.state.messages;
    const seen = kind === 'end' ? [...messages.seen, `lateWork:${date}`].slice(-40) : messages.seen;
    this.persist({ schedule: { ...state, seen: markSeen(state.seen, [...skip, slot]) }, messages: { ...messages, seen, lastShownAt: note.shownAt } });
    this.deliverReminder(note);
  }

  /** A desktop notification with the button when the OS shows them, else (or until it answers) the toast. */
  private deliverReminder(note: ReminderNote): void {
    const native: FriendlyNotification = {
      title: note.title,
      body: note.text,
      pose: note.pose,
      action: note.action !== null && note.actionLabel !== null ? { id: ACTION_IDS[note.action], label: note.actionLabel } : null,
    };
    if (this.nativeGranted()) {
      void this.sendNativeNote(native).then((ok) => void (ok || this.showReminderToast(note)));
    } else {
      this.showReminderToast(note);
      if (this.nativeUsable()) void this.sendNativeNote(native).then((ok) => void (ok && this.reminderToast === note && this.showReminderToast(null)));
    }
  }

  showReminderToast(note: ReminderNote | null): void {
    this.reminderToast = note;
    this.render();
  }

  /** Whether the reminder's button still makes sense (Start / Resume with no timer, Stop with one). */
  reminderActionable(note: ReminderNote): boolean {
    if (note.action === null) return false;
    return note.action === 'stop' ? this.state.activeTimer !== null : this.state.activeTimer === null && this.lastTask() !== null;
  }

  /** The reminder toast to show: not expired, and not a Start / Stop whose moment has passed. */
  visibleReminder(): ReminderNote | null {
    const note = this.reminderToast;
    if (note === null || this.now().getTime() - Date.parse(note.shownAt) >= CARD_TTL_MINUTES * 60_000) return null;
    return note.action === null || this.reminderActionable(note) ? note : null;
  }

  /** A reminder's button (toast or notification): Start / Resume the last task, or Stop the timer. */
  async reminderAction(action: ReminderAction | null): Promise<void> {
    if (action === null || this.state.session === null) return;
    this.reminderToast = null;
    if (action === 'stop') {
      if (this.state.activeTimer !== null) await this.stop();
    } else {
      await this.resume();
    }
    this.render();
  }

  // ---- Meeting detection (opt-in, local only) ---------------------------------------------------------------------

  /** Signed in and the person turned meeting detection on (dated consent). */
  meetingOn(): boolean {
    return this.state.session !== null && hasConsent(this.state, 'meetingDetection');
  }

  /**
   * No meeting question now: friendly messages paused (the app's "do not disturb"), the "Still there?" question open,
   * or no timer running outside the working day (Settings → My schedule, days off). A running timer means work.
   */
  private meetingQuiet(): boolean {
    const now = this.now();
    if (this.view === 'update-required' || pausedAt(this.state.messages, now) || this.state.idleCheck.phase !== 'watching') return true;
    if (this.state.activeTimer !== null) return false;
    const view = this.scheduleView();
    const today = zonedParts(now, view.timeZone);
    return !withinWorkingDay(view.merged.week[today.day as Weekday], today.minute, dayOffOn(today.date, view.daysOff) !== null);
  }

  /** A `mic` report of the host: moves the call along and shows (or takes away) the question. */
  onMic(raw: unknown): void {
    const signal = parseMicSignal(raw);
    if (signal === null || !this.meetingOn()) return;
    this.micSignal = signal;
    const timer = this.state.activeTimer;
    const running = timer === null ? null : { id: timer.taskId, title: timer.taskTitle, meeting: this.timerKind(timer) !== null };
    const settings = this.state.settings;
    let step = observeMic(this.state.meeting, signal, { minMinutes: settings.meetingMinMinutes, muted: settings.meetingMuted, running, quiet: this.meetingQuiet() });
    // A reminded meeting starts around now: its reminder / start prompt is the one question (Q-O20).
    if (step.effect === 'ask' && this.meetingRemindersOn() && coveredByReminder(this.meetings, this.meetingMarks, signal.at)) step = { state: ignoreCall(step.state), effect: 'none' };
    const changed = step.state !== this.state.meeting;
    if (changed) this.persist({ meeting: step.state });
    if (step.effect === 'clear') this.meetingPicker = null;
    if (step.effect === 'ask' || step.effect === 'ended') this.deliverMeeting();
    // Every 20 s: only the status line of Settings changes (a full render would reset what is being typed there).
    if (changed || step.effect !== 'none') this.render();
    else this.body.querySelector('#meeting-status')?.replaceChildren(meetingStatus(this.t, signal, this.messageLocale()));
  }

  /** The open meeting question ("Which meeting is it?" or "Meeting over. Back to …?"), or null. */
  meetingNote(): MeetingNote | null {
    const state = this.state.meeting;
    if (!this.meetingOn()) return null;
    const locale = this.messageLocale();
    if (state.phase === 'asking' && state.app !== null) {
      const timer = this.state.activeTimer;
      const running = timer !== null && this.timerKind(timer) === null ? { id: timer.taskId, title: timer.taskTitle } : null;
      return askNote(locale, state.app, running, this.state.settings.meetingGeneric);
    }
    return state.phase === 'ended' ? endedNote(locale, callMinutes(state), state.previous) : null;
  }

  /**
   * The question goes to the window (a toast with every answer) and, when the OS shows them, as a desktop notification
   * with the pose and one button (a click on it opens the window). It sets the friendly messages' gap, like a reminder.
   */
  private deliverMeeting(): void {
    const note = this.meetingNote();
    if (note === null) return;
    this.persist({ messages: { ...this.state.messages, lastShownAt: this.now().toISOString() } });
    this.announce(note.text);
    if (!this.nativeUsable()) return;
    const id = note.native !== null ? MEETING_ACTION_IDS[note.native] : undefined;
    void this.sendNativeNote({ title: note.title, body: note.text, pose: note.pose, action: note.native !== null && id !== undefined ? { id, label: note.labels[note.native] } : null });
  }

  /** An answer to the meeting question (window or notification button). Answers that no longer apply are ignored. */
  async meetingAction(action: MeetingAction | null): Promise<void> {
    const note = this.meetingNote();
    if (action === null || note === null || !note.actions.includes(action)) return;
    const state = this.state.meeting;
    const generic = this.state.settings.meetingGeneric;
    if (action === 'choose' || ((action === 'generic' || action === 'switch') && generic === null)) {
      this.meetingPicker = action === 'choose' ? 'task' : 'generic';
      this.meetingQuery = '';
    } else if (action === 'generic' || action === 'switch') {
      await this.startMeeting(generic as TaskRef);
    } else if (action === 'notMeeting' || action === 'mute') {
      if (action === 'mute' && state.app !== null) this.persist({ settings: { ...this.state.settings, meetingMuted: [...new Set([...this.state.settings.meetingMuted, state.app])] } });
      this.persist({ meeting: ignoreCall(state) });
      this.meetingPicker = null;
    } else {
      this.persist({ meeting: finishMeeting(state) });
      if (action === 'back' && state.previous !== null) await this.start(this.findTask(state.previous.id) ?? state.previous);
      else if (action === 'stop' && this.state.activeTimer !== null) await this.stop();
    }
    this.render();
  }

  /** × on the question: no more questions for this call (or the end question is closed). */
  dismissMeeting(): void {
    const state = this.state.meeting;
    this.persist({ meeting: state.phase === 'ended' ? finishMeeting(state) : ignoreCall(state) });
    this.meetingPicker = null;
    this.render();
  }

  /** Starts the meeting's task, switching from the running one (remembered for "Back to …"). */
  async startMeeting(task: TaskRef, asGeneric = false): Promise<void> {
    const timer = this.state.activeTimer;
    const previous = timer !== null && this.timerKind(timer) === null ? { id: timer.taskId, title: timer.taskTitle } : null;
    const ref = { id: task.id, title: task.title };
    this.meetingPicker = null;
    this.persist({ meeting: tracking(this.state.meeting, ref, previous), ...(asGeneric ? { settings: { ...this.state.settings, meetingGeneric: ref } } : {}) });
    if (timer?.taskId !== task.id) await this.start(this.findTask(task.id) ?? ref);
    this.render();
  }

  /** Tasks for "Choose task": search matches, else meeting-like tasks first, then pinned and recent. */
  meetingTasks(): Task[] {
    const known = [...this.tasks, ...this.state.pinned];
    if (this.meetingQuery.trim() !== '') return searchTasks(meetingCandidates([known], () => false, null, Number.MAX_SAFE_INTEGER), this.meetingQuery);
    const recents = this.entries !== null ? recentTasks(this.entries, this.tasks, 9) : [];
    return meetingCandidates([this.tasks.filter((task) => this.isMeetingTask(task)), this.state.pinned, recents, this.tasks], (task) => this.isMeetingTask(task), this.state.activeTimer?.taskId ?? null);
  }

  private isMeetingTask(task: Task): boolean {
    return taskKind(task, this.messageLocale()) !== null;
  }

  /** Meeting detection turned off: the call state and the last report go; the host stops looking. */
  private stopMeetingDetection(): void {
    this.persist({ meeting: { ...NO_MEETING } });
    this.micSignal = null;
    this.meetingPicker = null;
    this.render();
  }

  /** Settings → Meetings. */
  setMeetingSetting(patch: Partial<Pick<LocalState['settings'], 'meetingMinMinutes' | 'meetingGeneric' | 'meetingMuted'>>): void {
    this.persist({ settings: { ...this.state.settings, ...patch } });
    this.render();
  }

  // ---- Meeting reminders (contract §23, local only) ---------------------------------------------------------------

  /**
   * The signed-in account's key for its cache and dedupe marks: `sha256(server|identifier)`, never the e-mail itself
   * (contract §23.6, audit GO-I6). `null` until `prepareMeetingAccount` hashed the current account.
   */
  private meetingAccountKey(): string | null {
    const session = this.state.session;
    if (session === null) return null;
    return this.accountHash?.source === `${session.server}|${session.identifier}` ? this.accountHash.hash : null;
  }

  /** Hashes the signed-in account's key (once per account), before its reminders load. */
  private async prepareMeetingAccount(): Promise<void> {
    const session = this.state.session;
    if (session === null) return;
    const source = `${session.server}|${session.identifier}`;
    if (this.accountHash?.source !== source) this.accountHash = { source, hash: await sha256Hex(source) };
  }

  /** Loads the signed-in account's store (cached list, marks) when the account changes. */
  private syncMeetingAccount(): void {
    const account = this.meetingAccountKey();
    if (account === this.meetingAccount) return;
    this.meetingAccount = account;
    this.meetingPoll = FRESH_POLL;
    this.meetingReminder = null;
    this.pausedForMeeting = null;
    const now = this.now().getTime();
    const cache = account === null ? null : this.meetingStore.cache(account, now);
    this.meetings = cache?.meetings ?? [];
    this.meetingsFetchedAt = cache === null ? null : Date.parse(cache.fetchedAt);
    this.meetingsExpireAt = cache === null ? null : Date.parse(cache.expiresAt);
    this.meetingMarks = account === null ? [] : this.meetingStore.marks(account, now);
    // Offline start: the cached list says the feature was on (GET me will say more once online).
    if (cache !== null && this.me === null) this.meetingSupport = { kind: 'on', status: cache.status, refreshAfterSeconds: cache.refreshAfterSeconds, calendarsUrl: null };
  }

  /** `GET me` changed what the server offers: a list that no longer applies goes, a stop is lifted when it is back. */
  private updateMeetingSupport(me: Me): void {
    this.syncMeetingAccount();
    this.meetingSupport = meetingSupport(me, this.state.session?.scopes ?? []);
    if (this.meetingSupport.kind === 'on') {
      if (this.meetingPoll.stopped !== null) this.meetingPoll = { ...this.meetingPoll, stopped: null };
    } else if (this.meetings.length > 0 || this.meetingsFetchedAt !== null) {
      this.clearMeetings();
    }
  }

  /** Reminders on: signed in, offered and allowed by the server, switched on here (by default with a calendar). */
  meetingRemindersOn(): boolean {
    return this.state.session !== null && this.meetingPoll.stopped === null && remindersEnabled(this.state.settings.meetingReminders, this.meetingSupport);
  }

  /** Drops the list (memory and local storage) and what is shown about it. */
  private clearMeetings(): void {
    this.meetings = [];
    this.meetingsFetchedAt = null;
    this.meetingsExpireAt = null;
    this.meetingReminder = null;
    this.meetingReminderPicker = null;
    this.pausedForMeeting = null;
    this.meetingStore.saveCache(null);
  }

  private saveMarks(marks: ReminderMark[]): void {
    this.meetingMarks = marks;
    if (this.meetingAccount !== null) this.meetingStore.saveMarks(this.meetingAccount, marks);
  }

  /** Working hours and days off of Settings → My schedule, read at any instant (rule 3). */
  private meetingGate(): ScheduleGate {
    const view = this.scheduleView();
    return {
      working: (at) => {
        const parts = zonedParts(new Date(at), view.timeZone);
        return withinWorkingDay(view.merged.week[parts.day as Weekday], parts.minute, false);
      },
      dayOff: (at) => dayOffOn(zonedParts(new Date(at), view.timeZone).date, view.daysOff) !== null,
    };
  }

  /** Start of the next working day's first slot after `now` (the fetch two hours before it), or null. */
  private nextWorkingStart(now: number): number | null {
    const view = this.scheduleView();
    const today = zonedParts(new Date(now), view.timeZone).date;
    for (let offset = 0; offset <= 7; offset++) {
      const date = addDays(today, offset);
      const plan = view.merged.week[weekdayOf(date)];
      if (plan.off || plan.start === null || dayOffOn(date, view.daysOff) !== null) continue;
      const at = zonedInstant(date, plan.start, view.timeZone).getTime();
      if (at > now) return at;
    }
    return null;
  }

  /** Fetches the meetings when due (contract §23.5): `force` on start, wake from sleep, network back, settings. */
  pollMeetings(force = false): Promise<void> {
    if (this.meetingsPolling === null) {
      this.meetingsPolling = this.runMeetingPoll(force).finally(() => {
        this.meetingsPolling = null;
      });
    }
    return this.meetingsPolling;
  }

  private async runMeetingPoll(force: boolean): Promise<void> {
    this.syncMeetingAccount();
    if (this.state.session === null || this.token === null) return;
    const now = this.now().getTime();
    const settings = this.state.settings;
    const support = this.meetingSupport;
    // Offered but nothing to fetch now (no calendar yet, stopped after a 403 / 404): GET me again now and then.
    const waiting = support.kind !== 'unsupported' && settings.meetingReminders !== false && (this.meetingPoll.stopped !== null || (support.kind === 'on' && support.status === 'not_connected'));
    if (waiting && now - this.meetingMeCheckAt >= RECHECK_ME_MINUTES * 60_000) {
      this.meetingMeCheckAt = now;
      try {
        this.setMe(await this.api().me());
      } catch {
        // The regular refresh will tell.
      }
    }
    const current = this.meetingSupport;
    if (!this.meetingRemindersOn() || current.kind !== 'on' || current.status === 'not_connected') return;
    const gate = this.meetingGate();
    const due = pollDue({ now, state: this.meetingPoll, refreshAfterSeconds: current.refreshAfterSeconds, force: force || this.meetingsForce, outsideHours: false, working: allowedAt(now, settings, gate), nextSlotStart: this.nextWorkingStart(now) });
    if (!due) return;
    this.meetingsForce = false;
    this.meetingPoll = pollStarted(this.meetingPoll, now);
    const view = this.scheduleView();
    // From 10 minutes ago (a meeting that just started) to the end of tomorrow, local time.
    const windowEnd = zonedInstant(addDays(zonedParts(new Date(now), view.timeZone).date, 2), '00:00', view.timeZone).getTime();
    try {
      const page = parseMeetingsPage(await this.api().meetings({ from: new Date(now - START_WINDOW_MINUTES * 60_000), to: new Date(windowEnd), tz: view.timeZone }));
      if (page === null) throw new ApiError(200, 'invalid_response', 'The server returned an invalid meetings list.');
      const meetings = await withKeys(page.meetings);
      const at = this.now().getTime();
      this.meetings = meetings;
      this.meetingsFetchedAt = at;
      this.meetingsExpireAt = cacheExpiry(at, windowEnd);
      this.meetingSupport = { ...current, status: page.status, refreshAfterSeconds: page.refreshAfterSeconds };
      this.meetingPoll = pollSucceeded(this.meetingPoll, at, this.random);
      if (this.meetingAccount !== null) {
        this.meetingStore.saveCache({ account: this.meetingAccount, fetchedAt: new Date(at).toISOString(), expiresAt: new Date(this.meetingsExpireAt).toISOString(), status: page.status, refreshAfterSeconds: page.refreshAfterSeconds, meetings });
      }
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(0, 'network_error', 'Network error.');
      const step = pollFailed(this.meetingPoll, this.now().getTime(), failure);
      this.meetingPoll = step.state;
      if (step.outcome === 'unauthorized') {
        await this.signedOut(this.t('sessionExpired'));
        return;
      }
      // 404: the feature went off (clear the list until GET me says otherwise); 403: Settings asks for the permission.
      if (step.outcome === 'off') this.clearMeetings();
    }
    this.render();
    void this.updateTray();
  }

  private planInput(now: number): PlanInput {
    return { now, meetings: this.meetings, marks: this.meetingMarks, settings: this.state.settings, gate: this.meetingGate(), runningTaskId: this.state.activeTimer?.taskId ?? null };
  }

  /** The next reminder, snooze or start, for the host's wake-up (null with the reminders off). */
  private nextMeetingAt(): number | null {
    return this.meetingRemindersOn() ? nextDueAt(this.planInput(this.now().getTime())) : null;
  }

  private noteContext(now: number): NoteContext {
    return { now, locale: this.messageLocale(), time: (at) => this.time(new Date(at)), stale: this.meetingsFetchedAt !== null && isStale({ fetchedAt: new Date(this.meetingsFetchedAt).toISOString() }, now) };
  }

  /**
   * On every check: fetch when due, drop an expired list, then the reminders that are due (one notification each, or
   * one grouped when more than three come at once) and the start prompt (or the automatic pause) of a meeting that
   * starts while a timer runs. Each fires once per meeting and start (dedupe store).
   */
  private async checkMeetings(): Promise<void> {
    if (this.state.session === null) return;
    await this.pollMeetings();
    const now = this.now().getTime();
    if (this.meetingsExpireAt !== null && now >= this.meetingsExpireAt) {
      this.clearMeetings();
      this.render();
      void this.updateTray();
    }
    if (this.meetingReminder !== null && now >= this.meetingReminderUntil) {
      this.meetingReminder = null;
      this.meetingReminderPicker = null;
      this.render();
    }
    if (!this.meetingRemindersOn() || this.view === 'update-required' || this.meetings.length === 0) return;
    const due = dueNow(this.planInput(now));
    if (due.reminders.length === 0 && due.starts.length === 0) return;
    const ctx = this.noteContext(now);
    let marks = this.meetingMarks;
    if (due.reminders.length > 0) {
      marks = fired(marks, due.reminders, now, { firedAt: new Date(now).toISOString(), snoozedUntil: null });
      this.saveMarks(marks);
      if (due.reminders.length > GROUP_OVER) {
        this.deliverMeetingNote(groupNote(due.reminders, ctx), Math.min(...due.reminders.map((meeting) => meeting.start)));
      } else {
        for (const meeting of due.reminders) this.deliverMeetingNote(reminderNote(meeting, ctx), meeting.start);
      }
    }
    const timer = this.state.activeTimer;
    const meeting = due.starts[0];
    if (meeting === undefined || timer === null) return;
    // One prompt per meeting start, even when several start at once (and even if microphone detection fires, Q-O20).
    this.saveMarks(fired(marks, due.starts, now, { prompted: true }));
    const until = meeting.start + START_WINDOW_MINUTES * 60_000;
    if (!this.state.settings.meetingAutoPause) {
      this.deliverMeetingNote(startNote(meeting, timer.taskTitle, ctx), until);
      return;
    }
    const task = this.timerTask(timer);
    await this.stop();
    if (this.state.activeTimer !== null) return;
    this.pausedForMeeting = { key: meeting.key, task };
    this.deliverMeetingNote(pausedNote(meeting, task.title, ctx), until);
  }

  /** In the window (a toast with every choice) and, when the OS shows them, as a desktop notification with ≤ 2 buttons. */
  private deliverMeetingNote(note: ReminderMeetingNote, visibleUntil: number): void {
    this.meetingReminder = note;
    this.meetingReminderUntil = Math.max(visibleUntil, this.now().getTime() + 60_000);
    this.meetingReminderPicker = null;
    this.announce(`${note.title}. ${note.body}`);
    if (this.nativeUsable()) void this.sendNativeNote({ title: note.title, body: note.body, pose: note.pose, actions: note.native });
    this.render();
  }

  meetingByShort(short: string | undefined): KeyedMeeting | undefined {
    return short === undefined ? undefined : this.meetings.find((meeting) => shortKey(meeting.key) === short);
  }

  /** *Join*: the link is checked again here (allow-list, §23.8) and opened in the "Open Beacon in" browser. */
  async joinMeeting(meeting: KeyedMeeting): Promise<void> {
    if (externalUrl(meeting.joinUrl, { kind: 'meeting' }) === null) {
      this.setNotice(this.t('meetingLinkRefused'));
      return;
    }
    await this.openExternal(meeting.joinUrl, { kind: 'meeting' });
    if (this.meetingReminder?.key === meeting.key && this.meetingReminder.kind === 'reminder') this.closeMeetingReminder();
  }

  closeMeetingReminder(): void {
    this.meetingReminder = null;
    this.meetingReminderPicker = null;
    this.render();
  }

  /** A choice on a reminder or start prompt (notification button, toast, prompt window). Stale answers are ignored. */
  async meetingReminderAction(kind: ReminderActionKind | 'dismiss', short: string | undefined, snooze: SnoozeChoice = 'default'): Promise<void> {
    if (kind === 'dismiss') return this.closeMeetingReminder();
    const meeting = this.meetingByShort(short);
    if (meeting === undefined || this.state.session === null) return;
    const shown = this.meetingReminder?.key === meeting.key;
    switch (kind) {
      case 'join':
        return this.joinMeeting(meeting);
      case 'snooze': {
        const until = snoozeUntil(meeting, this.now().getTime(), snooze);
        const mark = this.meetingMarks.find((item) => item.key === meeting.key);
        if (until !== null) this.saveMarks(putMark(this.meetingMarks, { key: meeting.key, start: new Date(meeting.start).toISOString(), firedAt: mark?.firedAt ?? null, snoozedUntil: new Date(until).toISOString(), prompted: mark?.prompted ?? false }));
        if (shown) this.closeMeetingReminder();
        this.syncWakePlan();
        return;
      }
      case 'keep':
        if (shown) this.closeMeetingReminder();
        return;
      case 'pause':
        if (shown) this.closeMeetingReminder();
        if (this.state.activeTimer !== null) await this.stop();
        return;
      case 'track': {
        const link = meeting.taskLinks[0];
        if (link === undefined) {
          // No linked task: pick one in the window (the host brought it forward).
          if (!shown) this.meetingReminder = startNote(meeting, this.state.activeTimer?.taskTitle ?? '', this.noteContext(this.now().getTime()));
          this.meetingReminderUntil = Math.max(this.meetingReminderUntil, this.now().getTime() + START_WINDOW_MINUTES * 60_000);
          this.meetingReminderPicker = { query: '' };
          this.render();
          return;
        }
        if (shown) this.closeMeetingReminder();
        await this.start(this.findTask(link.taskId) ?? { id: link.taskId, title: link.key }, { meeting: true });
        return;
      }
      case 'undo': {
        const paused = this.pausedForMeeting;
        if (paused === null || paused.key !== meeting.key) return;
        this.pausedForMeeting = null;
        if (shown) this.closeMeetingReminder();
        if (this.state.activeTimer === null) await this.start(paused.task);
        return;
      }
    }
  }

  /** *Track the meeting* → a task picked in the reminder toast. */
  async trackMeetingAs(task: Task): Promise<void> {
    this.closeMeetingReminder();
    await this.start(task, { meeting: true });
  }

  /** Today's remaining meetings (Today list and tray), in order. */
  todayMeetings(): KeyedMeeting[] {
    if (!this.meetingRemindersOn()) return [];
    const now = this.now();
    const view = this.scheduleView();
    const dayEnd = zonedInstant(addDays(zonedParts(now, view.timeZone).date, 1), '00:00', view.timeZone).getTime();
    return todayMeetings(this.meetings, now.getTime(), dayEnd);
  }

  /** The tray's "Today's meetings ▸" submenu (absent when there is none). */
  private trayMeetings(): Pick<TrayMenu, 'meetingsLabel' | 'meetings'> {
    const list = this.todayMeetings().slice(0, MAX_TRAY_MEETINGS);
    if (list.length === 0) return {};
    const locale = this.messageLocale();
    return { meetingsLabel: this.t('meetingsTodayTitle'), meetings: list.map((meeting) => ({ id: `meeting:${shortKey(meeting.key)}`, label: `${this.time(new Date(meeting.start))} ${meetingTitle(meeting, locale)}` })) };
  }

  /** Settings → Meeting reminders: the switch. On asks the OS for notifications (macOS: never at first launch). */
  async setMeetingReminders(on: boolean): Promise<void> {
    this.persist({ settings: { ...this.state.settings, meetingReminders: on } });
    if (!on) {
      this.clearMeetings();
      this.render();
      return;
    }
    this.render();
    if (this.state.settings.desktopNotifications) {
      try {
        if ((await this.platform.notificationPermission()) === 'prompt') {
          const answer = await this.platform.requestNotificationPermission();
          this.persist({ settings: { ...this.state.settings, nativeStatus: answer === 'granted' ? 'granted' : answer === 'unsupported' ? 'unsupported' : 'denied' } });
        }
      } catch {
        // Asked again with the first reminder.
      }
    }
    // Now, or at the first check the 60-second rule allows.
    this.meetingsForce = true;
    await this.pollMeetings(true);
    this.render();
  }

  /** Settings → Meeting reminders → lead time: a preset or a whole 1–120 ("Custom…"); 0 = not before the meeting. */
  setMeetingLead(minutes: number): void {
    if (!Number.isInteger(minutes) || (minutes !== 0 && (minutes < MIN_CUSTOM_LEAD || minutes > MAX_CUSTOM_LEAD))) {
      this.leadError = true;
      this.render();
      return;
    }
    this.leadError = false;
    // A preset typed in "Custom…" shows as that preset.
    this.customLead = !LEAD_PRESETS.includes(minutes);
    this.persist({ settings: { ...this.state.settings, meetingLeadMinutes: minutes } });
    this.render();
  }

  chooseCustomLead(): void {
    this.customLead = true;
    this.leadError = false;
    this.render();
    this.body.querySelector<HTMLInputElement>('#meeting-lead-custom')?.focus();
  }

  setReminderSetting(patch: Partial<Pick<LocalState['settings'], 'meetingOutsideHours' | 'meetingDaysOff' | 'meetingAskOnStart' | 'meetingAutoPause'>>): void {
    this.persist({ settings: { ...this.state.settings, ...patch } });
    // Outside hours or days off on: today's list may be due now.
    this.meetingsForce = true;
    this.render();
  }

  /**
   * "Sign in again to allow meeting reminders" (§23.7): a re-sign-in with `meetings:read` on top of the current scopes.
   * The host never replaces a stored token and keeps only the token of a sign-in the person confirmed (audit GM-L2,
   * GM-D-1), so this revokes the current session on the server (as sign-out does), deletes it locally, then signs in
   * again: the native "Sign in to <host>?" confirmation, then the device flow. The app's data stays while the new
   * sign-in runs; if it is declined, cancelled or fails, the person ends up signed out (the card says so).
   */
  async allowMeetings(): Promise<void> {
    const server = this.state.session?.server;
    if (server === undefined) return;
    this.persist({ settings: { ...this.state.settings, meetingConsentSeen: true } });
    this.reconsent = true;
    try {
      await this.api().logout();
    } catch {
      // Revoking never blocks the re-sign-in (as on sign-out).
    }
    await this.forgetToken();
    await this.connect(server);
  }

  dismissMeetingConsent(): void {
    this.persist({ settings: { ...this.state.settings, meetingConsentSeen: true } });
    this.render();
  }

  /** The re-consent card of the main window: once, while the server offers meetings and this sign-in lacks the scope. */
  private meetingConsentDue(): boolean {
    const needs = this.meetingSupport.kind === 'consent' || this.meetingPoll.stopped === 'scope';
    return this.state.session !== null && needs && this.state.settings.meetingReminders !== false && !this.state.settings.meetingConsentSeen;
  }

  /** Last update of an outdated list ("Last updated at 09:12: this list may be outdated."), else null. */
  private meetingsOutdated(): string | null {
    const at = this.meetingsFetchedAt;
    return at !== null && isStale({ fetchedAt: new Date(at).toISOString() }, this.now().getTime()) ? this.t('meetingsTodayOutdated', { time: this.time(new Date(at)) }) : null;
  }

  private renderMeetingBanners(): Child[] {
    const t = this.t;
    const support = this.meetingSupport;
    const today = this.meetingRemindersOn() ? this.todayMeetings() : [];
    const calendars = support.kind === 'on' ? support.calendarsUrl : null;
    return [
      this.meetingConsentDue() &&
        h(
          'section',
          { class: 'card meeting-consent', id: 'meeting-consent-card', attrs: { 'aria-labelledby': 'meeting-consent-title' } },
          h('h2', { id: 'meeting-consent-title' }, t('meetingRemindersConsentTitle')),
          h('p', { class: 'muted' }, t('meetingRemindersConsent')),
          h(
            'div',
            { class: 'row-actions' },
            h('button', { class: 'primary small', id: 'meeting-consent-allow', key: 'meeting-consent-allow', attrs: { type: 'button' }, on: { click: () => void this.allowMeetings() } }, t('meetingRemindersConsentButton')),
            h('button', { class: 'link', id: 'meeting-consent-later', key: 'meeting-consent-later', attrs: { type: 'button' }, on: { click: () => this.dismissMeetingConsent() } }, t('meetingRemindersConsentLater')),
          ),
        ),
      this.meetingRemindersOn() &&
        support.kind === 'on' &&
        support.status === 'needs_reconnect' &&
        !this.reconnectDismissed &&
        h(
          'section',
          { class: 'card meeting-reconnect', id: 'meeting-reconnect', attrs: { role: 'region', 'aria-label': t('meetingRemindersTitle') } },
          h('p', {}, t('meetingRemindersReconnect')),
          h(
            'div',
            { class: 'row-actions' },
            calendars !== null && h('button', { class: 'secondary small', id: 'meeting-reconnect-open', key: 'meeting-reconnect-open', attrs: { type: 'button' }, on: { click: () => void this.openExternal(calendars, this.beaconRule()) } }, t('meetingRemindersReconnectButton')),
            h('button', { class: 'link', id: 'meeting-reconnect-dismiss', key: 'meeting-reconnect-dismiss', attrs: { type: 'button' }, on: { click: () => { this.reconnectDismissed = true; this.render(); } } }, t('toastDismiss')),
          ),
        ),
      today.length > 0 &&
        renderTodayMeetings({ t, locale: this.messageLocale(), meetings: today, now: this.now().getTime(), time: (at) => this.time(new Date(at)), outdated: this.meetingsOutdated(), onJoin: (meeting) => void this.joinMeeting(meeting) }),
    ];
  }

  private renderMeetingReminderToast(note: ReminderMeetingNote): HTMLElement {
    const meeting = note.key === null ? undefined : this.meetings.find((item) => item.key === note.key);
    const short = meeting === undefined ? undefined : shortKey(meeting.key);
    const picker = this.meetingReminderPicker;
    const known = [...this.tasks, ...this.state.pinned];
    return renderReminderToast({
      t: this.t,
      note,
      joinable: meeting?.joinUrl != null,
      snoozes: meeting === undefined ? [] : snoozeChoices(meeting, this.now().getTime()),
      picker: picker === null ? null : { query: picker.query, tasks: picker.query.trim() === '' ? this.meetingTasks() : searchTasks(meetingCandidates([known], () => false, null, Number.MAX_SAFE_INTEGER), picker.query) },
      onJoin: () => void this.meetingReminderAction('join', short),
      onSnooze: (choice) => void this.meetingReminderAction('snooze', short, choice),
      onKeep: () => void this.meetingReminderAction('keep', short),
      onPause: () => void this.meetingReminderAction('pause', short),
      onTrack: () => void this.meetingReminderAction('track', short),
      onUndo: () => void this.meetingReminderAction('undo', short),
      onPick: (task) => void this.trackMeetingAs(task),
      onQuery: (query) => {
        this.meetingReminderPicker = { query };
        this.render();
      },
      onDismiss: () => this.closeMeetingReminder(),
    });
  }

  /**
   * Without desktop notifications (refused, failing, turned off) the reminder also goes to the always-on-top prompt
   * window when the host has one (contract §23.4 / §23.7), after any "Still there?" question.
   */
  private meetingPromptView(): PromptView | null {
    const note = this.meetingReminder;
    if (note === null || note.kind === 'group' || !this.promptInWindow() || this.nativeUsable()) return null;
    const meeting = this.meetings.find((item) => item.key === note.key);
    if (meeting === undefined) return null;
    const t = this.t;
    const labels = MEETING_REMINDERS[note.locale].actions;
    const short = shortKey(meeting.key);
    const button = (id: string, label: string, style: PromptButton['style'], action: PromptButton['action']): PromptButton => ({ kind: 'button', id, label, style, action, meeting: short });
    const snoozes = snoozeChoices(meeting, this.now().getTime());
    const items: PromptButton[] =
      note.kind === 'reminder'
        ? [
            ...(meeting.joinUrl !== null ? [button('meeting-prompt-join', labels.join, 'primary', 'meeting-join')] : []),
            ...(snoozes.includes('default') ? [button('meeting-prompt-snooze', labels.snooze, 'secondary', 'meeting-snooze')] : []),
            ...(snoozes.includes(1) ? [button('meeting-prompt-snooze-1', labels.snooze1, 'ghost', 'meeting-snooze-1')] : []),
            ...(snoozes.includes(5) ? [button('meeting-prompt-snooze-5', labels.snooze5, 'ghost', 'meeting-snooze-5')] : []),
          ]
        : note.kind === 'start'
          ? [button('meeting-prompt-track', labels.track, 'primary', 'meeting-track'), button('meeting-prompt-pause', labels.pause, 'secondary', 'meeting-pause'), button('meeting-prompt-keep', labels.keep, 'ghost', 'meeting-keep')]
          : [];
    return {
      id: 'meeting-prompt',
      moment: 'about',
      pose: note.pose,
      title: note.title,
      blocks: [
        { kind: 'text', id: 'meeting-prompt-text', text: note.body, lang: note.locale },
        { kind: 'choices', layout: 'row', items: [...items, button('meeting-prompt-dismiss', labels.dismiss, 'link', 'meeting-dismiss')] },
      ],
      windowTitle: t('meetingReminderLabel'),
      lang: this.locale,
      theme: forcedTheme(this.state.settings.theme),
      escapeHint: t('promptEscapeHint'),
      openApp: t('promptOpenApp'),
      focus: null,
      focusSeq: 0,
    };
  }

  /** Settings → Meeting reminders (`ui/meetingReminders.ts`). */
  private renderReminderSettings(): HTMLElement {
    const settings = this.state.settings;
    const support = this.meetingSupport;
    return renderReminderSettings({
      t: this.t,
      support,
      stopped: this.meetingPoll.stopped,
      enabled: this.meetingRemindersOn(),
      settings,
      notificationsOff: settings.nativeStatus === 'denied' || !settings.desktopNotifications,
      customLead: this.customLead,
      leadError: this.leadError,
      onToggle: (on) => void this.setMeetingReminders(on),
      onLead: (minutes) => this.setMeetingLead(minutes),
      onCustomLead: () => this.chooseCustomLead(),
      onSetting: (patch) => this.setReminderSetting(patch),
      onConsent: () => void this.allowMeetings(),
      onOpenCalendars: (url) => void this.openExternal(url, this.beaconRule()),
    });
  }

  /** Settings → My schedule: one value of one day (a value equal to Beacon's drops the override). */
  setScheduleField(day: Weekday, name: DayField, value: boolean | string | null): void {
    const overrides = setOverride(this.state.schedule.overrides, this.scheduleView().beacon, day, name, value);
    this.persist({ schedule: { ...this.state.schedule, overrides } });
    this.render();
  }

  /** "Reset to Beacon's schedule": drops every local value of the week (days off stay). */
  resetSchedule(): void {
    this.persist({ schedule: { ...this.state.schedule, overrides: {} } });
    this.render();
  }

  setScheduleSetting(patch: Partial<Pick<LocalState['settings'], 'scheduleReminders' | 'scheduleLeadMinutes'>>): void {
    this.persist({ settings: { ...this.state.settings, ...patch } });
    this.render();
  }

  /** Marks (or unmarks) a local day off. */
  setLocalDayOff(date: string, on: boolean): void {
    const today = zonedParts(this.now(), this.scheduleView().timeZone).date;
    this.persist({ schedule: { ...this.state.schedule, daysOff: toggleLocalDayOff(this.state.schedule.daysOff, date, on, today) } });
    if (on) this.dayOffDraft = '';
    this.render();
  }

  /** Settings → Friendly messages. */
  setFriendly(setting: 'funMessages' | 'wellbeingReminders', on: boolean): void {
    this.persist({ settings: { ...this.state.settings, [setting]: on } });
    this.render();
  }

  dismissWelcome(): void {
    this.welcome = false;
    this.render();
    this.main?.search.focus();
  }

  /** Settings → Appearance: applies and stores the theme, and hands it to the native window (title bar). */
  async setTheme(theme: ThemePreference): Promise<void> {
    this.persist({ settings: { ...this.state.settings, theme } });
    applyTheme(theme);
    this.render();
    await this.syncWindowTheme();
  }

  private async syncWindowTheme(): Promise<void> {
    try {
      await this.platform.setWindowTheme(forcedTheme(this.state.settings.theme));
    } catch {
      // Older webviews / platforms without a themable title bar: the page itself is themed anyway.
    }
  }

  /** Starts the last task again ("Resume"). */
  async resume(): Promise<void> {
    const last = this.lastTask();
    if (last !== null && this.state.activeTimer === null) await this.start(last);
  }

  /** Stop when running, resume the last task otherwise (`Ctrl/⌘+Shift+S`, tray). */
  async toggle(): Promise<void> {
    if (this.state.activeTimer !== null) await this.stop();
    else await this.resume();
  }

  private async reloadEntries(): Promise<void> {
    try {
      this.entries = await this.loadEntries(this.api());
    } catch {
      // Totals are informative: keep the previous ones.
    }
    this.render();
    await this.updateTray();
  }

  private async setTimer(timer: Timer | null): Promise<void> {
    const previous = this.state.activeTimer;
    // A different entry (stopped or started elsewhere): a pending "meeting" note no longer applies.
    const changed = previous !== null && (timer === null || timer.taskId !== previous.taskId);
    this.persist({ activeTimer: timer, ...(changed && this.state.pendingNote !== null ? { pendingNote: null } : {}) });
    await this.updateTray();
    // "Update after I stop": the person chose it, the timer is now stopped.
    if (timer === null && this.updateStage === 'after-stop') void this.installUpdate();
  }

  /** Stores the parts of a task needed to show and resume it. */
  private taskRef(task: Task): Task {
    return { id: task.id, title: task.title, boardId: task.boardId ?? null, boardTitle: task.boardTitle ?? null, projectTitle: task.projectTitle ?? null, url: task.url ?? null };
  }

  /** The running timer as a task, with the context (board, project, url) of the same task in the list if known. */
  private timerTask(timer: Timer): Task {
    const known = this.findTask(timer.taskId);
    return {
      id: timer.taskId,
      title: timer.taskTitle,
      boardId: timer.boardId ?? known?.boardId ?? null,
      boardTitle: timer.boardTitle ?? known?.boardTitle ?? null,
      projectTitle: timer.projectTitle ?? known?.projectTitle ?? null,
      url: timer.url ?? known?.url ?? null,
    };
  }

  private findTask(id: string): Task | undefined {
    return this.tasks.find((task) => task.id === id) ?? this.state.pinned.find((task) => task.id === id) ?? (this.state.lastTask?.id === id ? this.state.lastTask : undefined);
  }

  /** The task "Resume" starts: the last one tracked here, else the newest entry. */
  lastTask(): Task | null {
    const recent = this.entries !== null ? recentTasks(this.entries, this.tasks, 1)[0] : undefined;
    const last = this.state.lastTask ?? recent ?? null;
    return last !== null ? { ...this.findTask(last.id), ...last } : null;
  }

  /** Pinned first, then recent tasks (entries of the week), never the running task; at most 9 (`Alt+1…9`). */
  quickTasks(): Task[] {
    const running = this.state.activeTimer?.taskId;
    const result: Task[] = [];
    const seen = new Set<string>();
    const recents = this.entries !== null ? recentTasks(this.entries, this.tasks, MAX_PINNED * 2) : [];
    for (const task of [...this.state.pinned, ...recents]) {
      if (task.id === running || seen.has(task.id)) continue;
      seen.add(task.id);
      result.push({ ...task, ...this.tasks.find((known) => known.id === task.id) });
      if (result.length >= MAX_PINNED) break;
    }
    return result;
  }

  /** Server tasks for the list: without the running task and (with no query) without the quick ones. */
  visibleTasks(): Task[] {
    const running = this.state.activeTimer?.taskId;
    const quick = this.query.trim() === '' ? new Set(this.quickTasks().map((task) => task.id)) : new Set<string>();
    return this.tasks.filter((task) => task.id !== running && !quick.has(task.id));
  }

  isPinned(taskId: string): boolean {
    return this.state.pinned.some((task) => task.id === taskId);
  }

  togglePin(task: Task): void {
    const pinned = this.isPinned(task.id)
      ? this.state.pinned.filter((item) => item.id !== task.id)
      : [...this.state.pinned, this.taskRef(task)].slice(-MAX_PINNED);
    this.persist({ pinned });
    this.render();
    void this.updateTray();
  }

  totals(): Totals | null {
    return this.entries === null ? null : computeTotals(this.entries, this.state.activeTimer, this.now());
  }

  // ---- tray -------------------------------------------------------------------------------------------------------

  /** Tray title (`H:MM task`), tooltip and status line; the translated menu is sent only when it changes. */
  async updateTray(): Promise<void> {
    const t = this.t;
    const timer = this.state.activeTimer;
    const today = formatHoursMinutes(this.totals()?.today ?? 0);
    if (timer !== null) {
      const time = formatHoursMinutes(elapsedSeconds(timer.startedAt, this.now()));
      const short = timer.taskTitle.length > 20 ? `${timer.taskTitle.slice(0, 19)}…` : timer.taskTitle;
      const startedAt = Date.parse(timer.startedAt);
      const elapsed = elapsedSeconds(timer.startedAt, this.now());
      await this.platform.setTray({
        title: `${time} ${short}`,
        tooltip: t('trayTooltipRunning', { task: timer.taskTitle, time, today }),
        status: `● ${time} · ${timer.taskTitle}`,
        running: true,
        // The host refreshes the elapsed time every minute by itself (menu-bar title on macOS, tooltip everywhere).
        clock: Number.isNaN(startedAt)
          ? null
          : { startedAt, title: `{time} ${short}`, tooltip: t('trayTooltipRunning', { task: timer.taskTitle, time: '{time}', today: '{today}' }), todayBaseSeconds: (this.totals()?.today ?? 0) - elapsed },
      });
    } else {
      await this.platform.setTray({
        title: null,
        tooltip: t('trayTooltipIdle', { today }),
        status: t('trayNotTracking'),
        running: false,
        clock: null,
      });
    }
    const signedIn = this.state.session !== null;
    const last = this.lastTask();
    const server = this.state.session?.server;
    const menu: TrayMenu = {
      primary: !signedIn ? null : timer !== null ? { id: 'stop', label: t('trayStop') } : last !== null ? { id: 'resume', label: t('trayResume', { task: last.title }) } : null,
      switchLabel: t('traySwitch'),
      switchTo: signedIn ? this.quickTasks().slice(0, MAX_TRAY_TASKS).map((task) => ({ id: `switch:${task.id}`, label: task.title })) : [],
      search: t('traySearch'),
      open: t('trayOpen'),
      layout: signedIn ? { id: `layout-${otherMode(this.layout)}`, label: t(this.layout === 'full' ? 'layoutCompact' : 'layoutFull') } : null,
      openBeacon: dashboardUrl(server) !== null ? t('openBeacon') : null,
      myTime: myTimeUrl(server) !== null ? t('myTime') : null,
      checkUpdates: signedIn && this.channel === 'direct' ? t('trayCheckUpdates') : null,
      pauseFriendly: !signedIn || (!this.state.settings.funMessages && !this.state.settings.wellbeingReminders)
        ? null
        : pausedAt(this.state.messages, this.now())
          ? { id: 'resume-friendly', label: t('trayFriendlyPaused', { time: this.time(this.state.messages.pausedUntil as string) }) }
          : { id: 'pause-friendly', label: t('trayPauseFriendly') },
      ...this.trayMeetings(),
      settings: t('traySettings'),
      quit: t('trayQuit'),
    };
    const serialized = JSON.stringify(menu);
    if (serialized !== this.lastTrayMenu) {
      this.lastTrayMenu = serialized;
      await this.platform.setTrayMenu(menu);
    }
  }

  async trayAction(action: string): Promise<void> {
    const server = this.state.session?.server;
    if (action === 'stop') await this.stop();
    else if (action === 'resume') await this.resume();
    else if (action === 'pause-friendly' || action === 'resume-friendly') await this.pauseFriendly(action === 'pause-friendly');
    else if (action === 'search') this.focusSearch();
    else if (action === 'layout-full' || action === 'layout-compact') await this.setLayoutMode(action === 'layout-full' ? 'full' : 'compact');
    else if (action === 'open-beacon') this.openBeacon(dashboardUrl(server));
    else if (action === 'my-time') this.openBeacon(myTimeUrl(server));
    else if (action === 'settings' && this.state.session !== null) this.show('settings');
    else if (action === 'check-updates' && this.state.session !== null) {
      if (this.view !== 'update-required') this.show('main');
      await this.checkUpdates(true);
    }
    else if (action.startsWith('meeting:')) {
      // *Today* in the tray: the window is shown by the host; join when the meeting has a link.
      const meeting = this.meetingByShort(action.slice(8));
      if (meeting?.joinUrl != null) await this.joinMeeting(meeting);
    }
    else if (action.startsWith('switch:')) {
      const task = this.quickTasks().find((item) => item.id === action.slice(7));
      if (task !== undefined) await this.start(task);
    }
  }

  /**
   * Registers a global shortcut (`open`: show and search; `resume`: "Continue last"); a refusal (in use, invalid, the
   * other shortcut) is shown in Settings and the previous one is kept.
   */
  async applyShortcut(accelerator: string, save = true, slot: ShortcutSlot = 'open'): Promise<boolean> {
    const value = accelerator.trim();
    const message = (text: string, ok: boolean) => {
      if (slot === 'resume') this.resumeShortcutMessage = { text, ok };
      else this.shortcutMessage = { text, ok };
    };
    const other = slot === 'resume' ? this.state.settings.shortcut : this.state.settings.resumeShortcut;
    if (value.toLowerCase() === other.trim().toLowerCase()) {
      message(this.t('shortcutSame', { shortcut: value }), false);
      this.render();
      return false;
    }
    try {
      await this.platform.setShortcut(value, slot);
    } catch {
      message(this.t('shortcutFailed', { shortcut: value }), false);
      this.render();
      return false;
    }
    if (save) {
      this.persist({ settings: { ...this.state.settings, [slot === 'resume' ? 'resumeShortcut' : 'shortcut']: value } });
      message(this.t('shortcutSaved', { shortcut: value }), true);
      this.render();
    }
    return true;
  }

  /**
   * "Continue last" (timer card button, global shortcut, "Start" of the working-without-timer nudge): starts the last
   * task again as a new entry. After an automatic stop it is the "Resume" of that question; nothing while a timer runs.
   */
  async continueLast(): Promise<void> {
    if (this.state.session === null) return;
    const phase = this.state.idleCheck.phase;
    if (phase === 'resume') return this.resumeAfterGap(true);
    if (phase === 'away' || phase === 'gap') return this.resumeNow();
    if (phase === 'asking' || this.state.activeTimer !== null) return;
    await this.resume();
  }

  /** A notification button: a working-hours reminder's, or one of "Working without a timer?". */
  async notificationAction(id: string): Promise<void> {
    const reminder = parseReminderActionId(id);
    if (reminder !== null) return this.meetingReminderAction(reminder.kind, reminder.short);
    const meeting = meetingActionOfId(id);
    if (meeting !== null) return this.meetingAction(meeting);
    const nudge = nudgeActionOf(id);
    if (nudge !== null) return this.nudgeAction(nudge);
    return this.reminderAction(actionOfId(id));
  }

  // ---- Screen lock and sleep (local only) -------------------------------------------------------------------------

  /** Whether a lock / sleep pauses: the setting, on top of the "Still there?" check it uses. */
  lockPauseOn(): boolean {
    return this.state.settings.pauseOnLock && this.idleCheckEnabled();
  }

  /** A lock / sleep event from the OS, in turn with the regular checks. */
  sessionEvent(event: SessionEvent): Promise<void> {
    const run = this.ticking.then(() => this.onSessionEvent(event));
    this.ticking = run.catch(() => undefined);
    return run;
  }

  /**
   * From the lock (or sleep) the time counts as idle; once the screen is unlocked and the computer awake, the
   * three-choice question about that time (`lockReturn`). The events themselves are never stored or sent.
   */
  private async onSessionEvent(event: SessionEvent): Promise<void> {
    if (event === 'resume') this.meetingsForce = true;
    if (event === 'lock' || event === 'unlock') this.session.locked = event === 'lock';
    else this.session.asleep = event === 'suspend';
    if (this.session.locked || this.session.asleep) {
      this.lockedAt ??= this.now();
      return;
    }
    const since = this.lockedAt;
    this.lockedAt = null;
    if (since === null || !this.lockPauseOn()) return;
    const step = lockReturn(this.state.idleCheck, this.state.activeTimer, since, this.now(), this.idleSettings());
    if (step.state !== this.state.idleCheck) this.setIdleCheck(step.state);
    if (step.effect === 'autoStop') await this.runActions(step.actions);
    if (step.effect !== null) await this.promptShown(step.state);
    this.syncWakePlan();
  }

  // ---- "Working without a timer?" (local only) ------------------------------------------------------------------

  /**
   * On every check: input for `nudgeMinutes` in a row during working hours with no timer → a friendly notification
   * (at most once every 45 min). The OS counter is read only while those conditions hold, never stored or sent.
   */
  private async checkNudge(): Promise<void> {
    const now = this.now();
    const settings = this.state.settings;
    const view = this.scheduleView();
    const lastNotice = this.state.messages.lastShownAt;
    const conditions = {
      enabled:
        this.state.session !== null &&
        settings.nudgeWithoutTimer &&
        this.view !== 'update-required' &&
        this.lockedAt === null &&
        !pausedAt(this.state.messages, now) &&
        // Not right after another message (the "Shall we start?" reminder says the same).
        (lastNotice === null || now.getTime() - Date.parse(lastNotice) >= 15 * 60_000),
      running: this.state.activeTimer !== null,
      working: workingNow({ now, timeZone: view.timeZone, week: view.merged.week, daysOff: view.daysOff }),
      prompting: this.state.idleCheck.phase !== 'watching',
      minutes: settings.nudgeMinutes,
    };
    const idleSeconds = watchingActivity(conditions) ? await this.platform.idleSeconds() : null;
    const step = observeActivity(this.state.nudge, { ...conditions, now, idleSeconds });
    if (step.state !== this.state.nudge) this.persist({ nudge: step.state });
    if (step.fire) this.fireNudge();
  }

  private fireNudge(): void {
    const last = this.lastTask();
    const { note, state } = composeNudge({
      locale: this.messageLocale(),
      rng: this.random,
      now: this.now(),
      last,
      // Meeting rule: a meeting rarely goes on, so no "Start <meeting>" button (only "Choose task").
      lastIsMeeting: last !== null && this.timerKind({ taskId: last.id, taskTitle: last.title }) !== null,
      state: this.state.nudge,
    });
    this.persist({ nudge: state, messages: { ...this.state.messages, lastShownAt: note.shownAt } });
    const native: FriendlyNotification = {
      title: note.title,
      body: note.text,
      pose: note.pose,
      actions: [...(note.resume !== null ? [{ id: note.resume.id, label: note.resume.label }] : []), { id: note.choose.id, label: note.choose.label }],
    };
    if (this.nativeGranted()) {
      void this.sendNativeNote(native).then((ok) => void (ok || this.showNudgeToast(note)));
    } else {
      this.showNudgeToast(note);
      if (this.nativeUsable()) void this.sendNativeNote(native).then((ok) => void (ok && this.nudgeToast === note && this.showNudgeToast(null)));
    }
  }

  showNudgeToast(note: NudgeNote | null): void {
    this.nudgeToast = note;
    this.render();
  }

  /** The nudge toast while it applies: not expired and still no timer. */
  visibleNudge(): NudgeNote | null {
    const note = this.nudgeToast;
    if (note === null || this.state.activeTimer !== null || this.now().getTime() - Date.parse(note.shownAt) >= CARD_TTL_MINUTES * 60_000) return null;
    return note;
  }

  /** "Start <last task>" or "Choose task" (notification or toast). */
  async nudgeAction(action: NudgeAction): Promise<void> {
    if (this.state.session === null) return;
    this.nudgeToast = null;
    if (action === 'choose') this.focusSearch();
    else await this.continueLast();
    this.render();
  }

  /** Settings → "Working without a timer?" and "Pause on lock or sleep". */
  setHelper(patch: Partial<Pick<LocalState['settings'], 'nudgeWithoutTimer' | 'nudgeMinutes' | 'pauseOnLock'>>): void {
    this.persist({ settings: { ...this.state.settings, ...patch } });
    this.render();
  }

  // ---- "Still there?" (local only) -------------------------------------------------------------------------------

  /**
   * Whether the check runs: the organisation's switch on a 1.10 server (`features.idle_check`, on by default there);
   * on a 1.9 server, which says nothing, the person's own opt-in.
   */
  idleCheckEnabled(): boolean {
    const features = this.features();
    if (this.state.session === null) return false;
    if (features.idleCheck === null) return hasConsent(this.state, 'idleDetection');
    // Personal accounts (`user_can_disable`): on by default, off once the person withdraws consent.
    return features.idleCheck && (!features.userCanDisable || this.state.consents.idleDetection?.granted !== false);
  }

  /**
   * Threshold and the "Still there?" countdown: `IDLE_COUNTDOWN_MINUTES` (never longer than the organisation's answer
   * timeout), or `MEETING_COUNTDOWN_MINUTES` while a meeting-like task runs (never shorter than the organisation's).
   */
  idleSettings(): { thresholdMinutes: number; answerTimeoutMinutes: number } {
    const features = this.features();
    const org = features.answerTimeoutMinutes;
    return {
      thresholdMinutes: effectiveThreshold(features, this.state.settings.idleMinutes),
      answerTimeoutMinutes: this.inMeeting() ? Math.max(org, MEETING_COUNTDOWN_MINUTES) : Math.min(org, IDLE_COUNTDOWN_MINUTES),
    };
  }

  /**
   * Called every 30 s: tray refresh and the "Still there?" check. The OS "seconds since last input" value is read
   * here and used only for this decision: it is not stored, logged or sent.
   */
  tick(): Promise<void> {
    // One check at a time (the 30 s ticker, the countdown reaching 0 and a wake-up may overlap): each runs after the
    // previous one, so a stop in flight is never mistaken for a timer started meanwhile.
    const run = this.ticking.then(() => this.check());
    this.ticking = run.catch(() => undefined);
    return run;
  }

  private ticking: Promise<void> = Promise.resolve();

  private async check(): Promise<void> {
    // The connection came back since the last check: fetch today's meetings again (contract §23.5).
    if (this.meetingsOffline && !this.offline) this.meetingsForce = true;
    this.meetingsOffline = this.offline;
    await this.updateTray();
    if (this.view === 'main' && this.longRunning() !== (this.main?.banners.querySelector('#long-running') !== null)) this.render();
    this.checkReminders();
    await this.checkMeetings();
    this.checkFriendly();
    await this.checkNudge();
    // The next reminder instant moves as the day goes by (and when one was skipped).
    this.syncWakePlan();
    const now = this.now();
    const suspendedSince = this.lastCheck !== null && now.getTime() - this.lastCheck.getTime() > SUSPEND_GAP_MS ? this.lastCheck : null;
    this.lastCheck = now;
    const current = this.state.idleCheck;
    if (!this.idleCheckEnabled()) {
      if (current.phase === 'asking') this.setIdleCheck(WATCHING);
      return;
    }
    const timer = this.state.activeTimer;
    if (timer === null && current.phase === 'watching') return;
    let lastInputAt = new Date(now.getTime() - (await this.platform.idleSeconds()) * 1000);
    // The countdown runs on the wall clock: when it ran out while the window was hidden or the computer slept, the
    // timer pauses at the start of the idle time even if an input woke it up (the countdown was already over).
    const settings = this.idleSettings();
    if (current.phase === 'asking' && current.returnedAt === null && now.getTime() - Date.parse(current.askedAt) >= settings.answerTimeoutMinutes * 60_000) {
      lastInputAt = new Date(current.from);
    }
    const step = observeIdle(current, timer, { now, lastInputAt, suspendedSince }, settings);
    if (step.state !== current) this.setIdleCheck(step.state);
    if (step.effect === 'autoStop') await this.runActions(step.actions);
    if (step.effect === 'ask' || step.effect === 'askGap' || (step.effect === 'autoStop' && step.state.phase === 'gap')) await this.promptShown(step.state);
    this.syncWakePlan();
  }

  private setIdleCheck(state: IdleCheckState): void {
    if (state.phase !== 'asking') this.meetingOpen = false;
    if (state.phase !== this.state.idleCheck.phase) this.closeReassign();
    const asked = state.phase === 'asking' && this.state.idleCheck.phase !== 'asking';
    let messages = this.state.messages;
    if (asked) messages = pickIdleLine(messages, this.messageLocale(), this.random, this.switches(), this.inMeeting());
    else if (state.phase !== 'asking' && messages.idleLine !== null) messages = { ...messages, idleLine: null };
    this.persist({ idleCheck: state, messages });
    this.render();
  }

  /** A calm, polite announcement (no focus change, no sound) and, if allowed, a system notification. */
  private async promptShown(state: IdleCheckState): Promise<void> {
    if (state.phase !== 'asking' && state.phase !== 'gap') return;
    const minutes = state.phase === 'asking' ? this.idleSettings().thresholdMinutes : this.minutesBetween(state.from, state.to);
    const text = state.phase === 'asking' ? this.t('stillThereText', { minutes, task: state.taskTitle }) : this.t('gapTitle');
    const title = this.t(this.inMeeting() ? 'stillInMeetingTitle' : 'stillThereTitle');
    // Once, politely: the countdown itself is not read out every second.
    const countdown = state.phase === 'asking' ? ` ${this.t('stillThereTimeout', { minutes: this.idleSettings().answerTimeoutMinutes })}` : '';
    this.announce(`${title} ${text}${countdown}`);
    // Its own window, centred and on top, is the attention signal; the notification is for the in-app modal only.
    if (!this.promptInWindow() && hasConsent(this.state, 'notifications') && withinWorkingHours(this.me?.workingHours, this.now())) {
      await this.platform.notify(title, text);
    }
  }

  private minutesBetween(from: string, to: string | Date): number {
    return Math.max(1, Math.round(((typeof to === 'string' ? Date.parse(to) : to.getTime()) - Date.parse(from)) / 60_000));
  }

  /** The person's answer to "Still there?": the only idle-related data that reaches the server. */
  async answerIdle(choice: IdleChoice): Promise<void> {
    const state = this.state.idleCheck;
    if (state.phase !== 'asking') return;
    const decision = decide(state, choice, this.now(), { keepNote: this.features().idleKeepNote });
    this.persist({ pendingNote: decision.pendingNote ?? this.state.pendingNote });
    this.setIdleCheck(decision.state);
    await this.runActions(decision.actions);
    this.setNotice(this.t(choice.kind === 'pause' ? 'idlePaused' : choice.kind === 'discard' ? 'idleDiscarded' : 'idleKept'));
  }

  /** The answer about the time away after an automatic stop. */
  async answerGap(choice: GapChoice): Promise<void> {
    const state = this.state.idleCheck;
    if (state.phase !== 'gap') return;
    const decision = decideGap(state, choice);
    this.setIdleCheck(decision.state);
    await this.runActions(decision.actions);
    this.main?.root.querySelector<HTMLButtonElement>('#gap-resume')?.focus();
  }

  /** "Resume" after the gap question, or "Not now". */
  async resumeAfterGap(resume: boolean): Promise<void> {
    const state = this.state.idleCheck;
    if (state.phase !== 'resume') return;
    this.setIdleCheck(WATCHING);
    if (resume) await this.start(this.findTask(state.taskId) ?? { id: state.taskId, title: state.taskTitle });
  }

  /** "Resume … now" in the paused modal: a new entry on the same task from now (the time away stays out). */
  async resumeNow(): Promise<void> {
    const state = this.state.idleCheck;
    if (state.phase !== 'away' && state.phase !== 'gap') return;
    this.setIdleCheck(WATCHING);
    await this.start(this.findTask(state.taskId) ?? { id: state.taskId, title: state.taskTitle });
  }

  dismissClamps(): void {
    this.clampNotes = [];
    this.render();
  }

  // ---- updates ----------------------------------------------------------------------------------------------------

  /**
   * Asks Beacon's updater (startup, every 6 h, tray / About "Check for updates"). `manual` also shows the result and
   * brings back a version hidden with "Later". Concurrent automatic checks share one request.
   */
  async checkUpdates(manual = false): Promise<void> {
    if (!manual && this.updateCheck !== null) return this.updateCheck;
    const running = this.updateCheck;
    const check = (async () => {
      if (running !== null) await running;
      await this.runUpdateCheck(manual);
    })();
    this.updateCheck = check;
    try {
      await check;
    } finally {
      if (this.updateCheck === check) this.updateCheck = null;
    }
  }

  private async runUpdateCheck(manual: boolean): Promise<void> {
    const session = this.state.session;
    if (session === null || this.token === null) return;
    if (this.updateStage === 'downloading' || this.updateStage === 'installing') return;
    if (manual) this.updateLater = null;
    if (this.channel === 'store') {
      this.applyStoreMinimum(manual);
      return;
    }
    let result: UpdateCheck;
    try {
      result = await this.platform.checkUpdate(session.server, this.token);
    } catch (error) {
      result = { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    if (result.status === 'unauthorized') {
      await this.signedOut(this.t('sessionExpired'));
      return;
    }
    if (result.status === 'error' || result.status === 'disabled') {
      if (manual) this.reportCheck(this.t('updateCheckFailed'));
      return;
    }
    // Validate the server's minimum before ever blocking (audit CN D1); GET me's minimum counts too.
    const min = this.strictestMinimum(isVersion(result.min_supported_version) ? result.min_supported_version : null);
    const below = min !== null && updateRequired(this.version, min);
    if (result.status === 'up_to_date') {
      this.update = null;
      this.updateStage = 'offer';
      const unavailable = below ? this.t('updateUnavailable', { min }) : null;
      this.updateMessage = unavailable;
      if (manual) this.reportCheck(unavailable ?? this.t('updateUpToDate', { version: this.version }));
      if (this.view === 'update-required') this.view = 'main';
      this.render();
      return;
    }
    const installable = result.installable !== false && isVersion(result.version);
    const notes = typeof result.notes === 'string' && result.notes.trim() !== '' ? result.notes.trim() : null;
    if (this.update?.version !== result.version) {
      this.updateNotesOpen = false;
      if (this.updateStage !== 'after-stop') this.updateStage = 'offer';
    }
    this.update = { version: result.version, min, installable, notes };
    const satisfiable = below && isVersion(result.version) && compareVersions(min, result.version) <= 0;
    this.updateMessage = !installable
      ? this.t('updateManual', { version: result.version })
      : below && !satisfiable
        ? this.t('updateUnavailable', { min })
        : null;
    if (manual) this.reportCheck(this.updateMessage ?? this.t('updateAvailable', { version: result.version }));
    if (below && satisfiable && installable && !this.updateDismissed) {
      this.show('update-required');
    } else {
      if (this.view === 'update-required') this.view = 'main';
      this.render();
    }
  }

  /** The higher of the updater's minimum and GET me's (`null` when neither is set). */
  private strictestMinimum(fromUpdater: string | null): string | null {
    const me = this.meMinimum;
    if (fromUpdater === null) return me;
    if (me === null) return fromUpdater;
    return compareVersions(me, fromUpdater) > 0 ? me : fromUpdater;
  }

  /** Store build: GET me's minimum sends the person to the Store listing (the Store installs the update). */
  private applyStoreMinimum(manual: boolean): void {
    const min = this.meMinimum;
    const below = min !== null && updateRequired(this.version, min);
    this.update = below ? { version: min, min, installable: false, notes: null } : null;
    this.updateMessage = null;
    if (manual) this.reportCheck(this.t('updateStoreManaged'));
    if (below && !this.updateDismissed) {
      this.show('update-required');
    } else {
      if (this.view === 'update-required') this.view = 'main';
      this.render();
    }
  }

  private reportCheck(text: string): void {
    this.updateStatus = text;
    this.setNotice(text);
    this.render();
  }

  /** "Update now": asks first while a timer runs (update now anyway, or after I stop). */
  updateNow(): void {
    if (this.state.activeTimer !== null) {
      this.updateStage = 'confirm-running';
      this.render();
      this.body.querySelector<HTMLButtonElement>('#update-after-stop')?.focus();
      return;
    }
    void this.installUpdate();
  }

  /** "Update after I stop": installs as soon as the timer is stopped (here, from the tray or elsewhere). */
  updateAfterStop(): void {
    this.updateStage = 'after-stop';
    this.announce(this.t('updateWaiting'));
    this.render();
    if (this.state.activeTimer === null) void this.installUpdate();
  }

  cancelUpdateChoice(): void {
    this.updateStage = 'offer';
    this.render();
    this.body.querySelector<HTMLButtonElement>('#update-now')?.focus();
  }

  /** "Later": hides this version until a manual check or the next launch (the 6-hour check keeps it hidden). */
  updateLaterClick(): void {
    if (this.update !== null) this.updateLater = this.update.version;
    this.updateStage = 'offer';
    this.render();
  }

  toggleUpdateNotes(): void {
    this.updateNotesOpen = !this.updateNotesOpen;
    this.render();
  }

  /** Never traps the user: a failed download / verification becomes a non-blocking message with a Beacon link. */
  async installUpdate(): Promise<void> {
    const session = this.state.session;
    if (session === null || this.token === null || this.channel === 'store') return;
    if (this.updateStage === 'downloading' || this.updateStage === 'installing') return;
    const version = this.update?.version ?? '';
    this.busy = true;
    this.updateStage = 'downloading';
    this.updateProgress = { downloaded: 0, total: null };
    this.announce(this.t('updateDownloadingShort', { version }));
    this.render();
    try {
      await this.platform.installUpdate(session.server, this.token, (progress) => this.onUpdateProgress(progress));
      // The real app relaunches here; keep "installing" on screen until it does.
      this.updateStage = 'installing';
    } catch (error) {
      this.updateStage = 'offer';
      this.updateProgress = null;
      this.updateDismissed = true;
      this.updateMessage = this.t('updateFailed', { message: error instanceof Error ? error.message : String(error) });
      this.view = 'main';
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private onUpdateProgress(progress: UpdateProgress): void {
    if (progress.phase === 'installing') {
      this.updateStage = 'installing';
      this.announce(this.t('updateInstalling', { version: this.update?.version ?? '' }));
    } else {
      this.updateStage = 'downloading';
      this.updateProgress = { downloaded: progress.downloaded, total: progress.total };
    }
    this.render();
  }

  /** Whole percent of the download, `null` while the size is unknown. */
  updatePercent(): number | null {
    const progress = this.updateProgress;
    if (progress === null || progress.total === null || progress.total <= 0) return null;
    return Math.min(100, Math.floor((progress.downloaded / progress.total) * 100));
  }

  remindLater(): void {
    this.updateDismissed = true;
    this.show('main');
  }

  openStore(): void {
    const session = this.state.session;
    if (this.deps.storeUrl !== undefined && externalUrl(this.deps.storeUrl, { kind: 'help' }) !== null) void this.openExternal(this.deps.storeUrl, { kind: 'help' });
    else if (session !== null) this.openBeacon(appsPage(session.server));
  }

  openApps(): void {
    const session = this.state.session;
    if (session !== null) this.openBeacon(appsPage(session.server));
  }

  /**
   * Opens a Beacon page in the browser. The URL is checked again against the connected server right before opening
   * (https, same origin, no credentials); anything else is ignored.
   */
  openBeacon(url: string | null | undefined): void {
    void this.openExternal(url, this.beaconRule());
  }

  private beaconRule(): LinkRule {
    return { kind: 'beacon', server: this.state.session?.server };
  }

  /** A link with no handler of its own: a Beacon page when it is on the connected server, else an https page. */
  openLink(url: string): void {
    void this.openExternal(url, sameOriginHttps(url, this.state.session?.server) !== null ? this.beaconRule() : { kind: 'help' });
  }

  /**
   * Every link the app opens goes through here: checked against `rule`, then opened in the "Open Beacon in" browser
   * (the system default unless another one was chosen on this computer). A chosen browser that is gone falls back to
   * the system default with a notice; when no browser opens at all the link is copied instead. False when nothing
   * opened.
   */
  async openExternal(url: string | null | undefined, rule: LinkRule): Promise<boolean> {
    this.closeLinkMenu();
    const safe = externalUrl(url, rule);
    if (safe === null) return false;
    const choice = this.browserChoice;
    try {
      const outcome = await this.platform.openExternal(safe);
      if (outcome === 'fallback' && choice.kind !== 'system') this.setNotice(this.t('browserFallback', { name: choice.name }));
      return true;
    } catch {
      const copyable = copyableUrl(safe, rule);
      this.setNotice(this.t(copyable !== null && (await this.tryCopy(copyable)) ? 'openFailedCopied' : 'openFailed'));
      return false;
    }
  }

  /** "Copy link": the same checks as opening it, without credentials or secret parameters (`copyableUrl`). */
  async copyLink(url: string | null | undefined, rule: LinkRule = this.beaconRule()): Promise<void> {
    this.closeLinkMenu();
    const safe = copyableUrl(url, rule);
    if (safe !== null && (await this.tryCopy(safe))) this.setNotice(this.t('linkCopied'));
  }

  private async tryCopy(text: string): Promise<boolean> {
    try {
      await this.platform.copyText(text);
      return true;
    } catch {
      return false;
    }
  }

  openLinkMenu(url: string, rule: LinkRule, x: number, y: number): void {
    if (externalUrl(url, rule) === null) return;
    this.linkMenu = { url, rule, x, y };
    this.renderLinkMenu();
    this.menuRegion.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }

  closeLinkMenu(): void {
    if (this.linkMenu === null) return;
    this.linkMenu = null;
    this.renderLinkMenu();
  }

  private renderLinkMenu(): void {
    const menu = this.linkMenu;
    if (menu === null) {
      patch(this.menuRegion, []);
      return;
    }
    const t = this.t;
    const item = (id: string, name: IconName, label: string, run: () => void) =>
      h('button', { class: 'menu-item', id, key: id, attrs: { type: 'button', role: 'menuitem' }, on: { click: (event) => { event.stopPropagation(); run(); } } }, icon(name), label);
    const width = globalThis.innerWidth ?? 400;
    const height = globalThis.innerHeight ?? 600;
    patch(this.menuRegion, [
      h(
        'div',
        {
          class: 'link-menu',
          id: 'link-menu',
          attrs: { role: 'menu', 'aria-label': t('linkMenu'), style: `left:${Math.max(8, Math.min(menu.x, width - 208))}px;top:${Math.max(8, Math.min(menu.y, height - 96))}px` },
          on: {
            keydown: (event) => {
              const items = [...this.menuRegion.querySelectorAll<HTMLElement>('[role="menuitem"]')];
              const at = items.indexOf(document.activeElement as HTMLElement);
              if (event.key === 'Escape') {
                event.stopPropagation();
                this.closeLinkMenu();
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
              }
            },
          },
        },
        item('link-menu-open', 'external', t('openInBrowser'), () => void this.openExternal(menu.url, menu.rule)),
        item('link-menu-copy', 'copy', t('copyLink'), () => void this.copyLink(menu.url, menu.rule)),
      ),
    ]);
  }

  /** Secondary "Copy link" icon button next to an open action. */
  private copyButton(url: string, label: string, id?: string, rule: LinkRule = this.beaconRule()): HTMLButtonElement {
    const button = this.iconButton('copy', label, { id, key: id, onClick: () => void this.copyLink(url, rule) });
    button.classList.add('copy-link');
    return button;
  }

  /** Task page of the running timer: the timer's `url`, else the `url` of the same task in the list. */
  timerUrl(timer: Timer): string | null {
    const server = this.state.session?.server;
    return taskUrl(timer.url, server) ?? taskUrl(this.findTask(timer.taskId)?.url, server);
  }

  async copy(text: string): Promise<void> {
    try {
      await this.platform.copyText(text);
      this.setNotice(this.t('copied'));
    } catch {
      // Clipboard refused (no user gesture): nothing else to do.
    }
  }

  // ---- settings ---------------------------------------------------------------------------------------------------

  async setFeature(feature: Feature, enabled: boolean): Promise<void> {
    await this.guard(async () => {
      if (feature === 'autostart') await this.platform.setAutostart(enabled);
      this.state = recordConsent(this.state, feature, enabled, this.now());
      saveLocal(this.state, this.storage);
      if (feature === 'idleDetection' && !enabled && this.state.idleCheck.phase === 'asking') this.setIdleCheck(WATCHING);
      if (feature === 'meetingDetection' && !enabled) this.stopMeetingDetection();
    });
  }

  setIdleMinutes(minutes: number | null): void {
    this.persist({ settings: { ...this.state.settings, idleMinutes: minutes } });
  }

  /**
   * "Clear local data": revokes the token (best effort), deletes it from the keychain, empties the app's storage
   * (settings, consents, pinned tasks, queued actions, idle-check state) and turns "start at login" off.
   */
  async clearLocalData(): Promise<void> {
    if (this.state.session !== null) {
      try {
        await this.api().logout();
      } catch {
        // Local clean-up never depends on the server.
      }
    }
    try {
      if (await this.platform.autostartEnabled()) await this.platform.setAutostart(false);
    } catch {
      // Not available on this system.
    }
    await this.platform.secretDelete();
    // "Open Beacon in" is kept by the host: back to the system default.
    try {
      this.browserChoice = await this.platform.setBrowser({ kind: 'system' });
    } catch {
      this.browserChoice = SYSTEM_BROWSER;
    }
    this.clearMeetings();
    for (const key of [...LOCAL_KEYS, WINDOW_KEY]) this.storage.removeItem(key);
    this.windowMemory = loadWindowMemory(this.storage);
    this.section = 'tasks';
    this.selectedTaskId = null;
    this.token = null;
    this.state = emptyState();
    this.meetingMarks = [];
    this.meetingSupport = { kind: 'unsupported' };
    this.meetingAccount = null;
    this.meetingPoll = FRESH_POLL;
    this.serverDraft = this.deps.beaconUrl ?? '';
    this.tasks = [];
    this.entries = null;
    this.me = null;
    this.clampNotes = [];
    this.main?.prompt.dispose();
    this.main = null;
    this.confirmClear = false;
    this.offline = false;
    this.view = 'login';
    this.setNotice(this.t('localDataCleared'));
    this.render();
    await this.updateTray();
  }

  // ---- window layouts ---------------------------------------------------------------------------------------------

  /** The full layout is drawn: wide window, signed in, on the main screen or Settings. */
  fullLayout(): boolean {
    return this.layout === 'full' && this.state.session !== null && (this.view === 'main' || this.view === 'settings' || this.view === 'privacy');
  }

  /** Section of the main screen: the sidebar's choice in the full layout, the task list in the compact one. */
  currentSection(): Section {
    return this.fullLayout() ? this.section : 'tasks';
  }

  /** The window width crossed the breakpoint: redraw in the other layout. */
  relayout(): void {
    if (!this.root.isConnected) return;
    const layout = layoutFor(this.viewportWidth());
    if (layout === this.layout) return;
    this.layout = layout;
    this.render();
    void this.updateTray();
  }

  /** Puts the window where it was in the view last used (or at that view's preset size), on a screen it fits on. */
  private async restoreWindow(): Promise<void> {
    const host = this.platform.windowHost;
    try {
      const target = placeWindow(this.windowMemory.mode, this.windowMemory, await host.screens());
      const current = await host.bounds();
      if (current === null || JSON.stringify(current) !== JSON.stringify(target)) await host.setBounds(target);
    } catch {
      // The window stays where the OS put it.
    }
    host.onChange(() => this.windowChanged());
  }

  private windowChanged(): void {
    if (this.windowTimer !== null) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      void this.rememberWindow();
    }, this.deps.windowSaveMs ?? 400);
  }

  /** Remembers the window's bounds for the layout its width gives (not while maximised or minimised). */
  async rememberWindow(): Promise<void> {
    let bounds;
    try {
      bounds = await this.platform.windowHost.bounds();
    } catch {
      return;
    }
    if (bounds === null) return;
    const mode = layoutFor(this.viewportWidth());
    this.windowMemory = { mode, bounds: { ...this.windowMemory.bounds, [mode]: bounds } };
    saveWindowMemory(this.windowMemory, this.storage);
  }

  /** "Compact view" / "Full view": resizes the window to that view's remembered size (or preset), on screen. */
  async setLayoutMode(mode: LayoutMode): Promise<void> {
    if (this.windowTimer !== null) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    await this.rememberWindow();
    this.windowMemory = { ...this.windowMemory, mode };
    saveWindowMemory(this.windowMemory, this.storage);
    const host = this.platform.windowHost;
    try {
      await host.setBounds(placeWindow(mode, this.windowMemory, await host.screens()));
    } catch {
      // The OS refused: the window keeps its size, and the layout keeps following its width.
    }
    this.announce(this.t(mode === 'full' ? 'layoutFull' : 'layoutCompact'));
  }

  /** Full layout: a sidebar section in the main pane. */
  showSection(section: Section): void {
    this.section = section;
    if (this.view === 'main') this.render();
    else this.show('main');
  }

  /** Full layout: the task shown in the detail pane (rows are selected by click or keyboard focus). */
  selectTask(taskId: string): void {
    if (!this.fullLayout() || this.selectedTaskId === taskId) return;
    this.selectedTaskId = taskId;
    this.main?.root.querySelectorAll<HTMLElement>('li[data-task]').forEach((row) => this.markRow(row, row.dataset.task === taskId));
    this.renderPanes();
  }

  private markRow(row: HTMLElement, selected: boolean): void {
    row.classList.toggle('selected', selected);
    if (selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }

  /** The detail pane's task: the selected one, else the running one. */
  detailTask(): Task | null {
    const timer = this.state.activeTimer;
    const id = this.selectedTaskId ?? timer?.taskId ?? null;
    if (id === null) return null;
    if (timer !== null && timer.taskId === id) return this.timerTask(timer);
    return this.findTask(id) ?? this.quickTasks().find((task) => task.id === id) ?? null;
  }

  /** F6 / Shift+F6: sidebar → main pane → detail pane (full layout). */
  private cyclePane(step: number): void {
    const panes = [this.sidebar, this.center, this.detail].filter((pane) => !pane.hidden);
    const at = panes.findIndex((pane) => pane.contains(document.activeElement));
    const next = panes[at === -1 ? 0 : (at + step + panes.length) % panes.length];
    const preferred = next === this.sidebar ? next.querySelector<HTMLElement>('[aria-current="page"]') : next === this.center && this.view === 'main' && this.currentSection() === 'tasks' ? this.main?.search : null;
    const target = preferred ?? next.querySelector<HTMLElement>('button:not([disabled]), a[href], input, select, [tabindex="0"]') ?? next;
    target.focus();
  }

  // ---- keyboard ---------------------------------------------------------------------------------------------------

  focusSearch(): void {
    if (this.state.session === null) return;
    if (this.view !== 'main') this.show('main');
    this.main?.search.focus();
    this.main?.search.select();
  }

  /**
   * In-app shortcuts: Ctrl/⌘+K or "/" search, Alt+1…9 quick tasks, Ctrl/⌘+Shift+S stop / resume, Ctrl/⌘+, settings,
   * Ctrl/⌘+Shift+L compact / full view, F6 / Shift+F6 next / previous pane (full view).
   */
  private onKey(event: KeyboardEvent): void {
    if (!this.root.isConnected) return;
    if (this.view !== 'main' && this.view !== 'settings' && this.view !== 'privacy') return;
    const mod = event.ctrlKey || event.metaKey;
    const target = event.target as HTMLElement | null;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.focusSearch();
    } else if (event.key === '/' && !typing && !mod) {
      event.preventDefault();
      this.focusSearch();
    } else if (mod && event.shiftKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      void this.setLayoutMode(otherMode(this.layout));
    } else if (event.key === 'F6' && this.fullLayout()) {
      event.preventDefault();
      this.cyclePane(event.shiftKey ? -1 : 1);
    } else if (mod && event.key === ',') {
      event.preventDefault();
      this.show('settings');
    } else if (mod && event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.toggle();
    } else if (event.altKey && !mod && /^Digit[1-9]$/.test(event.code) && this.view === 'main') {
      const task = this.quickTasks()[Number(event.code.slice(5)) - 1];
      if (task !== undefined) {
        event.preventDefault();
        void this.start(task);
      }
    } else if (event.key === 'Escape' && this.view !== 'main' && this.state.session !== null) {
      this.show(this.view === 'privacy' ? 'settings' : 'main');
    }
  }

  /** Arrow keys between the search field and the rows' main buttons (roving focus, no extra tab stops). */
  private onListKey(event: KeyboardEvent): void {
    const main = this.main;
    if (main === null) return;
    const buttons = [...main.root.querySelectorAll<HTMLButtonElement>('button.row-action')];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = buttons[index + 1];
    else if (event.key === 'ArrowUp') next = index <= 0 ? main.search : buttons[index - 1];
    else if (event.key === 'Home' && index >= 0) next = buttons[0];
    else if (event.key === 'End' && index >= 0) next = buttons.at(-1);
    else if (event.key === 'Escape' && index >= 0) next = main.search;
    else if (event.key === 'Enter' && event.target === main.search) next = buttons[0];
    if (next !== undefined) {
      event.preventDefault();
      if (event.key === 'Enter' && next instanceof HTMLButtonElement) next.click();
      else next.focus();
    }
  }

  // ---- plumbing ---------------------------------------------------------------------------------------------------

  /**
   * Main-screen buttons stay focusable while a request runs (`aria-disabled`, not `disabled`, so focus never falls
   * back to the page); a click during that time is ignored.
   */
  private whenIdle(action: () => Promise<void>): void {
    if (!this.busy) void action();
  }

  /**
   * Runs an action with busy state and the error catalogue. 401 signs out; network errors while signed in switch to
   * offline mode (and run `offline` when given); anything else becomes an `ErrorView` with Retry.
   */
  private async guard(
    action: () => Promise<void>,
    offline?: () => Promise<void>,
    context: () => { stage?: ErrorStage; task?: string; server?: string } = () => ({}),
    retry?: () => Promise<void>,
  ): Promise<void> {
    this.busy = true;
    this.error = null;
    this.render();
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized && this.state.session !== null) {
        await this.signedOut(this.t('sessionExpired'));
      } else if (error instanceof ApiError && error.isNetwork && !isUntrustedCertificate(error) && this.state.session !== null) {
        this.offline = true;
        if (offline !== undefined) await offline();
      } else {
        const ctx = context();
        this.fail(error, ctx.stage ?? 'action', ctx.task, ctx.server, retry ?? (() => this.guard(action, offline, context)));
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private fail(error: unknown, stage: ErrorStage, task?: string, server?: string, retry?: () => Promise<void>): void {
    this.error = describeError(error, {
      stage,
      task,
      server: server ?? this.state.session?.server ?? this.state.lastServer,
      version: this.version,
      now: this.now(),
    });
    this.retryAction = retry ?? null;
    this.render();
  }

  dismissError(): void {
    this.error = null;
    this.render();
  }

  async retry(): Promise<void> {
    const action = this.retryAction;
    this.error = null;
    this.render();
    if (action !== null) await action();
  }

  /** Screen-reader-only announcement (result counts, code expiry) in the persistent polite status region. */
  private announce(text: string): void {
    this.live = text;
    if (this.liveRegion.textContent !== text) this.liveRegion.textContent = text;
  }

  // ---- rendering --------------------------------------------------------------------------------------------------

  render(): void {
    this.rendering = true;
    try {
      this.draw();
    } finally {
      this.rendering = false;
    }
  }

  private draw(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.view !== 'device' && this.deviceTicker !== null) {
      clearInterval(this.deviceTicker);
      this.deviceTicker = null;
    }
    this.renderHeader();
    this.renderMessages();
    this.renderToasts();
    this.renderPanes();
    this.root.setAttribute('data-view', this.view);
    if (this.view === 'main') {
      this.renderMain();
    } else {
      this.main?.root.remove();
      const views: Record<Exclude<View, 'main'>, () => HTMLElement> = {
        loading: () => h('p', {}, '…'),
        login: () => this.renderLogin(),
        device: () => this.renderDevice(),
        settings: () => this.renderSettings(),
        privacy: () => this.renderPrivacy(),
        'update-required': () => this.renderUpdateRequired(),
      };
      patch(this.body, [views[this.view]()]);
    }
    this.root.setAttribute('aria-busy', this.busy ? 'true' : 'false');
    this.syncPromptWindow();
    this.syncWakePlan();
  }

  /**
   * What the host must wake the check for besides the 30 s tick: the end of the "Still there?" countdown, and the idle
   * threshold while a timer runs and nobody was asked yet (so the question appears on time, window hidden or not).
   */
  wakePlan(): WakePlan {
    const state = this.state.idleCheck;
    const reminderAt = [this.nextReminderAt(), this.nextMeetingAt()].reduce<number | null>((min, at) => (at === null ? min : min === null ? at : Math.min(min, at)), null);
    // Meeting detection: the host looks at the microphone only while it is on.
    const mic = this.meetingOn() ? { micEverySeconds: MIC_POLL_SECONDS } : {};
    if (!this.idleCheckEnabled()) return { deadlineAt: null, idleAfterSeconds: null, reminderAt, ...mic };
    const settings = this.idleSettings();
    return {
      deadlineAt: state.phase === 'asking' && state.returnedAt === null ? Date.parse(state.askedAt) + settings.answerTimeoutMinutes * 60_000 : null,
      idleAfterSeconds: state.phase === 'watching' && this.state.activeTimer !== null ? settings.thresholdMinutes * 60 : null,
      reminderAt,
      ...mic,
    };
  }

  private syncWakePlan(): void {
    const plan = this.wakePlan();
    const key = JSON.stringify(plan);
    if (key === this.wakePlanKey) return;
    this.wakePlanKey = key;
    void this.platform.setWakePlan(plan).catch(() => undefined);
  }

  private iconButton(name: IconName, label: string, props: { id?: string; key?: string; onClick: () => void; shortcut?: string }): HTMLButtonElement {
    return h(
      'button',
      {
        class: 'icon-button',
        id: props.id,
        key: props.key,
        attrs: { type: 'button', 'aria-label': label, title: label, 'aria-keyshortcuts': props.shortcut },
        on: { click: props.onClick },
      },
      icon(name),
    );
  }

  private renderHeader(): void {
    const t = this.t;
    const signedIn = this.state.session !== null;
    const sub = this.view === 'settings' || this.view === 'privacy';
    const dashboard = signedIn ? dashboardUrl(this.state.session?.server) : null;
    patch(this.header, [
      sub
        ? this.iconButton('back', t('back'), {
            id: 'back',
            onClick: () => this.show(this.view === 'privacy' && signedIn ? 'settings' : signedIn ? 'main' : 'login'),
          })
        : null,
      h('h1', {}, sub ? null : icon('clock'), sub ? t(this.view === 'privacy' ? 'whatWeCollect' : 'settings') : t('appName')),
      h(
        'nav',
        { class: 'actions', attrs: { 'aria-label': t('beaconLinks') } },
        this.offline && signedIn && this.queue.size > 0 && h('span', { class: 'badge', id: 'queue-badge', attrs: { title: t('offline', { count: this.queue.size }) } }, String(this.queue.size)),
        dashboard !== null && this.beaconLink(dashboard, t('openBeacon'), { id: 'open-beacon', icon: true }),
        signedIn && (this.view === 'main' || sub) && this.layoutToggle(),
        this.view === 'main' && this.iconButton('settings', t('settings'), { id: 'open-settings', onClick: () => this.show('settings'), shortcut: 'Control+,' }),
        this.view === 'login' && this.iconButton('help', t('whereFind'), { id: 'help', onClick: () => this.toggleWhere() }),
      ),
    ]);
  }

  /** Header: "Full view" (icon only in the compact header) / "Compact view" (with its label in the full one). */
  private layoutToggle(): HTMLButtonElement {
    const to = otherMode(this.layout);
    const label = this.t(to === 'full' ? 'layoutToFull' : 'layoutToCompact');
    const props = { id: 'layout-toggle', onClick: () => void this.setLayoutMode(to), shortcut: 'Control+Shift+L' };
    if (to === 'full') return this.iconButton('columns', label, props);
    return h(
      'button',
      { class: 'secondary small', id: props.id, attrs: { type: 'button', title: label, 'aria-keyshortcuts': props.shortcut }, on: { click: props.onClick } },
      icon('compact'),
      this.t('layoutCompact'),
    );
  }

  /** Full layout: the sections sidebar and (on the main screen) the detail pane; both empty and hidden otherwise. */
  private renderPanes(): void {
    const full = this.fullLayout();
    const detail = full && this.view === 'main';
    this.root.setAttribute('data-layout', full ? 'full' : 'compact');
    this.root.classList.toggle('with-detail', detail);
    this.sidebar.hidden = !full;
    this.detail.hidden = !detail;
    this.sidebar.setAttribute('aria-label', this.t('sectionsLabel'));
    patch(this.sidebar, full ? this.renderSidebar() : []);
    patch(this.detail, detail ? this.renderDetail() : []);
  }

  private renderSidebar(): Child[] {
    const t = this.t;
    const main = this.view === 'main';
    const item = (id: string, name: IconName, label: string, current: boolean, onClick: () => void, shortcut?: string) =>
      h(
        'li',
        {},
        h('button', { class: 'nav-item', id, key: id, attrs: { type: 'button', 'aria-current': current ? 'page' : undefined, 'aria-keyshortcuts': shortcut }, on: { click: onClick } }, icon(name), h('span', {}, label)),
      );
    return [
      h(
        'ul',
        { class: 'nav-list' },
        item('nav-tasks', 'list', t('navTasks'), main && this.section === 'tasks', () => this.showSection('tasks')),
        item('nav-quick', 'pin', t('pinnedRecent'), main && this.section === 'quick', () => this.showSection('quick')),
        item('nav-time', 'clock', t('myTime'), main && this.section === 'time', () => this.showSection('time')),
        item('nav-settings', 'settings', t('settings'), !main, () => this.show('settings'), 'Control+,'),
      ),
      h('p', { class: 'nav-hint muted', id: 'pane-hint' }, t('paneHint')),
    ];
  }

  /** Detail pane: the selected (or running) task with its time today and this week, then the week by day. */
  private renderDetail(): Child[] {
    const t = this.t;
    const now = this.now();
    const timer = this.state.activeTimer;
    const entries = this.entries;
    const task = this.detailTask();
    const tile = (id: string, label: string, seconds: number) => h('div', { class: 'tile', id }, h('span', { class: 'label' }, label), h('span', { class: 'value' }, formatHoursMinutes(seconds)));
    const blocks: Child[] = [];
    if (task === null) {
      blocks.push(h('h2', { class: 'detail-title', id: 'detail-title' }, t('detailLabel')), h('p', { class: 'muted', id: 'detail-empty' }, t('detailEmpty')));
    } else {
      const running = timer !== null && timer.taskId === task.id;
      const pinned = this.isPinned(task.id);
      const link = taskUrl(task.url, this.state.session?.server);
      const context = taskContext(task);
      blocks.push(
        h('span', { class: running ? 'chip running' : 'chip' }, running ? `● ${t('tracking')}` : t('detailLabel')),
        h('h2', { class: 'detail-title', id: 'detail-title' }, task.title),
        context !== '' && h('p', { class: 'muted', id: 'detail-context' }, context),
        h(
          'div',
          { class: 'row-actions' },
          running
            ? h('button', { class: 'danger small', id: 'detail-stop', key: 'detail-stop', attrs: { type: 'button', 'aria-disabled': this.busy ? 'true' : undefined, 'aria-label': t('stopTask', { task: task.title }) }, on: { click: () => this.whenIdle(() => this.stop()) } }, icon('stop'), t('stop'))
            : h('button', { class: 'primary small', id: 'detail-start', key: 'detail-start', attrs: { type: 'button', 'aria-disabled': this.busy ? 'true' : undefined, 'aria-label': t(timer !== null ? 'switchTask' : 'startTask', { task: task.title }) }, on: { click: () => this.whenIdle(() => this.start(task)) } }, icon(timer !== null ? 'switch' : 'play'), t(timer !== null ? 'switch' : 'start')),
          h('button', { class: 'secondary small', id: 'detail-pin', key: 'detail-pin', attrs: { type: 'button', 'aria-pressed': pinned ? 'true' : 'false' }, on: { click: () => this.togglePin(task) } }, icon('pin'), t(pinned ? 'unpin' : 'pin')),
          link !== null && this.beaconLink(link, t('openTaskInBeacon', { title: task.title }), { id: 'detail-open-in-beacon', key: 'detail-open-in-beacon', icon: true }),
        ),
      );
      if (entries !== null) {
        blocks.push(
          h('div', { class: 'detail-tiles' }, tile('detail-today', t('detailToday'), todayByTask(entries, timer, now).get(task.id) ?? 0), tile('detail-week', t('detailWeek'), weekByTask(entries, timer, now).get(task.id) ?? 0)),
          h('h3', { class: 'section-title', id: 'detail-entries-title' }, t('detailEntries')),
          this.spanList('detail-entries', todaySpans(entries, timer, now, task.id), false),
        );
      }
    }
    if (entries === null) blocks.push(h('p', { class: 'muted', id: 'detail-no-entries' }, t('entriesUnavailable')));
    else blocks.push(h('h3', { class: 'section-title', id: 'detail-week-title' }, t('weekSummary')), this.weekList('detail-week-days', 'detail-week-title'));
    return blocks;
  }

  /** Full layout, "My time": today's entries (all tasks) and the week by day, with Beacon's page when there is one. */
  private renderMyTime(): Child[] {
    const t = this.t;
    const myTime = myTimeUrl(this.state.session?.server);
    if (this.entries === null) return [h('h2', { class: 'section-title', id: 'time-title' }, t('myTime')), h('p', { class: 'empty-state', id: 'time-unavailable' }, t('entriesUnavailable'))];
    return [
      h('h2', { class: 'section-title', id: 'time-title' }, t('todayEntries')),
      this.spanList('time-today', todaySpans(this.entries, this.state.activeTimer, this.now()), true),
      h('h2', { class: 'section-title', id: 'time-week-title' }, t('weekSummary')),
      this.weekList('time-week', 'time-week-title'),
      myTime !== null && this.beaconLink(myTime, t('myTimeInBeacon'), { id: 'time-open-beacon', key: 'time-open-beacon', className: 'my-time' }),
    ];
  }

  /** Today's stretches: `09:00–10:15 · task · 1:15` (the running one ends "now"). */
  private spanList(id: string, spans: DaySpan[], titles: boolean): HTMLElement {
    const t = this.t;
    if (spans.length === 0) return h('p', { class: 'muted', id: `${id}-empty` }, t('noEntriesToday'));
    return h(
      'ul',
      { class: 'spans', id },
      ...spans.map((span) =>
        h(
          'li',
          { class: span.running ? 'running' : undefined },
          h('span', { class: 'span-time' }, `${this.time(span.from)}–${span.running ? t('now') : this.time(span.to)}`),
          titles && h('span', { class: 'span-task', attrs: { title: span.taskTitle } }, span.taskTitle),
          h('span', { class: 'span-duration' }, formatHoursMinutes(span.seconds)),
        ),
      ),
    );
  }

  /** The week by day: name, a bar (decorative, scaled to the longest day or 8 h) and the time as text. */
  private weekList(id: string, labelledBy: string): HTMLElement {
    const now = this.now();
    const days = weekDays(this.entries ?? [], this.state.activeTimer, now);
    const longest = Math.max(8 * 3600, ...days.map((day) => day.seconds));
    const today = startOfDay(now).getTime();
    const weekday = new Intl.DateTimeFormat(this.locale, { weekday: 'short' });
    const total = days.reduce((sum, day) => sum + day.seconds, 0);
    return h(
      'div',
      { class: 'week', id },
      h(
        'ol',
        { class: 'week-days', attrs: { 'aria-labelledby': labelledBy } },
        ...days.map((day) => {
          const fill = h('span', { class: 'week-fill' });
          // Through the CSSOM (allowed by the CSP, unlike a style attribute).
          fill.style.width = `${Math.round((day.seconds / longest) * 100)}%`;
          const isToday = day.date.getTime() === today;
          return h(
            'li',
            { class: isToday ? 'today' : undefined, attrs: { 'aria-current': isToday ? 'date' : undefined } },
            h('span', { class: 'week-day' }, weekday.format(day.date)),
            h('span', { class: 'week-bar', attrs: { 'aria-hidden': 'true' } }, fill),
            h('span', { class: 'week-value' }, formatHoursMinutes(day.seconds)),
          );
        }),
      ),
      h('p', { class: 'week-total' }, h('span', {}, this.t('thisWeek')), h('strong', {}, formatHoursMinutes(total))),
    );
  }

  private toggleWhere(): void {
    this.showWhere = !this.showWhere;
    this.render();
  }

  private renderMessages(): void {
    const t = this.t;
    const signedIn = this.state.session !== null;
    patch(this.status, [
      this.notice !== null &&
        h('p', { class: this.noticeMoment !== null ? 'notice with-art' : 'notice', id: 'notice' }, this.noticeMoment !== null && moment(this.noticeMoment, 'mascot tiny', t), h('span', {}, this.notice)),
      this.offline && signedIn && h('p', { class: 'notice warn', id: 'offline' }, t('offline', { count: this.queue.size })),
    ]);
    patch(this.alert, [this.error !== null ? this.renderError(this.error) : null]);
  }

  private renderError(error: ErrorView): HTMLElement {
    const t = this.t;
    const pose = ERROR_POSES[error.id];
    const actions: Child[] = error.actions.map((action) => {
      switch (action) {
        case 'retry':
          return h('button', { class: 'secondary small', id: 'error-retry', key: 'error-retry', attrs: { type: 'button' }, on: { click: () => void this.retry() } }, icon('refresh'), t('actionRetry'));
        case 'copy':
          return h('button', { class: 'secondary small', id: 'error-copy', key: 'error-copy', attrs: { type: 'button' }, on: { click: () => void this.copy(error.details) } }, icon('copy'), t('actionCopyDetails'));
        case 'reconnect':
          return h('button', { class: 'secondary small', id: 'error-reconnect', attrs: { type: 'button' }, on: { click: () => void this.logout() } }, t('actionReconnect'));
        case 'help':
          return h('button', { class: 'link', id: 'error-help', attrs: { type: 'button' }, on: { click: () => this.toggleWhere() } }, t('whereFind'));
      }
    });
    return h(
      'section',
      { class: 'error-card', id: 'error', attrs: { 'aria-labelledby': 'error-title', 'data-error': error.id } },
      pose !== undefined && art(pose, '', 'error-art'),
      h('div', { class: 'error-body' },
        h('strong', { id: 'error-title' }, icon('alert'), t(error.title, error.params)),
        h('p', { id: 'error-text' }, t(error.text, error.params)),
        h('div', { class: 'row-actions' }, ...actions),
      ),
      this.iconButton('close', t('dismiss'), { id: 'error-dismiss', onClick: () => this.dismissError() }),
    );
  }

  /**
   * A link to Beacon: a real `<a href>` (keyboard focus, accessible name) whose click opens the browser through the
   * platform opener instead of navigating the app window. With `icon`, the visible content is an icon and the
   * accessible name is `label` (also shown as tooltip).
   */
  private beaconLink(url: string, label: string, options: { id?: string; key?: string; icon?: boolean; className?: string } = {}, ...content: Child[]): HTMLAnchorElement {
    return h(
      'a',
      {
        class: [options.icon ? 'beacon-link icon' : 'beacon-link', options.className].filter(Boolean).join(' '),
        id: options.id,
        key: options.key,
        attrs: {
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          'aria-label': options.icon ? label : undefined,
          title: options.icon ? label : undefined,
        },
        on: {
          click: (event) => {
            event.preventDefault();
            this.openBeacon(url);
          },
          // Right-click / long-press (and the context-menu key): Open / Copy link.
          contextmenu: (event) => {
            event.preventDefault();
            event.stopPropagation();
            const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
            const mouse = event as MouseEvent;
            this.openLinkMenu(url, this.beaconRule(), mouse.clientX || box.left, mouse.clientY || box.bottom);
          },
        },
      },
      ...(content.length > 0 ? content : [options.icon ? icon('external') : label]),
    );
  }

  private renderLogin(): HTMLElement {
    const t = this.t;
    const problem = this.serverProblem;
    const server = h('input', {
      id: 'server',
      attrs: {
        type: 'text',
        inputmode: 'url',
        autocomplete: 'url',
        spellcheck: 'false',
        autocapitalize: 'off',
        placeholder: 'beacon.example.com',
        'aria-invalid': problem !== null || this.error !== null ? 'true' : 'false',
        'aria-describedby': problem !== null ? 'server-problem server-help' : 'server-help',
      },
    });
    server.value = this.serverDraft;
    server.addEventListener('input', () => {
      this.serverDraft = server.value;
    });
    return h(
      'form',
      {
        id: 'login-form',
        attrs: { novalidate: true },
        on: {
          submit: (event) => {
            event.preventDefault();
            void this.connect(server.value);
          },
        },
      },
      moment('firstRun', 'mascot', t),
      h('h2', {}, t('loginTitle')),
      h('p', { class: 'help' }, t('loginHelp')),
      h('label', { attrs: { for: 'server' } }, t('serverUrl')),
      server,
      problem !== null && h('p', { class: 'field-error', id: 'server-problem' }, icon('alert'), t(URL_PROBLEMS[problem])),
      h('p', { class: 'help', id: 'server-help' }, t('serverHelp'), ' ', h('button', { class: 'link', id: 'where', attrs: { type: 'button', 'aria-expanded': this.showWhere ? 'true' : 'false', 'aria-controls': 'where-text' }, on: { click: () => this.toggleWhere() } }, t('whereFind'))),
      this.showWhere && h('p', { class: 'sheet', id: 'where-text' }, t('whereText')),
      h('button', { class: 'primary', id: 'connect', attrs: { type: 'submit', disabled: this.busy } }, this.busy ? t('connecting') : t('connect')),
      h('button', { class: 'link', id: 'open-privacy', attrs: { type: 'button' }, on: { click: () => this.show('privacy') } }, t('whatWeCollect')),
    );
  }

  private renderDevice(): HTMLElement {
    const t = this.t;
    const code = this.device;
    const safe = this.deviceUrl;
    if (this.deviceState !== 'waiting' || code === null) {
      const expired = this.deviceState === 'expired';
      const titleKey: MessageKey = expired ? 'deviceExpiredTitle' : this.deviceState === 'denied' ? 'deviceDeniedTitle' : 'deviceScope';
      return h(
        'main',
        { id: 'device', class: 'center' },
        moment(expired ? 'deviceExpired' : 'deviceDenied', 'mascot small', t),
        h('h2', { id: 'device-state', attrs: { tabindex: '-1' } }, t(titleKey)),
        this.deviceState !== 'scope' && h('p', { class: 'help' }, t(expired ? 'deviceExpiredText' : 'deviceDeniedText')),
        h('button', { class: 'primary', id: 'new-code', key: 'new-code', attrs: { type: 'button', disabled: this.busy }, on: { click: () => void this.connect(this.serverDraft) } }, icon('refresh'), t(expired ? 'newCode' : 'tryAgain')),
        h('button', { class: 'secondary', id: 'cancel-device', on: { click: () => this.cancelDevice() } }, t('cancel')),
      );
    }
    const total = Math.max(1, code.expiresIn);
    const remaining = () => total - (this.now().getTime() - this.deviceStarted) / 1000;
    const bar = h('div', { class: 'progress-bar' });
    const progress = h('div', { class: 'progress', attrs: { role: 'progressbar', 'aria-label': t('codeExpiry'), 'aria-valuemin': '0', 'aria-valuemax': String(total) } }, bar);
    const left = h('span', { id: 'expires' });
    const updateCountdown = () => {
      const seconds = Math.max(0, remaining());
      bar.style.width = `${(seconds / total) * 100}%`;
      progress.setAttribute('aria-valuenow', String(Math.ceil(seconds)));
      progress.setAttribute('aria-valuetext', t('expiresIn', { time: countdown(seconds) }));
      left.textContent = t('expiresIn', { time: countdown(seconds) });
      if (seconds <= 60 && !this.deviceAnnounced) {
        this.deviceAnnounced = true;
        this.announce(t('expiresSoon'));
      }
    };
    updateCountdown();
    if (this.deviceTicker !== null) clearInterval(this.deviceTicker);
    this.deviceTicker = setInterval(updateCountdown, 1000);
    const spelled = code.userCode
      .split('')
      .map((char) => (char === '-' ? t('dash') : char))
      .join(' ');
    return h(
      'main',
      { id: 'device' },
      h('div', { class: 'mascot-wait', attrs: { 'aria-hidden': 'true' } }, moment('deviceWaiting', 'mascot', t), art('mascot-arcs', '', 'mascot arcs')),
      h('h2', {}, t('deviceTitle')),
      safe !== null
        ? h('p', { class: 'help' }, t('deviceHelp', { uri: code.verificationUri }))
        : h('p', { class: 'error', id: 'device-untrusted' }, t('deviceUntrusted'), ' ', h('code', {}, this.deviceUntrusted ?? '')),
      h('p', { class: 'user-code', id: 'user-code', attrs: { 'aria-label': t('codeLabel', { code: spelled }) } }, code.userCode),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'secondary', id: 'copy-code', key: 'copy-code', attrs: { type: 'button' }, on: { click: () => void this.copy(code.userCode) } }, icon('copy'), t('copyCode')),
        safe !== null &&
          h('button', { class: 'secondary', id: 'open-again', key: 'open-again', attrs: { type: 'button' }, on: { click: () => void this.openExternal(safe, { kind: 'device', server: this.deviceServer }) } }, icon('external'), t('openAgain')),
        safe !== null && this.copyButton(safe, t('copyLink'), 'copy-device-link', { kind: 'device', server: this.deviceServer }),
        safe === null &&
          h('button', { class: 'secondary', id: 'copy-address', attrs: { type: 'button' }, on: { click: () => void this.copy(this.deviceUntrusted ?? '') } }, icon('copy'), t('copyAddress')),
      ),
      progress,
      h('p', { class: 'muted', attrs: { 'aria-live': 'off' } }, left, ' · ', t('waiting')),
      h('button', { class: 'secondary', id: 'cancel-device', on: { click: () => this.cancelDevice() } }, t('cancel')),
    );
  }

  /** Main screen: built once per session, then each region is patched in place (the search field is never replaced). */
  private renderMain(): void {
    if (this.main === null) this.main = this.buildMain();
    const main = this.main;
    if (main.root.parentElement !== this.body) this.body.replaceChildren(main.root);
    this.renderBanners(main.banners);
    this.renderTimer(main.timer);
    this.renderTotals(main.totals);
    this.renderLists(main);
    const section = this.currentSection();
    (main.search.parentElement as HTMLElement).hidden = section !== 'tasks';
    main.quick.hidden = section === 'time';
    main.list.hidden = section !== 'tasks';
    main.time.hidden = section !== 'time';
    patch(main.time, section === 'time' ? this.renderMyTime() : []);
    patch(main.footer, [h('span', {}, this.t('signedInAs', { name: this.state.session?.displayName ?? this.state.session?.identifier ?? '' }))]);
    this.renderModal(main);
  }

  /**
   * "Still there?" and what follows it, as a modal: the rest of the app is inert until it is answered. Not used while
   * the prompt has its own window (Tauri), which `syncPromptWindow` keeps up to date instead.
   */
  private renderModal(main: MainRegions): void {
    const view = this.promptInWindow() ? null : this.promptView();
    const open = view !== null;
    // Visible (and the rest inert) before the prompt is drawn, so it can take the focus.
    main.modal.hidden = !open;
    for (const child of [this.header, this.sidebar, this.detail, ...Array.from(main.root.children)]) {
      if (child !== main.modal) child.toggleAttribute('inert', open);
    }
    main.prompt.show(view);
  }

  /** Whether the prompt goes to its own window (Tauri) rather than the in-app modal (also after that window failed). */
  promptInWindow(): boolean {
    return this.platform.promptWindow !== null && !this.promptWindowFailed;
  }

  /** Opens, updates or closes the prompt window from the current state (whatever view the main window shows). */
  private syncPromptWindow(): void {
    const host = this.platform.promptWindow;
    if (host === null || this.promptWindowFailed) return;
    if (!this.promptAnswers) {
      // Listening before the window first opens, so no answer is lost.
      this.promptAnswers = true;
      host.onAnswer((answer) => void this.answerPrompt(answer));
    }
    const view = this.state.session !== null ? this.promptView() : null;
    const key = view === null ? '' : JSON.stringify(view);
    if (key === this.promptWindowKey) return;
    const wasOpen = this.promptWindowKey !== '';
    this.promptWindowKey = key;
    if (view === null) {
      if (wasOpen) void host.close().catch(() => undefined);
      return;
    }
    host.open(view).catch(() => {
      // No window (the OS refused it): the prompt comes back as the in-app modal.
      this.promptWindowFailed = true;
      this.promptWindowKey = '';
      this.render();
    });
  }

  /** Cheers, moments and "daily done" as toasts (bottom right, never focused, announced once). */
  private renderToasts(): void {
    const card = this.view === 'main' ? this.currentCard() : null;
    const daily = this.view === 'main' ? this.dailyToast : null;
    const reminder = this.view === 'main' ? this.visibleReminder() : null;
    const nudge = this.view === 'main' ? this.visibleNudge() : null;
    const meeting = this.view === 'main' ? this.meetingNote() : null;
    const upcoming = this.view === 'main' ? this.meetingReminder : null;
    const key = `${upcoming === null ? '' : `${upcoming.kind}:${upcoming.key}:${upcoming.body}:${JSON.stringify(this.meetingReminderPicker)}:${this.tasks.length}`}|${card === null ? '' : `${card.kind}:${card.line}:${card.shownAt}`}|${daily?.text ?? ''}|${reminder === null ? '' : `${reminder.slot}:${reminder.shownAt}:${this.reminderActionable(reminder)}`}|${nudge?.shownAt ?? ''}|${meeting === null ? '' : `${meeting.text}:${meeting.actions.join()}:${this.meetingPicker}:${this.meetingQuery}:${this.tasks.length}`}`;
    if (key === this.toastKey) return;
    this.toastKey = key;
    patch(this.toastRegion, [
      upcoming !== null && this.renderMeetingReminderToast(upcoming),
      meeting !== null && this.renderMeetingQuestion(meeting),
      reminder !== null && this.renderReminder(reminder),
      nudge !== null && this.renderNudge(nudge),
      card !== null && this.renderCheer(),
      daily !== null && this.toast('daily-toast', daily.pose, daily.text, daily.locale, () => this.showDailyToast(null)),
    ]);
    // While a toast is up, the page gets room below its last rows (the list never ends under the toast).
    const shown = this.toastRegion.childElementCount > 0;
    this.root.classList.toggle('with-toasts', shown);
    const height = this.toastRegion.getBoundingClientRect().height;
    if (shown && height > 0) this.root.style.setProperty('--toast-space', `${Math.ceil(height) + 24}px`);
    else this.root.style.removeProperty('--toast-space');
  }

  private toast(id: string, pose: PoseId, text: string, locale: string, dismiss: () => void, kind?: string, extra: Child = null): HTMLElement {
    return h(
      'section',
      { class: 'toast', id, key: id, attrs: { 'aria-label': this.t('cheerLabel'), 'data-kind': kind } },
      poseArt(pose, 'toast-art'),
      h('div', { class: 'toast-body' }, h('p', { class: 'toast-text', id: `${id}-text`, attrs: { lang: locale } }, text), extra),
      h('button', { class: 'icon-button toast-close', id: `${id}-dismiss`, key: `${id}-dismiss`, attrs: { type: 'button', 'aria-label': this.t('toastDismiss'), title: this.t('toastDismiss') }, on: { click: dismiss } }, icon('close')),
    );
  }

  private buildMain(): MainRegions {
    const t = this.t;
    const modal = h('div', { class: 'idle-modal', id: 'idle-modal', attrs: { hidden: true } });
    const search = h('input', {
      id: 'search',
      attrs: { type: 'search', placeholder: t('searchTasks'), 'aria-label': t('searchLabel'), 'aria-describedby': 'search-hint', 'aria-keyshortcuts': 'Control+K /', autocomplete: 'off' },
    });
    search.value = this.query;
    search.addEventListener('input', () => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.query = search.value;
      this.rendering = true;
      try {
        this.renderLists(this.main as MainRegions);
      } finally {
        this.rendering = false;
      }
      this.searchTimer = setTimeout(() => void this.search(search.value), this.deps.searchDelayMs ?? 250);
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && search.value !== '') {
        event.preventDefault();
        search.value = '';
        search.dispatchEvent(new Event('input'));
      } else {
        this.onListKey(event);
      }
    });
    const regions: MainRegions = {
      root: h('main', { id: 'main' }),
      banners: h('div', { class: 'banners' }),
      timer: h('section', { class: 'card', id: 'timer', attrs: { 'aria-label': t('timerLabel') } }),
      totals: h('section', { class: 'totals', id: 'totals', attrs: { 'aria-label': t('totalsLabel') } }),
      search,
      quick: h('section', { class: 'list-section', id: 'quick-section' }),
      list: h('section', { class: 'list-section', id: 'list-section' }),
      time: h('section', { class: 'list-section', id: 'time-section', attrs: { hidden: true, 'aria-labelledby': 'time-title' } }),
      scroller: h('div', { class: 'task-scroll', id: 'task-scroll' }),
      footer: h('footer', { class: 'footer' }),
      modal,
      prompt: new PromptMount(modal, { onAnswer: (answer) => void this.answerPrompt(answer), onExpired: () => void this.tick(), now: this.now }),
    };
    regions.scroller.append(regions.banners, regions.quick, regions.list, regions.time);
    regions.root.addEventListener('keydown', (event) => {
      if (event.target !== search && !regions.modal.contains(event.target as Node)) this.onListKey(event);
    });
    // Full layout: a row clicked or reached with the keyboard shows in the detail pane.
    const pick = (event: Event) => {
      if (this.rendering) return;
      const row = (event.target as Element | null)?.closest?.('li[data-task]');
      if (row instanceof HTMLElement && row.dataset.task !== undefined) this.selectTask(row.dataset.task);
    };
    regions.root.addEventListener('focusin', pick);
    regions.root.addEventListener('click', pick);
    // The timer, totals, search and footer stay in place; only the lists (and the banners above them) scroll, inside
    // their own container, so the window itself never scrolls.
    regions.root.append(
      regions.timer,
      regions.totals,
      h('div', { class: 'search' }, icon('search'), search),
      h('p', { class: 'sr-only', id: 'search-hint' }, t('searchHint')),
      regions.scroller,
      regions.footer,
      regions.modal,
    );
    return regions;
  }

  private renderBanners(region: HTMLElement): void {
    const t = this.t;
    patch(region, [
      this.promptInWindow() && this.state.idleCheck.phase !== 'watching' && this.renderPromptElsewhere(),
      this.nativeNotice !== null && this.renderNativeNotice(),
      this.pinExpired && this.renderPinExpired(),
      this.renderUpdateCard(),
      ...this.renderMeetingBanners(),
      this.welcome && this.error === null && this.renderWelcome(),
      this.longRunning() && this.renderLongRunning(),
      this.updateMessage !== null &&
        h(
          'section',
          { class: 'card update', id: 'update-message' },
          h('span', {}, this.updateMessage),
          h('button', { class: 'secondary small', id: 'download-beacon', on: { click: () => this.openApps() } }, t('downloadFromBeacon')),
        ),
      this.clampNotes.length > 0 && this.renderClamps(),
      this.offline &&
        h(
          'section',
          { class: 'card still-there offline-card', id: 'offline-card', attrs: { role: 'region', 'aria-labelledby': 'offline-title' } },
          moment('offline', 'mascot tiny', t),
          h('div', { class: 'still-there-body' }, h('h2', { id: 'offline-title' }, t('offlineTitle')), h('p', { class: 'muted' }, t('offlineStartNote'))),
        ),
    ]);
  }

  /** The question is in its own window: say so, and offer to bring it forward (it may be behind a full-screen app). */
  private renderPromptElsewhere(): HTMLElement {
    const t = this.t;
    return this.momentCard(
      'prompt-elsewhere',
      'stillThere',
      t(this.inMeeting() && this.state.idleCheck.phase === 'asking' ? 'stillInMeetingTitle' : 'stillThereTitle'),
      h('p', { class: 'muted', id: 'prompt-elsewhere-text' }, t('promptElsewhere')),
      h('div', { class: 'row-actions' }, h('button', { class: 'secondary small', id: 'prompt-show', key: 'prompt-show', attrs: { type: 'button' }, on: { click: () => void this.platform.promptWindow?.focus() } }, t('promptShow'))),
    );
  }

  /** Once: the friendly messages now appear as desktop notifications; or: the OS turned them off, they stay here. */
  private renderNativeNotice(): HTMLElement {
    const t = this.t;
    const intro = this.nativeNotice === 'intro';
    return h(
      'section',
      { class: 'card native-notice', id: 'native-notice', key: 'native-notice', attrs: { role: 'region', 'aria-labelledby': 'native-notice-title' } },
      h('h2', { id: 'native-notice-title' }, t(intro ? 'nativeIntroTitle' : 'nativeOffTitle')),
      h('p', { class: 'muted', id: 'native-notice-text' }, t(intro ? 'nativeIntroText' : 'nativeOffText')),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'secondary small', id: 'native-notice-ok', key: 'native-notice-ok', attrs: { type: 'button' }, on: { click: () => this.dismissNativeNotice() } }, t('gotIt')),
        intro && h('button', { class: 'link', id: 'native-notice-in-app', key: 'native-notice-in-app', attrs: { type: 'button' }, on: { click: () => this.setDesktopNotifications(false) } }, t('nativeKeepInApp')),
      ),
    );
  }

  /** The pin set of this build expired: update the app (the line in Settings says the same). */
  private renderPinExpired(): HTMLElement {
    const t = this.t;
    return h(
      'section',
      { class: 'card native-notice', id: 'pin-expired', key: 'pin-expired', attrs: { role: 'region', 'aria-labelledby': 'pin-expired-title' } },
      h('h2', { id: 'pin-expired-title' }, t('pinExpiredTitle')),
      h('p', { class: 'muted', id: 'pin-expired-text' }, t('connPinExpired', { host: hostOf(this.state.session?.server) })),
      h('div', { class: 'row-actions' }, h('button', { class: 'secondary small', id: 'pin-expired-ok', key: 'pin-expired-ok', attrs: { type: 'button' }, on: { click: () => this.dismissPinExpired() } }, t('gotIt'))),
    );
  }

  /** Calm card with a mascot moment, a heading and its content (welcome, long-running, idle check, update). */
  private momentCard(id: string, name: Moment, title: string, ...children: Child[]): HTMLElement {
    return this.pictureCard(id, name, moment(name, 'mascot tiny', this.t), title, ...children);
  }

  private pictureCard(id: string, name: Moment, picture: Element, title: string, ...children: Child[]): HTMLElement {
    return h(
      'section',
      { class: 'card still-there', id, key: id, attrs: { role: 'region', 'aria-labelledby': `${id}-title`, 'data-moment': name } },
      picture,
      h('div', { class: 'still-there-body' }, h('h2', { id: `${id}-title` }, title), ...children),
    );
  }

  /** "You're in": right after the device sign-in, until "Got it" or the first Start. */
  private renderWelcome(): HTMLElement {
    const t = this.t;
    return this.momentCard(
      'welcome',
      'signedIn',
      t('welcomeTitle'),
      h('p', {}, t('welcomeText', { host: hostOf(this.state.session?.server ?? null) })),
      h('div', { class: 'row-actions' }, h('button', { class: 'secondary small', id: 'welcome-dismiss', key: 'welcome-dismiss', attrs: { type: 'button' }, on: { click: () => this.dismissWelcome() } }, t('gotIt'))),
    );
  }

  /** Gentle nudge on a timer left running for hours (forgotten Stop): never stops it by itself. */
  private renderLongRunning(): HTMLElement | null {
    const t = this.t;
    const timer = this.state.activeTimer;
    if (timer === null) return null;
    const hours = Math.floor(elapsedSeconds(timer.startedAt, this.now()) / 3600);
    return this.momentCard(
      'long-running',
      'longRunning',
      t('longRunningTitle'),
      h('p', { id: 'long-running-text' }, t('longRunningText', { task: timer.taskTitle, hours })),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'secondary small', id: 'long-running-stop', key: 'long-running-stop', attrs: { type: 'button' }, on: { click: () => this.whenIdle(() => this.stop()) } }, icon('stop'), t('longRunningStop')),
        h('button', { class: 'link', id: 'long-running-keep', key: 'long-running-keep', attrs: { type: 'button' }, on: { click: () => this.keepGoing() } }, t('longRunningKeep')),
      ),
    );
  }

  /** A working-hours reminder as a toast: its line, the button (Start / Stop / Resume) while it applies, ×. */
  private renderReminder(note: ReminderNote): HTMLElement {
    const action = note.action !== null && note.actionLabel !== null && this.reminderActionable(note)
      ? toastAction('reminder-action', note.actionLabel, note.locale, () => void this.reminderAction(note.action), { 'data-action': note.action })
      : null;
    return this.toast('reminder', note.pose, note.text, note.locale, () => this.showReminderToast(null), note.kind, action);
  }

  /** "Working without a timer?" inside the window, with "Start <last task>" and "Choose task". */
  private renderNudge(note: NudgeNote): HTMLElement {
    const actions = toastActions(
      undefined,
      note.resume !== null && toastAction('nudge-resume', note.resume.label, note.locale, () => void this.nudgeAction('resume')),
      toastAction('nudge-choose', note.choose.label, note.locale, () => void this.nudgeAction('choose')),
    );
    return this.toast('nudge', note.pose, note.text, note.locale, () => this.showNudgeToast(null), 'nudge', actions);
  }

  /** A friendly message: smile, cheer or a gentle nudge, in the Beacon user's language. A toast, never focused. */
  private renderCheer(): HTMLElement | null {
    const card = this.currentCard();
    const timer = this.state.activeTimer;
    if (card === null || timer === null) return null;
    const hours = Math.floor(elapsedSeconds(timer.startedAt, this.now()) / 3600);
    const line = lineText(card.locale, card.kind, card.line, { hours });
    if (line === null) return null;
    return this.toast('cheer', line.pose, line.text, card.locale, () => this.dismissCheer(), card.kind);
  }

  /**
   * "Version X is available": calm card with the small mascot (moss / mist, never alert colours), non-blocking, a named
   * region; progress in a native <progress>; announcements through the persistent polite live region.
   */
  private renderUpdateCard(): HTMLElement | null {
    const t = this.t;
    const update = this.update;
    if (update === null || !update.installable || this.updateMessage !== null || this.channel === 'store') return null;
    const stage = this.updateStage;
    if (stage === 'offer' && this.updateLater === update.version) return null;
    const button = (id: string, kind: string, label: string, onClick: () => void, extra: Record<string, string> = {}) =>
      h('button', { class: `${kind} small`, id, key: id, attrs: { type: 'button', ...extra }, on: { click: onClick } }, label);
    let body: Child[];
    if (stage === 'downloading' || stage === 'installing') {
      const percent = this.updatePercent();
      const progress = h('progress', { id: 'update-progress', key: 'update-progress', attrs: { max: '100', 'aria-labelledby': 'update-progress-label' } });
      if (stage === 'downloading' && percent !== null) progress.value = percent;
      else if (stage === 'installing') progress.value = 100;
      body = [
        h(
          'p',
          { id: 'update-progress-label' },
          stage === 'installing'
            ? t('updateInstalling', { version: update.version })
            : percent !== null
              ? t('updateDownloading', { version: update.version, percent })
              : t('updateDownloadingShort', { version: update.version }),
        ),
        progress,
      ];
    } else if (stage === 'confirm-running') {
      body = [
        h('p', { id: 'update-running' }, t('updateRunningText', { task: this.state.activeTimer?.taskTitle ?? '' })),
        h(
          'div',
          { class: 'choice-list', attrs: { role: 'group', 'aria-labelledby': 'update-title' } },
          button('update-after-stop', 'primary', t('updateAfterStop'), () => this.updateAfterStop()),
          button('update-anyway', 'secondary', t('updateAnyway'), () => void this.installUpdate()),
          button('update-cancel', 'link', t('cancel'), () => this.cancelUpdateChoice()),
        ),
      ];
    } else if (stage === 'after-stop') {
      body = [
        h('p', { id: 'update-waiting' }, t('updateWaiting')),
        h(
          'div',
          { class: 'row-actions' },
          button('update-anyway', 'secondary', t('updateAnyway'), () => void this.installUpdate()),
          button('update-cancel', 'link', t('cancel'), () => this.cancelUpdateChoice()),
        ),
      ];
    } else {
      body = [
        h('p', { class: 'muted' }, t('updateCardText', { current: this.version })),
        h(
          'div',
          { class: 'row-actions' },
          update.notes !== null &&
            button('update-notes-toggle', 'link', t('updateWhatsNew'), () => this.toggleUpdateNotes(), {
              'aria-expanded': this.updateNotesOpen ? 'true' : 'false',
              'aria-controls': 'update-notes',
            }),
          button('update-now', 'primary', t('updateNow'), () => this.updateNow()),
          button('update-later', 'secondary', t('updateLaterShort'), () => this.updateLaterClick()),
        ),
        update.notes !== null && this.updateNotesOpen && h('div', { class: 'update-notes', id: 'update-notes', attrs: { tabindex: '0', role: 'region', 'aria-label': t('updateWhatsNew') } }, update.notes),
      ];
    }
    return h(
      'section',
      { class: 'card still-there update-card', id: 'update', key: 'update', attrs: { role: 'region', 'aria-labelledby': 'update-title' } },
      moment(stage === 'downloading' || stage === 'installing' ? 'updateWorking' : 'updateOffer', 'mascot tiny', t),
      h('div', { class: 'still-there-body' }, h('h2', { id: 'update-title' }, t('updateCardTitle', { version: update.version })), ...body),
    );
  }

  private renderTimer(region: HTMLElement): void {
    const t = this.t;
    const timer = this.state.activeTimer;
    if (timer === null) {
      const last = this.lastTask();
      region.className = 'card';
      patch(
        region,
        [
          h('span', { class: 'chip' }, '○ ', t('notTracking')),
          last !== null ? h('p', { class: 'last', id: 'last-task' }, t('lastTask', { task: last.title })) : h('p', { class: 'last', id: 'idle-hint' }, t('idleHint')),
          last !== null &&
            this.state.idleCheck.phase !== 'resume' &&
            h(
              'div',
              { class: 'continue-last' },
              h(
                'button',
                {
                  class: 'primary',
                  id: 'resume',
                  key: 'resume',
                  attrs: { 'aria-disabled': this.busy ? 'true' : undefined, 'aria-label': t('continueLastTask', { task: last.title }), 'aria-describedby': 'continue-shortcut', 'aria-keyshortcuts': 'Control+Shift+S' },
                  on: { click: () => this.whenIdle(() => this.continueLast()) },
                },
                icon('play'),
                t('continueLast'),
              ),
              h('small', { class: 'muted', id: 'continue-shortcut' }, t('continueShortcutHint', { shortcut: shortcutLabel(this.state.settings.resumeShortcut) })),
            ),
        ],
        '#search',
      );
      return;
    }
    const task = this.timerTask(timer);
    const elapsed = h('span', { class: 'elapsed', id: 'elapsed', attrs: { role: 'timer', 'aria-live': 'off' } }, formatElapsed(elapsedSeconds(timer.startedAt, this.now())));
    this.ticker = setInterval(() => {
      elapsed.textContent = formatElapsed(elapsedSeconds(timer.startedAt, this.now()));
    }, 1000);
    const link = this.timerUrl(timer);
    const started = new Date(Date.parse(timer.startedAt));
    const meta = [taskContext(task), Number.isNaN(started.getTime()) ? '' : t('since', { time: this.timeFormat.format(started) })].filter((part) => part !== '').join(' · ');
    region.className = 'card running';
    patch(
      region,
      [
        h('span', { class: 'chip' }, '● ', t('tracking')),
        elapsed,
        h('strong', { id: 'timer-task', class: 'title' }, timer.taskTitle),
        h('span', { class: 'meta', id: 'timer-meta' }, meta),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'danger', id: 'stop', key: 'stop', attrs: { 'aria-disabled': this.busy ? 'true' : undefined, 'aria-label': t('stopTask', { task: timer.taskTitle }), 'aria-keyshortcuts': 'Control+Shift+S' }, on: { click: () => this.whenIdle(() => this.stop()) } }, icon('stop'), t('stop')),
          link !== null && this.beaconLink(link, t('openTaskInBeacon', { title: timer.taskTitle }), { id: 'timer-open-in-beacon', key: 'timer-open-in-beacon', icon: true }),
          link !== null && this.copyButton(link, t('copyTaskLink', { title: timer.taskTitle }), 'timer-copy-link'),
        ),
      ],
      '#search',
    );
  }

  private renderTotals(region: HTMLElement): void {
    const t = this.t;
    const totals = this.totals();
    if (totals === null) {
      patch(region, []);
      return;
    }
    const myTime = myTimeUrl(this.state.session?.server);
    const tile = (id: string, label: string, seconds: number) => {
      const content = [h('span', { class: 'label' }, label), h('span', { class: 'value' }, formatHoursMinutes(seconds))];
      return myTime !== null
        ? this.beaconLink(myTime, `${label} ${formatHoursMinutes(seconds)} — ${t('myTime')}`, { id, key: id, className: 'tile', icon: false }, ...content)
        : h('div', { class: 'tile', id }, ...content);
    };
    patch(region, [
      tile('total-today', t('today'), totals.today),
      tile('total-week', t('thisWeek'), totals.week),
      myTime !== null &&
        h('span', { class: 'my-time-actions', key: 'my-time-actions' }, this.beaconLink(myTime, t('myTime'), { id: 'open-my-time', key: 'open-my-time', className: 'my-time' }), this.copyButton(myTime, t('copyMyTimeLink'), 'copy-my-time')),
    ]);
  }

  private renderLists(main: MainRegions): void {
    const t = this.t;
    const searching = this.query.trim() !== '' && this.currentSection() === 'tasks';
    const perTask = this.entries !== null ? todayByTask(this.entries, this.state.activeTimer, this.now()) : new Map<string, number>();
    const quick = this.quickTasks();
    // No task at all: only the "Open the tasks in Beacon" state, in the list's slot.
    const noTasks = !searching && !this.busy && this.tasks.length === 0 && this.entries !== null;
    if (searching) {
      patch(main.quick, [], '#search');
    } else {
      patch(
        main.quick,
        [
          h('h2', { class: 'section-title', id: 'quick-title' }, t('pinnedRecent')),
          quick.length > 0
            ? h('ul', { class: 'tasks', id: 'quick', attrs: { 'aria-labelledby': 'quick-title' } }, ...quick.map((task, index) => this.taskRow(task, perTask, index + 1)))
            : this.emptyState(quickEmptyState(0, this.state.lastTask !== null) ?? 'recent', 'quick-empty'),
        ].filter(() => !noTasks || quick.length > 0),
        '#search',
      );
    }
    const query = this.query.trim().toLowerCase();
    const visible = this.visibleTasks().filter((task) => !searching || task.title.toLowerCase().includes(query) || task.id.toLowerCase() === query || this.tasks.includes(task));
    const localMatches = searching ? quick.filter((task) => task.title.toLowerCase().includes(query) && !visible.some((item) => item.id === task.id)) : [];
    const rows = [...localMatches, ...visible];
    patch(
      main.list,
      [
        h('h2', { class: 'section-title', id: 'list-title' }, t(searching ? 'searchResults' : 'allTasks')),
        h('ul', { class: 'tasks', id: 'tasks', attrs: { 'aria-labelledby': 'list-title' } }, ...rows.map((task) => this.taskRow(task, perTask))),
        rows.length === 0 &&
          !this.busy &&
          (searching || this.tasks.length > 0
            ? h('p', { class: 'empty-state', id: 'tasks-empty' }, moment(searching ? 'noResults' : 'noTasks', 'mascot tiny', t), h('span', {}, searching ? t('noResults', { query: this.query.trim() }) : t('noTasks')))
            : this.emptyState('tasks', 'tasks-empty')),
      ],
      this.state.activeTimer !== null ? 'stop' : '#search',
    );
  }

  /**
   * Empty state with the mascot (src/lib/emptyStates.ts): the same fixed-height slot in all three, one line and one
   * action, in the language of the friendly messages.
   */
  private emptyState(state: EmptyState, id: string): HTMLElement {
    const text = EMPTY_TEXTS[this.messageLocale()][state];
    const action = state === 'pinned' ? () => this.showPinHint() : state === 'recent' ? () => this.focusSearch() : () => this.openBeacon(tasksPage(this.state.session?.server ?? ''));
    return h(
      'div',
      { class: 'empty-slot', id, key: `${id}-${state}`, attrs: { 'data-empty': state } },
      emptyArt(EMPTY_POSES[state], text.alt, 'empty-art'),
      h('p', { class: 'empty-line' }, text.line),
      h('button', { class: 'secondary small', id: `${id}-action`, key: `${id}-action-${state}`, attrs: { type: 'button' }, on: { click: action } }, icon(state === 'pinned' ? 'pin' : state === 'recent' ? 'play' : 'external'), text.action),
    );
  }

  /** "Pin a task": scrolls to the list, marks the pin buttons for a moment and says what they do. */
  showPinHint(): void {
    const list = this.main?.list;
    // `container: 'nearest'`: only the list's own scroller moves, never the window.
    list?.scrollIntoView?.({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start', container: 'nearest' } as ScrollIntoViewOptions);
    list?.classList.add('pin-hint');
    setTimeout(() => list?.classList.remove('pin-hint'), 4000);
    this.setNotice(PIN_HINT[this.messageLocale()]);
    list?.querySelector<HTMLElement>('.pin')?.focus();
  }

  private taskRow(task: Task, perTask: Map<string, number>, number?: number): HTMLElement {
    const t = this.t;
    const running = this.state.activeTimer !== null;
    const link = taskUrl(task.url, this.state.session?.server);
    const pinned = this.isPinned(task.id);
    const seconds = perTask.get(task.id) ?? 0;
    const meta = [taskContext(task), seconds > 0 ? t('todayOnTask', { time: formatHoursMinutes(seconds) }) : ''].filter((part) => part !== '').join(' · ');
    const label = running ? t('switchTask', { task: task.title }) : t('startTask', { task: task.title });
    const selected = this.fullLayout() && this.detailTask()?.id === task.id;
    return h(
      'li',
      { class: selected ? 'selected' : undefined, attrs: { 'data-task': task.id, 'aria-current': selected ? 'true' : undefined } },
      h('button', {
        class: pinned ? 'icon-button pin pinned' : 'icon-button pin',
        key: `pin-${task.id}`,
        attrs: { type: 'button', 'aria-pressed': pinned ? 'true' : 'false', 'aria-label': t(pinned ? 'unpinTask' : 'pinTask', { task: task.title }), title: t(pinned ? 'unpinTask' : 'pinTask', { task: task.title }), tabindex: '-1' },
        on: { click: () => this.togglePin(task) },
      }, icon('pin')),
      h('span', { class: 'task' }, h('span', { class: 'title', attrs: { title: task.title } }, task.title), meta !== '' ? h('small', {}, meta) : null),
      number !== undefined && h('kbd', { class: 'shortcut', attrs: { 'aria-hidden': 'true' } }, String(number)),
      link !== null && this.beaconLink(link, t('openTaskInBeacon', { title: task.title }), { icon: true, key: `link-${task.id}` }),
      h(
        'button',
        {
          class: 'primary small row-action',
          key: `start-${task.id}`,
          attrs: { type: 'button', 'aria-disabled': this.busy ? 'true' : undefined, 'aria-label': label, title: label, 'aria-keyshortcuts': number !== undefined ? `Alt+${number}` : undefined },
          on: { click: () => this.whenIdle(() => this.start(task)) },
        },
        icon(running ? 'switch' : 'play'),
        h('span', { class: 'button-text' }, running ? t('switch') : t('start')),
      ),
    );
  }

  private time(iso: string | Date): string {
    return this.timeFormat.format(typeof iso === 'string' ? new Date(iso) : iso);
  }

  /** Asks the prompt (in-app modal or its window) to focus `id` after the next update. */
  private focusPrompt(id: string): void {
    this.promptFocus = { id, seq: this.promptFocus.seq + 1 };
  }

  /**
   * The "Still there?" prompt, the "welcome back" gap question and the Resume offer, as data (src/ui/prompt.ts): drawn
   * in its own always-on-top window in the Tauri app, as a modal in the main window otherwise. Translated here, so the
   * prompt window needs no translator; the countdown runs on wall-clock timestamps.
   */
  promptView(): PromptView | null {
    const t = this.t;
    const state = this.state.idleCheck;
    if (state.phase === 'watching') return this.meetingPromptView();
    // The "Still there?" phrasing of this prompt (Fun messages), with its own pose; the facts and buttons stay the same.
    // During a meeting-like task: the softer "Still in the meeting?" and the teamwork pose.
    const locale = this.messageLocale();
    const meeting = this.inMeeting();
    const quip = state.phase === 'asking' && this.state.settings.funMessages && this.state.messages.idleLine !== null ? lineText(locale, meeting ? 'meetingIdle' : 'idle', this.state.messages.idleLine) : null;
    const text = (value: string, id?: string, tone?: PromptText['tone'], lang?: string): PromptText => ({ kind: 'text', text: value, ...(id !== undefined ? { id } : {}), ...(tone !== undefined ? { tone } : {}), ...(lang !== undefined ? { lang } : {}) });
    const button = (id: string, label: string, style: PromptButton['style'], action: PromptButton['action'], extra: Partial<PromptButton> = {}): PromptButton => ({ kind: 'button', id, label, style, action, ...extra });
    const resumeNow = (taskTitle: string) => button('idle-resume-now', t('resumeNow', { task: taskTitle }), 'primary', 'resume-now', { play: true });
    const base = {
      windowTitle: t(meeting && state.phase === 'asking' ? 'stillInMeetingTitle' : 'stillThereTitle'),
      lang: this.locale,
      theme: forcedTheme(this.state.settings.theme),
      escapeHint: t('promptEscapeHint'),
      // Only in its own window: the in-app modal is already in the main window.
      openApp: this.promptInWindow() ? t('promptOpenApp') : null,
      focus: this.promptFocus.id,
      focusSeq: this.promptFocus.seq,
    };
    const options = (tasks: Task[]): PromptTaskOption[] => tasks.map((task) => ({ id: task.id, title: task.title }));
    switch (state.phase) {
      case 'asking': {
        const span = promptSpan(state, this.now());
        const minutes = this.minutesBetween(state.from, state.returnedAt ?? span.to);
        const settings = this.idleSettings();
        const reassign = this.features().idleReassign;
        const canReassign = reassignMode(this.features()) !== null;
        const blocks: PromptBlock[] = [
          ...(quip !== null ? [text(quip.text, 'idle-quip', 'quip', locale)] : []),
          text(t('stillThereText', { minutes: Math.max(minutes, settings.thresholdMinutes), task: state.taskTitle }), 'idle-text'),
          text(t('stillThereSince', { time: this.time(state.from) }), undefined, 'muted'),
          this.reassignOpen && canReassign
            ? this.pickerBlock(state.taskId)
            : this.meetingOpen
            ? {
                kind: 'meeting',
                noteLabel: t('idleNote'),
                noteHelp: t('idleNoteHelp'),
                noteMax: NOTE_MAX,
                countOnLabel: reassign ? t('idleCountOn') : null,
                sameTaskLabel: t('idleSameTask', { task: state.taskTitle }),
                targets: reassign ? options(this.reassignTargets(state.taskId)) : [],
                saveLabel: t('idleMeetingSave'),
                cancelLabel: t('cancel'),
              }
            : {
                kind: 'choices',
                layout: 'list',
                labelledBy: 'idle-title',
                // The three answers (keep · discard · reassign), then the finer ones of 0.4.
                items: [
                  button('idle-here', t('idleHere'), 'primary', 'here'),
                  button('idle-pause', t('idlePause', { time: this.time(state.from) }), 'secondary', 'pause'),
                  ...(canReassign ? [button('idle-reassign', t('idleReassign'), 'secondary', 'reassign-open', { expanded: false })] : []),
                  text(t('idleMoreOptions'), 'idle-more', 'small'),
                  button('idle-meeting', t('idleMeeting'), 'ghost', 'meeting-open', { expanded: false }),
                  button('idle-discard', t('idleDiscardMinutes', { minutes }), 'ghost', 'discard'),
                ],
              },
          state.returnedAt === null
            ? { kind: 'countdown', askedAt: state.askedAt, totalSeconds: settings.answerTimeoutMinutes * 60, template: t('idleCountdown', { time: '{time}' }) }
            : text(t('stillThereTimeout', { minutes: settings.answerTimeoutMinutes }), undefined, 'small'),
        ];
        return { ...base, id: 'idle', moment: 'stillThere', pose: quip !== null ? quip.pose : meeting ? 'teamwork' : null, title: t(meeting ? 'stillInMeetingTitle' : 'stillThereTitle'), blocks };
      }
      case 'away':
        return {
          ...base,
          id: 'idle-away',
          moment: 'away',
          pose: null,
          title: t('awayTitle'),
          blocks: [
            text(t('idleStoppedAt', { time: this.time(state.from), task: state.taskTitle }), 'idle-away-text'),
            { kind: 'choices', layout: 'list', items: [resumeNow(state.taskTitle)] },
            text(t('awayText', { time: this.time(state.from), task: state.taskTitle }), undefined, 'small'),
          ],
        };
      case 'gap': {
        const minutes = this.minutesBetween(state.from, state.to);
        const features = this.features();
        const backdate = features.startBackdate && features.stopBackdate;
        const choices: PromptBlock =
          backdate && this.reassignOpen
            ? this.pickerBlock(state.taskId)
            : backdate
            ? {
                kind: 'choices',
                layout: 'list',
                labelledBy: 'gap-title',
                // Keep · reassign · discard (the timer already stopped at the last input), and "Resume now".
                items: [
                  resumeNow(state.taskTitle),
                  button('gap-keep', t('gapKeep', { task: state.taskTitle }), 'secondary', 'gap-keep'),
                  button('idle-reassign', t('idleReassign'), 'secondary', 'reassign-open', { expanded: false }),
                  button('gap-discard', t('gapDiscard'), 'ghost', 'gap-discard'),
                ],
              }
            : { kind: 'choices', layout: 'list', items: [text(t('gapUnsupported'), 'gap-unsupported', 'muted'), resumeNow(state.taskTitle), button('gap-discard', t('gapOk'), 'secondary', 'gap-discard')] };
        return {
          ...base,
          id: 'gap',
          moment: 'gap',
          pose: null,
          title: t('gapTitle'),
          blocks: [text(t('gapText', { from: this.time(state.from), to: this.time(state.to), minutes, task: state.taskTitle }), 'gap-text'), choices],
        };
      }
      case 'resume':
        return {
          ...base,
          id: 'gap-resume-card',
          moment: 'resume',
          pose: null,
          title: t('resumeTitle', { task: state.taskTitle }),
          blocks: [{ kind: 'choices', layout: 'row', items: [button('gap-resume', t('resume'), 'primary', 'resume', { play: true }), button('gap-dismiss', t('notNow'), 'secondary', 'not-now')] }],
        };
    }
  }

  /** An answer from the prompt (its window or the in-app modal). */
  async answerPrompt(answer: PromptAnswer): Promise<void> {
    const state = this.state.idleCheck;
    const task = (id: string | undefined) =>
      id === undefined || id === '' ? undefined : pickerTasks(this.reassignTargets(state.phase === 'watching' ? '' : state.taskId), this.reassignResults, state.phase === 'watching' ? '' : state.taskId).find((item) => item.id === id);
    switch (answer.action) {
      case 'here':
      case 'discard':
      case 'pause':
        return this.answerIdle({ kind: answer.action });
      case 'meeting-open':
        return this.openMeeting();
      case 'meeting-cancel':
        this.meetingOpen = false;
        this.focusPrompt('idle-meeting');
        this.render();
        return;
      case 'meeting-save': {
        const target = task(answer.taskId);
        return this.answerIdle({ kind: 'meeting', note: answer.note ?? '', reassignTo: target !== undefined ? { id: target.id, title: target.title } : undefined });
      }
      case 'gap-keep':
        return this.answerGap({ kind: 'keep' });
      case 'gap-discard':
        return this.answerGap({ kind: 'discard' });
      case 'gap-reassign': {
        const target = task(answer.taskId);
        if (target !== undefined) await this.answerGap({ kind: 'reassign', task: { id: target.id, title: target.title } });
        return;
      }
      case 'reassign-open':
        this.reassignOpen = true;
        this.focusPrompt('reassign-search');
        this.render();
        return;
      case 'reassign-cancel':
        this.closeReassign();
        this.focusPrompt('idle-reassign');
        this.render();
        return;
      case 'reassign-search':
        return this.searchReassign(answer.query ?? '');
      case 'reassign-save': {
        const target = task(answer.taskId);
        if (target !== undefined) await this.reassignIdle(target);
        return;
      }
      case 'resume-now':
        return this.resumeNow();
      case 'resume':
        return this.resumeAfterGap(true);
      case 'not-now':
        return this.resumeAfterGap(false);
      case 'meeting-join':
      case 'meeting-keep':
      case 'meeting-pause':
      case 'meeting-track':
        return this.meetingReminderAction(answer.action.slice(8) as ReminderActionKind, answer.meeting);
      case 'meeting-snooze':
      case 'meeting-snooze-1':
      case 'meeting-snooze-5':
        return this.meetingReminderAction('snooze', answer.meeting, answer.action === 'meeting-snooze' ? 'default' : answer.action === 'meeting-snooze-1' ? 1 : 5);
      case 'meeting-dismiss':
        return this.closeMeetingReminder();
      case 'escape':
      case 'open-app':
        // Never a dismissal: the prompt stays until it is answered ("Open TimeTrack" is handled by its window).
        return;
    }
  }

  /**
   * The "Reassign" picker: the quick "Meeting" choice (a meeting-type task among the pinned, recent, listed or found
   * tasks), the search, and the tasks to choose from.
   */
  private pickerBlock(exclude: string): PromptPicker {
    const t = this.t;
    const tasks = pickerTasks(this.reassignTargets(exclude), this.reassignResults, exclude);
    const meeting = meetingTask(tasks, (task) => this.timerKind({ taskId: task.id, taskTitle: task.title }));
    return {
      kind: 'picker',
      heading: t('reassignHeading'),
      meeting: meeting !== null ? { kind: 'button', id: 'reassign-meeting', label: t('reassignMeeting', { task: meeting.title }), style: 'secondary', action: 'reassign-save', taskId: meeting.id } : null,
      searchLabel: t('reassignSearch'),
      searchButton: t('reassignSearchButton'),
      query: this.reassignQuery,
      status: this.reassignStatus,
      options: tasks.map((item) => ({ id: item.id, title: item.title })),
      selected: null,
      emptyText: t('reassignEmpty'),
      saveLabel: t('reassignSave'),
      cancelLabel: t('cancel'),
    };
  }

  private closeReassign(): void {
    this.reassignOpen = false;
    this.reassignQuery = '';
    this.reassignResults = null;
    this.reassignStatus = null;
  }

  /** The picker's search, run here (the prompt window has no network). An empty query shows pinned and recent again. */
  async searchReassign(query: string): Promise<void> {
    const t = this.t;
    this.reassignQuery = query.slice(0, 200);
    if (query.trim() === '') {
      this.reassignResults = null;
      this.reassignStatus = null;
      this.render();
      return;
    }
    this.reassignStatus = t('reassignSearching');
    this.render();
    try {
      const results = await this.api().tasks({ search: query.trim() });
      if (this.reassignQuery !== query.slice(0, 200)) return;
      this.reassignResults = results;
      this.reassignStatus = results.length > 0 ? t('reassignResults', { count: results.length }) : t('reassignNoResults', { query: query.trim() });
    } catch {
      this.reassignStatus = t('reassignSearchFailed');
    }
    this.render();
  }

  /**
   * "Reassign" → the idle time becomes an entry on `target`: while asking, split from the running entry (the timer
   * goes on with the same task); after an automatic stop, a backdated entry (the gap answer).
   */
  async reassignIdle(target: Task): Promise<void> {
    const state = this.state.idleCheck;
    if (state.phase === 'gap') return this.answerGap({ kind: 'reassign', task: { id: target.id, title: target.title } });
    if (state.phase !== 'asking') return;
    const now = this.now();
    const span = promptSpan(state, now);
    const decision = reassignWhileAsking(state, target, now, reassignMode(this.features()));
    if (decision === null) return;
    this.setIdleCheck(decision.state);
    await this.runActions(decision.actions);
    this.setNotice(this.t('idleReassigned', { minutes: this.minutesBetween(span.from.toISOString(), span.to), task: target.title }));
  }

  /** Tasks the idle time can go to: pinned, recent and listed tasks, except `exclude`. */
  reassignTargets(exclude: string): Task[] {
    const seen = new Set<string>([exclude]);
    const result: Task[] = [];
    for (const task of [...this.quickTasks(), ...this.tasks]) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      result.push(task);
    }
    return result;
  }

  private openMeeting(): void {
    this.meetingOpen = true;
    this.focusPrompt('idle-note');
    this.render();
  }

  /** Times the server recorded differently from what was asked, in plain words. */
  private renderClamps(): HTMLElement {
    const t = this.t;
    return h(
      'section',
      { class: 'card clamps', id: 'clamps', key: 'clamps', attrs: { 'aria-labelledby': 'clamps-title' } },
      h('h2', { id: 'clamps-title' }, t('clampTitle')),
      h('ul', { class: 'plain' }, ...this.clampNotes.map((note) => h('li', {}, this.clampText(note)))),
      h('button', { class: 'secondary small', id: 'clamps-dismiss', key: 'clamps-dismiss', attrs: { type: 'button' }, on: { click: () => this.dismissClamps() } }, t('gotIt')),
    );
  }

  clampText(note: ClampNote): string {
    const params = { requested: this.time(note.requested), applied: this.time(note.applied), task: note.taskTitle ?? '' };
    const reason = note.reason ?? 'none';
    const key = `clamp_${note.kind}_${reason}` as MessageKey;
    const text = this.t(key, params);
    return text === key ? this.t(note.kind === 'start' ? 'clamp_start_none' : 'clamp_stop_none', params) : text;
  }

  private renderFeature(feature: Feature, label: MessageKey, text: MessageKey, extra?: HTMLElement): HTMLElement {
    const t = this.t;
    const toggle = h('input', { id: `feature-${feature}`, attrs: { type: 'checkbox' } });
    toggle.checked = hasConsent(this.state, feature);
    toggle.addEventListener('change', () => void this.setFeature(feature, toggle.checked));
    const record = this.state.consents[feature];
    const date = record ? this.dateFormat.format(new Date(record.at)) : '';
    return h(
      'section',
      { class: 'feature' },
      h('label', { class: 'switch' }, toggle, t(label)),
      h('p', { class: 'help' }, t(text)),
      extra,
      record !== undefined && h('p', { class: 'muted', id: `consent-${feature}` }, record.granted ? t('consentGiven', { date }) : t('consentWithdrawn', { date })),
    );
  }

  /** "Still there?" settings: set by the organisation on 1.10 servers (the person may only lengthen the wait). */
  private renderIdleSettings(): HTMLElement {
    const t = this.t;
    const features = this.features();
    const current = this.idleSettings().thresholdMinutes;
    const minutes = h('select', { id: 'idle-minutes' });
    for (const value of thresholdChoices(features)) {
      const option = h('option', { attrs: { value: String(value) } }, String(value));
      option.selected = value === current;
      minutes.append(option);
    }
    minutes.addEventListener('change', () => this.setIdleMinutes(Number(minutes.value) === features.thresholdMinutes ? null : Number(minutes.value)));
    const wait = h('label', { class: 'inline' }, t('idleMinutes'), minutes);
    const timeout = h('p', { class: 'muted', id: 'idle-timeout-text' }, t('stillThereTimeout', { minutes: Math.min(features.answerTimeoutMinutes, IDLE_COUNTDOWN_MINUTES) }));
    if (features.idleCheck === null) {
      return this.renderFeature('idleDetection', 'featureIdle', 'featureIdleText', h('div', {}, wait, timeout));
    }
    if (features.idleCheck && features.userCanDisable) {
      const record = this.state.consents.idleDetection;
      const toggle = h('input', { id: 'idle-toggle', attrs: { type: 'checkbox', 'aria-describedby': 'idle-org' } });
      toggle.checked = record?.granted !== false;
      toggle.addEventListener('change', () => void this.setFeature('idleDetection', toggle.checked));
      return h(
        'section',
        { class: 'feature', id: 'idle-settings' },
        h('h2', {}, t('stillThereSetting')),
        h('label', { class: 'switch' }, toggle, t('idleUserSwitch')),
        h('p', { class: 'help', id: 'idle-org' }, t('idlePersonalText', { minutes: features.thresholdMinutes })),
        toggle.checked && wait,
        toggle.checked && timeout,
        record !== undefined && h('p', { class: 'muted', id: 'consent-idleDetection' }, t(record.granted ? 'consentGiven' : 'consentWithdrawn', { date: this.dateFormat.format(new Date(record.at)) })),
        h('p', { class: 'muted' }, t('idleLocalOnly')),
      );
    }
    return h(
      'section',
      { class: 'feature', id: 'idle-settings' },
      h('h2', {}, t('stillThereSetting')),
      features.idleCheck
        ? h('p', { class: 'help', id: 'idle-org' }, t('idleOrgOn', { minutes: features.thresholdMinutes }))
        : h('p', { class: 'help', id: 'idle-org' }, t('idleOrgOff')),
      features.idleCheck && wait,
      features.idleCheck && timeout,
      h('p', { class: 'muted' }, t('idleLocalOnly')),
    );
  }

  /** One line in Settings about TLS pinning of the connected server; nothing for loopback or an unknown state. */
  private renderConnectionSecurity(): HTMLElement | false {
    const security = this.connectionSecurity;
    if (security === null || security.status === 'local') return false;
    const key: MessageKey = security.status === 'pinned' ? 'connPinned' : security.status === 'expired' ? 'connPinExpired' : 'connNotPinned';
    const params = { host: hostOf(this.state.session?.server), version: security.pinSetVersion };
    return h('p', { class: 'muted', id: 'connection-security', attrs: { 'data-status': security.status } }, this.t(key, params));
  }

  private renderSettings(): HTMLElement {
    const t = this.t;
    const shortcut = h('input', { id: 'shortcut', attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'shortcut-help shortcut-message' } });
    shortcut.value = this.state.settings.shortcut;
    return h(
      'main',
      { id: 'settings' },
      this.renderAppearance(),
      h(
        'form',
        {
          class: 'feature',
          id: 'shortcut-form',
          on: {
            submit: (event) => {
              event.preventDefault();
              void this.applyShortcut(shortcut.value);
            },
          },
        },
        h('label', { attrs: { for: 'shortcut' } }, t('shortcutLabel')),
        shortcut,
        h('p', { class: 'help', id: 'shortcut-help' }, t('shortcutHelp')),
        this.shortcutMessage !== null && h('p', { class: this.shortcutMessage.ok ? 'muted' : 'field-error', id: 'shortcut-message' }, this.shortcutMessage.text),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'secondary small', id: 'shortcut-save', key: 'shortcut-save', attrs: { type: 'submit' } }, t('shortcutSave')),
          h('button', { class: 'link', id: 'shortcut-default', attrs: { type: 'button' }, on: { click: () => void this.applyShortcut(DEFAULT_SETTINGS.shortcut) } }, t('shortcutDefault')),
        ),
      ),
      this.renderBrowserSetting(),
      this.renderIdleSettings(),
      this.renderHelpers(),
      this.renderSchedule(),
      this.renderFriendlySettings(),
      this.renderMeetingSettings(),
      this.renderReminderSettings(),
      this.renderFeature('notifications', 'featureNotifications', 'featureNotificationsText'),
      // Store (MSIX) builds cannot register the login item the autostart plugin writes: no switch there.
      this.channel === 'direct' && this.renderFeature('autostart', 'featureAutostart', 'featureAutostartText'),
      h('p', { class: 'muted', id: 'background-note' }, this.t('backgroundNote')),
      this.renderConnectionSecurity(),
      h('button', { class: 'link', id: 'open-privacy', on: { click: () => this.show('privacy') } }, t('whatWeCollect')),
      h('section', { class: 'about', id: 'about', attrs: { 'aria-labelledby': 'about-title' } },
        moment('about', 'mascot tiny', t),
        h(
          'div',
          {},
          h('h2', { id: 'about-title' }, t('about')),
          h('p', { class: 'muted' }, t('aboutText', { version: this.version })),
          ...(this.channel === 'store'
            ? [
                h('p', { class: 'muted', id: 'update-status' }, t('updateStoreManaged')),
                h('p', { class: 'muted', id: 'store-about' }, t('storeAbout')),
                h('button', { class: 'secondary small', id: 'open-store', attrs: { type: 'button' }, on: { click: () => this.openStore() } }, t('openStore')),
              ]
            : [
                this.updateStatus !== null && h('p', { class: 'muted', id: 'update-status' }, this.updateStatus),
                h('button', { class: 'secondary small', id: 'check-updates', key: 'check-updates', attrs: { type: 'button', disabled: this.busy }, on: { click: () => void this.checkUpdates(true) } }, t('checkUpdates')),
              ]),
        ),
      ),
      h('button', { class: 'danger', id: 'logout', on: { click: () => void this.logout() } }, t('logout')),
    );
  }

  /** Settings → "Continue last" shortcut, "Working without a timer?" and "Pause on lock or sleep". */
  private renderHelpers(): HTMLElement {
    const t = this.t;
    const settings = this.state.settings;
    const shortcut = h('input', { id: 'resume-shortcut', attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'resume-shortcut-help resume-shortcut-message' } });
    shortcut.value = settings.resumeShortcut;
    const nudge = h('input', { id: 'nudge-toggle', attrs: { type: 'checkbox', 'aria-describedby': 'nudge-help' } });
    nudge.checked = settings.nudgeWithoutTimer;
    nudge.addEventListener('change', () => this.setHelper({ nudgeWithoutTimer: nudge.checked }));
    const minutes = h('select', { id: 'nudge-minutes' });
    for (const value of NUDGE_MINUTES_CHOICES) {
      const option = h('option', { attrs: { value: String(value) } }, String(value));
      option.selected = value === settings.nudgeMinutes;
      minutes.append(option);
    }
    minutes.addEventListener('change', () => this.setHelper({ nudgeMinutes: Number(minutes.value) }));
    const lock = h('input', { id: 'lock-toggle', attrs: { type: 'checkbox', 'aria-describedby': 'lock-help' } });
    lock.checked = settings.pauseOnLock;
    lock.addEventListener('change', () => this.setHelper({ pauseOnLock: lock.checked }));
    return h(
      'section',
      { class: 'feature', id: 'helpers', attrs: { 'aria-labelledby': 'helpers-title' } },
      h('h2', { id: 'helpers-title' }, t('helpersTitle')),
      h(
        'form',
        {
          id: 'resume-shortcut-form',
          on: {
            submit: (event) => {
              event.preventDefault();
              void this.applyShortcut(shortcut.value, true, 'resume');
            },
          },
        },
        h('label', { attrs: { for: 'resume-shortcut' } }, t('resumeShortcutLabel')),
        shortcut,
        h('p', { class: 'help', id: 'resume-shortcut-help' }, t('resumeShortcutHelp')),
        this.resumeShortcutMessage !== null && h('p', { class: this.resumeShortcutMessage.ok ? 'muted' : 'field-error', id: 'resume-shortcut-message' }, this.resumeShortcutMessage.text),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { class: 'secondary small', id: 'resume-shortcut-save', key: 'resume-shortcut-save', attrs: { type: 'submit' } }, t('shortcutSave')),
          h('button', { class: 'link', id: 'resume-shortcut-default', attrs: { type: 'button' }, on: { click: () => void this.applyShortcut(DEFAULT_SETTINGS.resumeShortcut, true, 'resume') } }, t('shortcutDefault')),
        ),
      ),
      h('label', { class: 'switch' }, nudge, t('nudgeSwitch')),
      settings.nudgeWithoutTimer && h('label', { class: 'inline' }, t('nudgeMinutes'), minutes),
      h('p', { class: 'help', id: 'nudge-help' }, t('nudgeHelp')),
      h('label', { class: 'switch' }, lock, t('lockSwitch')),
      h('p', { class: 'help', id: 'lock-help' }, t('lockHelp')),
      settings.pauseOnLock && !this.idleCheckEnabled() && h('p', { class: 'muted', id: 'lock-needs-idle' }, t('lockNeedsIdle')),
    );
  }

  /** Settings → My schedule: the reminders switch, the week (Beacon's, adjustable here) and the days off. */
  private renderSchedule(): HTMLElement {
    const t = this.t;
    const settings = this.state.settings;
    const view = this.scheduleView();
    const toggle = h('input', { id: 'schedule-reminders', attrs: { type: 'checkbox', 'aria-describedby': 'schedule-reminders-help' } });
    toggle.checked = settings.scheduleReminders;
    toggle.addEventListener('change', () => this.setScheduleSetting({ scheduleReminders: toggle.checked }));
    const lead = h('select', { id: 'schedule-lead' });
    for (const minutes of LEAD_CHOICES) {
      const option = h('option', { attrs: { value: String(minutes) } }, minutes === 0 ? t('scheduleLeadNone') : t('scheduleLeadMinutes', { minutes }));
      option.selected = minutes === settings.scheduleLeadMinutes;
      lead.append(option);
    }
    lead.addEventListener('change', () => this.setScheduleSetting({ scheduleLeadMinutes: Number(lead.value) }));
    const hasLocal = Object.keys(this.state.schedule.overrides).length > 0;
    return h(
      'section',
      { class: 'feature', id: 'schedule-settings', attrs: { 'aria-labelledby': 'schedule-title' } },
      h('h2', { id: 'schedule-title' }, t('scheduleTitle')),
      h('label', { class: 'switch' }, toggle, t('scheduleReminders')),
      h('p', { class: 'help', id: 'schedule-reminders-help' }, t('scheduleRemindersHelp')),
      settings.scheduleReminders && h('label', { class: 'inline' }, t('scheduleLead'), lead),
      h('p', { class: 'help', id: 'schedule-source' }, t(view.beacon !== null ? 'scheduleFromBeacon' : 'scheduleNoBeacon')),
      h('p', { class: 'schedule-legend', id: 'schedule-legend' }, h('span', { class: 'source-badge', attrs: { 'data-source': 'beacon' } }, 'Beacon'), ' ', t('scheduleLegendBeacon'), ' · ', h('span', { class: 'source-badge', attrs: { 'data-source': 'local' } }, t('sourceLocal')), ' ', t('scheduleLegendLocal')),
      h('div', { class: 'schedule-days', id: 'schedule-days' }, ...WEEKDAYS.map((day) => this.renderScheduleDay(day, view))),
      h(
        'p',
        { class: 'row-actions' },
        h('button', { class: 'secondary small', id: 'schedule-reset', key: 'schedule-reset', attrs: { type: 'button', disabled: !hasLocal || view.beacon === null }, on: { click: () => this.resetSchedule() } }, t('scheduleReset')),
      ),
      this.renderDaysOff(view),
      h('p', { class: 'muted' }, t('scheduleLocal')),
    );
  }

  private dayName(day: Weekday, style: 'long' | 'short' = 'long'): string {
    // 2024-01-01 was a Monday.
    const name = new Intl.DateTimeFormat(this.locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, day)));
    return name.charAt(0).toLocaleUpperCase(this.locale) + name.slice(1);
  }

  private renderScheduleDay(day: Weekday, view: ReturnType<DesktopApp['scheduleView']>): HTMLElement {
    const t = this.t;
    const plan = view.merged.week[day];
    const source = view.merged.source[day];
    const local = Object.values(source).includes('local');
    const summary = plan.off
      ? t('scheduleDayOff')
      : plan.start === null && plan.end === null
        ? t('scheduleNoHours')
        : [`${plan.start ?? '–'}–${plan.end ?? '–'}`, plan.lunchStart !== null && plan.lunchEnd !== null ? t('scheduleLunchSummary', { from: plan.lunchStart, to: plan.lunchEnd }) : null].filter(Boolean).join(' · ');
    const badge = (name: DayField) => source[name] !== 'none' && h('span', { class: 'source-badge', id: `day-${day}-${name}-source`, attrs: { 'data-source': source[name] } }, source[name] === 'local' ? t('sourceLocal') : 'Beacon');
    const time = (name: 'start' | 'end' | 'lunchStart' | 'lunchEnd', label: MessageKey) => {
      const input = h('input', { id: `day-${day}-${name}`, key: `day-${day}-${name}`, attrs: { type: 'time', step: '300', 'data-source': source[name] } });
      input.value = plan[name] ?? '';
      input.addEventListener('change', () => this.setScheduleField(day, name, input.value === '' ? null : input.value));
      return h('label', { class: 'schedule-field', attrs: { 'data-source': source[name] } }, h('span', { class: 'schedule-field-label' }, t(label), badge(name)), input);
    };
    const off = h('input', { id: `day-${day}-off`, key: `day-${day}-off`, attrs: { type: 'checkbox' } });
    off.checked = plan.off;
    off.addEventListener('change', () => this.setScheduleField(day, 'off', off.checked));
    const details = h(
      'details',
      { class: 'schedule-day', id: `day-${day}`, attrs: { open: this.openDays.has(day), 'data-local': local ? 'true' : undefined } },
      h(
        'summary',
        { key: `day-${day}-summary` },
        h('span', { class: 'schedule-day-name' }, this.dayName(day)),
        h('span', { class: 'schedule-day-summary', id: `day-${day}-summary` }, summary),
        local && h('span', { class: 'source-badge', attrs: { 'data-source': 'local' } }, t('sourceLocal')),
      ),
      h('label', { class: 'switch' }, off, t('scheduleDayOffToggle'), badge('off')),
      !plan.off &&
        h(
          'div',
          { class: 'schedule-grid' },
          time('start', 'scheduleStart'),
          time('end', 'scheduleEnd'),
          time('lunchStart', 'scheduleLunchStart'),
          time('lunchEnd', 'scheduleLunchEnd'),
        ),
    );
    details.addEventListener('toggle', () => void (details.open ? this.openDays.add(day) : this.openDays.delete(day)));
    return details;
  }

  /** Holidays and vacations: Beacon's (read only) and the ones marked here (removable), upcoming only. */
  private renderDaysOff(view: ReturnType<DesktopApp['scheduleView']>): HTMLElement {
    const t = this.t;
    const today = zonedParts(this.now(), view.timeZone).date;
    const upcoming = view.daysOff.filter((item) => item.date >= today).slice(0, 12);
    const format = new Intl.DateTimeFormat(this.locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const label = (item: DayOff) => item.label ?? t(item.source === 'local' ? 'dayOffLocal' : item.kind === 'vacation' ? 'dayOffVacation' : 'dayOffHoliday');
    const date = h('input', { id: 'day-off-date', key: 'day-off-date', attrs: { type: 'date', min: today, 'aria-label': t('dayOffDate') } });
    date.value = this.dayOffDraft;
    date.addEventListener('input', () => void (this.dayOffDraft = date.value));
    return h(
      'div',
      { class: 'days-off', id: 'days-off' },
      h('h3', {}, t('daysOffTitle')),
      h('p', { class: 'help' }, t('daysOffHelp')),
      upcoming.length === 0
        ? h('p', { class: 'muted', id: 'days-off-empty' }, t('daysOffEmpty'))
        : h(
            'ul',
            { class: 'plain days-off-list', id: 'days-off-list' },
            ...upcoming.map((item) =>
              h(
                'li',
                { attrs: { 'data-date': item.date, 'data-source': item.source } },
                h('span', { class: 'day-off-date' }, format.format(new Date(`${item.date}T00:00:00Z`))),
                h('span', { class: 'day-off-label' }, label(item)),
                h('span', { class: 'source-badge', attrs: { 'data-source': item.source } }, item.source === 'local' ? t('sourceLocal') : 'Beacon'),
                item.source === 'local' &&
                  h('button', { class: 'link', id: `day-off-remove-${item.date}`, key: `day-off-remove-${item.date}`, attrs: { type: 'button', 'aria-label': t('dayOffRemove', { date: format.format(new Date(`${item.date}T00:00:00Z`)) }) }, on: { click: () => this.setLocalDayOff(item.date, false) } }, t('remove')),
              ),
            ),
          ),
      h(
        'form',
        { class: 'row-actions', id: 'day-off-form', on: { submit: (event) => { event.preventDefault(); this.setLocalDayOff(date.value, true); } } },
        date,
        h('button', { class: 'secondary small', id: 'day-off-add', key: 'day-off-add', attrs: { type: 'submit' } }, t('dayOffAdd')),
      ),
    );
  }

  /** Settings → Appearance: System / Light / Dark (radio group, stored locally, applied at once). */
  /** Settings → Friendly messages: two switches, both on by default; local only, nothing to consent to. */
  private renderFriendlySettings(): HTMLElement {
    const t = this.t;
    const toggle = (id: string, setting: 'funMessages' | 'wellbeingReminders', label: MessageKey, help: MessageKey) => {
      const input = h('input', { id, attrs: { type: 'checkbox', 'aria-describedby': `${id}-help` } });
      input.checked = this.state.settings[setting];
      input.addEventListener('change', () => this.setFriendly(setting, input.checked));
      return [h('label', { class: 'switch' }, input, t(label)), h('p', { class: 'help', id: `${id}-help` }, t(help, { minutes: MIN_GAP_MINUTES }))];
    };
    return h(
      'section',
      { class: 'feature', id: 'friendly-settings' },
      h('h2', {}, t('friendlyTitle')),
      ...toggle('fun-messages', 'funMessages', 'funMessages', 'funMessagesHelp'),
      ...toggle('wellbeing-reminders', 'wellbeingReminders', 'wellbeingReminders', 'wellbeingRemindersHelp'),
      this.renderDesktopNotifications(),
      this.renderPause(),
      h('p', { class: 'muted' }, t('friendlyLocal')),
    );
  }

  /** The meeting question as a toast (`ui/meetings.ts`). */
  private renderMeetingQuestion(note: MeetingNote): HTMLElement {
    return renderMeetingToast({
      t: this.t,
      note,
      picker: this.meetingPicker,
      query: this.meetingQuery,
      tasks: this.meetingPicker !== null ? this.meetingTasks() : [],
      isMeeting: (task) => this.isMeetingTask(task),
      onAction: (action) => void this.meetingAction(action),
      onPick: (task) => void this.startMeeting(task, this.meetingPicker === 'generic'),
      onQuery: (query) => {
        this.meetingQuery = query;
        this.render();
      },
      onCancelPicker: () => {
        this.meetingPicker = null;
        this.render();
      },
      onDismiss: () => this.dismissMeeting(),
    });
  }

  /** Settings → Meetings: opt-in switch (dated consent), the wait, the generic meeting, muted apps (`ui/meetings.ts`). */
  private renderMeetingSettings(): HTMLElement {
    const settings = this.state.settings;
    const record = this.state.consents.meetingDetection;
    const recents = this.entries !== null ? recentTasks(this.entries, this.tasks, 9) : [];
    return renderMeetingSettings({
      t: this.t,
      enabled: hasConsent(this.state, 'meetingDetection'),
      consent: record !== undefined ? { granted: record.granted, date: this.dateFormat.format(new Date(record.at)) } : null,
      minMinutes: settings.meetingMinMinutes,
      generic: settings.meetingGeneric,
      candidates: meetingCandidates([this.state.pinned, recents, this.tasks], (task) => this.isMeetingTask(task), null, 20),
      muted: settings.meetingMuted,
      signal: this.micSignal,
      locale: this.messageLocale(),
      onToggle: (on) => void this.setFeature('meetingDetection', on),
      onMinMinutes: (minutes) => this.setMeetingSetting({ meetingMinMinutes: minutes }),
      onGeneric: (task) => this.setMeetingSetting({ meetingGeneric: task }),
      onUnmute: (app) => this.setMeetingSetting({ meetingMuted: settings.meetingMuted.filter((item) => item !== app) }),
    });
  }

  /** "Show them as desktop notifications" and, when the OS does not show them, why the messages stay in the app. */
  private renderDesktopNotifications(): HTMLElement {
    const t = this.t;
    const settings = this.state.settings;
    const input = h('input', { id: 'desktop-notifications', attrs: { type: 'checkbox', 'aria-describedby': 'desktop-notifications-help' } });
    input.checked = settings.desktopNotifications;
    input.addEventListener('change', () => this.setDesktopNotifications(input.checked));
    const status: MessageKey | null = !settings.desktopNotifications
      ? null
      : settings.nativeStatus === 'denied'
        ? 'nativeStatusDenied'
        : settings.nativeStatus === 'failed'
          ? 'nativeStatusFailed'
          : settings.nativeStatus === 'unsupported'
            ? 'nativeStatusUnsupported'
            : null;
    return h(
      'div',
      { class: 'native-settings' },
      h('label', { class: 'switch' }, input, t('desktopNotifications')),
      h('p', { class: 'help', id: 'desktop-notifications-help' }, t('desktopNotificationsHelp')),
      status !== null &&
        h(
          'p',
          { class: 'help native-status', id: 'native-status' },
          t(status),
          status !== 'nativeStatusUnsupported' && ' ',
          status !== 'nativeStatusUnsupported' && h('button', { class: 'link', id: 'native-retry', key: 'native-retry', attrs: { type: 'button' }, on: { click: () => this.setDesktopNotifications(true) } }, t('nativeRetry')),
        ),
    );
  }

  /** Pause the friendly messages for an hour (also in the tray menu), or resume them. */
  private renderPause(): HTMLElement | null {
    const t = this.t;
    if (!this.state.settings.funMessages && !this.state.settings.wellbeingReminders) return null;
    const paused = pausedAt(this.state.messages, this.now());
    return h(
      'p',
      { class: 'row-actions', id: 'friendly-pause' },
      paused && h('span', { class: 'muted', id: 'friendly-paused-text' }, t('friendlyPausedUntil', { time: this.time(this.state.messages.pausedUntil as string) })),
      h(
        'button',
        { class: 'secondary small', id: paused ? 'friendly-resume' : 'friendly-pause-button', key: 'friendly-pause-button', attrs: { type: 'button' }, on: { click: () => void this.pauseFriendly(!paused) } },
        t(paused ? 'friendlyResume' : 'friendlyPause'),
      ),
    );
  }

  /** Settings → Open Beacon in: system default, a detected browser, or Custom… (this computer only). */
  private renderBrowserSetting(): HTMLElement {
    const t = this.t;
    const choice = this.browserChoice;
    const select = h('select', { id: 'browser', attrs: { 'aria-describedby': 'browser-help' } });
    const option = (value: string, label: string) => select.append(h('option', { attrs: { value } }, label));
    option('system', t('browserSystem'));
    for (const browser of this.browsers ?? []) option(`detected:${browser.id}`, browser.name);
    const missing = choice.kind === 'detected' && this.browsers !== null && !this.browsers.some((browser) => browser.id === choice.id);
    if (choice.kind === 'detected' && (this.browsers === null || missing)) option(`detected:${choice.id}`, missing ? t('browserMissingOption', { name: choice.name }) : choice.name);
    if (choice.kind === 'custom') option('custom-current', t('browserCustomOption', { name: choice.name }));
    option('custom', t('browserCustom'));
    select.value = choice.kind === 'system' ? 'system' : choice.kind === 'detected' ? `detected:${choice.id}` : 'custom-current';
    select.addEventListener('change', () => void this.chooseBrowser(select.value));
    return h(
      'section',
      { class: 'feature', id: 'browser-settings' },
      h('label', { attrs: { for: 'browser' } }, t('browserLabel')),
      select,
      h('p', { class: 'help', id: 'browser-help' }, t('browserHelp')),
      choice.kind === 'custom' && h('p', { class: 'muted path', id: 'browser-path' }, choice.path),
      missing && h('p', { class: 'muted', id: 'browser-missing' }, t('browserMissing', { name: choice.name })),
      this.browserMessage !== null && h('p', { class: 'field-error', id: 'browser-message', attrs: { role: 'alert' } }, this.browserMessage),
    );
  }

  async loadBrowsers(): Promise<void> {
    try {
      this.browsers = await this.platform.listBrowsers();
    } catch {
      this.browsers = [];
    }
    await this.loadBrowserChoice();
    if (this.view === 'settings') this.render();
  }

  /** The "Open Beacon in" choice the host keeps (the system default when the host cannot say). */
  async loadBrowserChoice(): Promise<void> {
    try {
      this.browserChoice = await this.platform.getBrowser();
    } catch {
      this.browserChoice = SYSTEM_BROWSER;
    }
  }

  /** `system`, `detected:<id>`, `custom` (the file picker) or `custom-current` (unchanged). */
  async chooseBrowser(value: string): Promise<void> {
    this.browserMessage = null;
    // The host validates and keeps the choice; the UI only shows what it answers.
    try {
      if (value === 'system') this.browserChoice = await this.platform.setBrowser({ kind: 'system' });
      else if (value.startsWith('detected:')) {
        const found = this.browsers?.find((item) => item.id === value.slice(9));
        if (found !== undefined) this.browserChoice = await this.platform.setBrowser({ kind: 'detected', id: found.id });
      }
    } catch {
      await this.loadBrowserChoice();
    }
    if (value === 'custom') {
      try {
        const picked = await this.platform.pickBrowser();
        if (picked !== null) this.browserChoice = picked;
      } catch {
        this.browserMessage = this.t('browserCustomInvalid');
      }
    }
    this.render();
  }

  private renderAppearance(): HTMLElement {
    const t = this.t;
    const current = this.state.settings.theme;
    return h(
      'fieldset',
      { class: 'feature theme-choice', id: 'theme' },
      h('legend', {}, t('themeLabel')),
      h(
        'div',
        { class: 'segmented' },
        ...THEMES.map((theme) => {
          const input = h('input', { id: `theme-${theme}`, key: `theme-${theme}`, attrs: { type: 'radio', name: 'theme', value: theme } });
          input.checked = theme === current;
          input.addEventListener('change', () => void (input.checked && this.setTheme(theme)));
          return h('label', { class: 'segment', attrs: { for: `theme-${theme}` } }, input, h('span', {}, t(THEME_LABELS[theme])));
        }),
      ),
      h('p', { class: 'help' }, t('themeHelp')),
    );
  }

  /** What is sent, what stays on this computer, and "Clear local data". */
  private renderPrivacy(): HTMLElement {
    const t = this.t;
    const section = (id: string, title: MessageKey, items: MessageKey[]) =>
      h('section', { class: 'privacy-section', id, attrs: { 'aria-labelledby': `${id}-title` } }, h('h2', { id: `${id}-title` }, t(title)), h('ul', { class: 'plain' }, ...items.map((key) => h('li', {}, t(key)))));
    const pending = this.queue.size;
    return h(
      'main',
      { id: 'privacy' },
      h('p', {}, t('privacyIntro')),
      section('privacy-sent', 'privacySentTitle', ['privacySentSignIn', 'privacySentTimer', 'privacySentIdle', 'privacySentUpdates']),
      section('privacy-local', 'privacyLocalTitle', ['privacyLocalToken', 'privacyLocalState', 'privacyLocalWindow', 'privacyLocalIdle', 'privacyLocalMeetings', 'privacyLocalReminders', 'privacyLocalTotals', 'privacyLocalBrowser']),
      section('privacy-never', 'privacyNeverTitle', ['privacyNever']),
      h('p', {}, t('privacyRights')),
      h(
        'section',
        { class: 'feature', id: 'clear-local-section', attrs: { 'aria-labelledby': 'clear-local-title' } },
        h('h2', { id: 'clear-local-title' }, t('clearLocalTitle')),
        h('p', { class: 'help' }, t('clearLocalText')),
        this.confirmClear
          ? h(
              'div',
              { class: 'confirm', id: 'clear-local-confirm', attrs: { role: 'group', 'aria-labelledby': 'clear-local-question' } },
              h('p', { id: 'clear-local-question' }, pending > 0 ? t('clearLocalPending', { count: pending }) : t('clearLocalSure')),
              h(
                'div',
                { class: 'row-actions' },
                h('button', { class: 'danger', id: 'clear-local-yes', key: 'clear-local-yes', attrs: { type: 'button' }, on: { click: () => void this.clearLocalData() } }, t('clearLocalYes')),
                h('button', { class: 'secondary', id: 'clear-local-no', key: 'clear-local-no', attrs: { type: 'button' }, on: { click: () => { this.confirmClear = false; this.render(); this.body.querySelector<HTMLButtonElement>('#clear-local')?.focus(); } } }, t('cancel')),
              ),
            )
          : h('button', { class: 'secondary', id: 'clear-local', key: 'clear-local', attrs: { type: 'button' }, on: { click: () => { this.confirmClear = true; this.render(); this.body.querySelector<HTMLButtonElement>('#clear-local-yes')?.focus(); } } }, t('clearLocal')),
      ),
    );
  }

  private renderUpdateRequired(): HTMLElement {
    const t = this.t;
    const min = this.update?.min ?? '';
    const timer = this.state.activeTimer;
    const working = this.updateStage === 'downloading' || this.updateStage === 'installing';
    const percent = this.updatePercent();
    if (this.channel === 'store') {
      return h(
        'main',
        { id: 'update-required', attrs: { role: 'alertdialog', 'aria-labelledby': 'update-required-title', 'aria-describedby': 'update-required-text' } },
        moment('updateRequired', 'mascot small', t),
        h('h2', { id: 'update-required-title' }, t('updateRequiredTitle')),
        h('p', { id: 'update-required-text' }, t('updateRequiredStore', { current: this.version, min })),
        h('button', { class: 'primary', id: 'open-store-required', on: { click: () => this.openStore() } }, t('openStore')),
        h('button', { class: 'link', id: 'remind-later', on: { click: () => this.remindLater() } }, t('updateLater')),
        h('button', { class: 'danger', id: 'logout-required', on: { click: () => void this.logout() } }, t('logout')),
      );
    }
    return h(
      'main',
      { id: 'update-required', attrs: { role: 'alertdialog', 'aria-labelledby': 'update-required-title', 'aria-describedby': 'update-required-text' } },
      moment('updateRequired', 'mascot small', t),
      h('h2', { id: 'update-required-title' }, t('updateRequiredTitle')),
      h('p', { id: 'update-required-text' }, t('updateRequiredText', { current: this.version, min })),
      timer !== null && !working && h('p', { id: 'update-required-running' }, t('updateRequiredRunning', { task: timer.taskTitle })),
      working &&
        h(
          'div',
          { class: 'update-required-progress' },
          h(
            'p',
            { id: 'update-progress-label' },
            this.updateStage === 'installing'
              ? t('updateInstalling', { version: this.update?.version ?? '' })
              : percent !== null
                ? t('updateDownloading', { version: this.update?.version ?? '', percent })
                : t('updateDownloadingShort', { version: this.update?.version ?? '' }),
          ),
          (() => {
            const bar = h('progress', { id: 'update-progress', attrs: { max: '100', 'aria-labelledby': 'update-progress-label' } });
            if (this.updateStage === 'installing') bar.value = 100;
            else if (percent !== null) bar.value = percent;
            return bar;
          })(),
        ),
      h('button', { class: 'primary', id: 'install-required', attrs: { disabled: this.busy }, on: { click: () => void this.installUpdate() } }, t('installUpdate')),
      timer !== null &&
        h('button', { class: 'secondary', id: 'stop-then-update', attrs: { disabled: this.busy }, on: { click: () => void this.stopThenUpdate() } }, t('updateStopThenUpdate')),
      h('button', { class: 'secondary', id: 'download-required', on: { click: () => this.openApps() } }, t('downloadFromBeacon')),
      h('button', { class: 'link', id: 'remind-later', on: { click: () => this.remindLater() } }, t('updateLater')),
      h('button', { class: 'danger', id: 'logout-required', on: { click: () => void this.logout() } }, t('logout')),
    );
  }

  /** Forced update with a running timer: stop it (normal stop, queued when offline), then update. */
  async stopThenUpdate(): Promise<void> {
    this.updateStage = 'after-stop';
    await this.stop();
    // `setTimer(null)` starts the install; if the stop did not happen, nothing changes.
    if (this.state.activeTimer !== null) this.updateStage = 'offer';
    this.render();
  }
}

/** Host of the connected server (exported for the tray / tests). */
export { hostOf };
