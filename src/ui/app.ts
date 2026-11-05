import { ApiError, TimeTrackApi, normalizeServerUrl } from '../api/client';
import type { DeviceCode, Entry, Me, Task, Timer } from '../api/types';
import { dashboardUrl, myTimeUrl, sameOriginHttps, taskUrl } from '../lib/beacon';
import { DeviceFlowError, runDeviceFlow } from '../lib/deviceFlow';
import { type ErrorStage, type ErrorView, describeError } from '../lib/errors';
import { type Card, type Switches, afterStop, beaconLocale, beaconTimeZone, CARD_TTL_MINUTES, CATALOG, DAILY_TOAST_MS, IDLE_COUNTDOWN_MINUTES, lineText, MEETING_COUNTDOWN_MINUTES, messageLocale, MIN_GAP_MINUTES, nextCard, noticeTitle, pausedAt, pauseMessages, pickDailyDone, pickIdleLine, resumeMessages, taskKind, visibleCard, zonedParts } from '../lib/friendly';
import type { NoticeKind, PoseId, TaskKind } from '../lib/messages/types';
import { createTranslator, detectLocale, type Locale, type MessageKey, type Translate } from '../lib/i18n';
import { type GapChoice, type IdleCheckState, type IdleChoice, WATCHING, decide, decideGap, observeIdle, promptSpan } from '../lib/idleCheck';
import { preflight } from '../lib/preflight';
import { OfflineQueue } from '../lib/queue';
import { type ClampNote, type QueuedAction, type SyncResult, applyLocally } from '../lib/replay';
import { type ServerFeatures, effectiveThreshold, serverFeatures, thresholdChoices } from '../lib/serverFeatures';
import { hostOf, prepareServerUrl, type ServerUrlProblem } from '../lib/serverUrl';
import { type Feature, type LocalState, DEFAULT_SETTINGS, LOCAL_KEYS, MAX_PINNED, emptyState, hasConsent, loadLocal, recordConsent, saveLocal } from '../lib/settings';
import { computeTotals, formatHoursMinutes, recentTasks, startOfWeek, taskContext, todayByTask, type Totals } from '../lib/summary';
import { elapsedSeconds, formatElapsed } from '../lib/time';
import { applyTheme, forcedTheme, THEMES, type ThemePreference } from '../lib/theme';
import { appsPage, safeVerificationUri } from '../lib/urls';
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
} from '../lib/schedule';
import { withinWorkingHours } from '../lib/workingHours';
import type { FriendlyNotification, Platform, TrayMenu, UpdateCheck, UpdateProgress, WakePlan } from '../platform';
import { h, patch, type Child } from './dom';
import { icon, type IconName } from './icons';
import { art, ERROR_POSES, moment, poseArt, variant, type Moment } from './mascot';
import { PromptMount, type PromptAnswer, type PromptBlock, type PromptButton, type PromptChoices, type PromptTaskOption, type PromptText, type PromptView } from './prompt';

export type View = 'loading' | 'login' | 'device' | 'main' | 'settings' | 'privacy' | 'update-required';

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
  /** "Daily done" toast after a daily-type timer stops. */
  dailyToast: { text: string; pose: PoseId; locale: string } | null = null;
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Toasts last rendered (re-rendered only when they change, so the polite live region speaks once). */
  private toastKey = '';
  private readonly toastRegion: HTMLElement;
  private lastTrayMenu = '';
  private main: MainRegions | null = null;
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
    document.documentElement.lang = this.locale;
    applyTheme(this.state.settings.theme);
    this.header = h('header', { class: 'bar' });
    this.status = h('div', { class: 'messages', id: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.alert = h('div', { class: 'messages', id: 'alerts', attrs: { role: 'alert' } });
    this.body = h('div', { class: 'view', id: 'view' });
    this.liveRegion = h('p', { class: 'sr-only', id: 'live', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    this.toastRegion = h('div', { class: 'toasts', id: 'toasts', attrs: { 'aria-live': 'polite', 'aria-relevant': 'additions' } });
    this.root.replaceChildren(this.header, this.status, this.alert, this.liveRegion, this.body, this.toastRegion);
    document.addEventListener('keydown', (event) => this.onKey(event));
  }

  async init(): Promise<void> {
    this.version = await this.platform.appVersion();
    await this.syncWindowTheme();
    this.platform.onTray((action) => void this.trayAction(action));
    // The regular check, woken by the host (on time while the window is hidden).
    this.platform.onWake(() => void this.tick());
    // A button of a working-hours reminder notification (Start / Stop / Resume).
    this.platform.onNotificationAction((id) => void this.reminderAction(actionOfId(id)));
    this.platform.onShortcut(() => this.focusSearch());
    await this.applyShortcut(this.state.settings.shortcut, false);
    this.token = await this.platform.secretGet();
    if (this.state.session === null || this.token === null) {
      this.show('login');
      await this.updateTray();
      return;
    }
    this.show('main');
    await this.refresh();
    await this.checkUpdates();
  }

  destroy(): void {
    this.abort?.abort();
    for (const timer of [this.ticker, this.deviceTicker]) if (timer !== null) clearInterval(timer);
    for (const timer of [this.searchTimer, this.noticeTimer, this.dailyTimer]) if (timer !== null) clearTimeout(timer);
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
          await preflight(this.platform.fetch, server);
          stage = 'deviceCode';
          const login = await runDeviceFlow(api, {
            clientName: `TimeTrack desktop (${await this.platform.hostName()})`,
            sleep: this.deps.sleep,
            signal: this.abort?.signal,
            onCode: async (code) => {
              stage = 'action';
              const uri = code.verificationUriComplete ?? code.verificationUri;
              this.device = code;
              this.deviceState = 'waiting';
              this.deviceStarted = this.now().getTime();
              this.deviceAnnounced = false;
              this.deviceUrl = safeVerificationUri(uri, server);
              this.deviceUntrusted = this.deviceUrl === null ? uri : null;
              this.show('device');
              if (this.deviceUrl !== null) await this.platform.openUrl(this.deviceUrl);
            },
          });
          await this.platform.secretSet(login.token);
          this.token = login.token;
          api.setToken(login.token);
          const me = await api.me();
          this.me = me;
          this.persist({
            lastServer: server,
            session: { server, identifier: me.identifier, displayName: me.displayName ?? null, scopes: login.scopes, expiresAt: login.expiresAt },
          });
          this.device = null;
          this.view = 'main';
          this.welcome = true;
          this.setNotice(null);
          await this.load(api);
        } catch (error) {
          if (error instanceof DeviceFlowError) {
            if (error.reason === 'cancelled') return;
            this.deviceState = error.reason === 'expired' ? 'expired' : error.reason === 'denied' ? 'denied' : 'scope';
            this.view = 'device';
            return;
          }
          this.device = null;
          this.view = 'login';
          throw error;
        }
      },
      undefined,
      () => ({ stage, server }),
      () => this.connect(server),
    );
  }

  cancelDevice(): void {
    this.abort?.abort();
    this.device = null;
    this.show('login');
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
    // The schedule (overrides, days off, Beacon's copy) belongs to the person who signs out.
    this.persist({ session: null, activeTimer: null, idleCheck: WATCHING, pendingNote: null, schedule: { ...EMPTY_SCHEDULE } });
    this.reminderToast = null;
    this.queue.clear();
    this.tasks = [];
    this.entries = null;
    this.me = null;
    this.clampNotes = [];
    this.meetingOpen = false;
    this.welcome = false;
    this.main?.prompt.dispose();
    this.main = null;
    this.query = '';
    this.error = null;
    this.view = 'login';
    this.setNotice(notice);
    this.render();
    await this.updateTray();
  }

  // ---- timer ------------------------------------------------------------------------------------------------------

  async refresh(): Promise<void> {
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
  }

  private setMe(me: Me): void {
    this.me = me;
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

  async start(task: Task): Promise<void> {
    const running = this.state.activeTimer;
    this.welcome = false;
    if (running !== null) this.persist({ messages: afterStop(this.state.messages, this.timerKind(running), running.startedAt, this.now()) });
    this.persist({ lastTask: this.taskRef(task) });
    await this.guard(
      async () => {
        const api = this.api();
        await this.setTimer(running !== null ? (await api.switchTask(task.id, this.state.pendingNote ?? undefined)).timer : await api.start(task.id));
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

  /** Whether a meeting-like task is running (softer "Still in the meeting?", longer countdown). */
  inMeeting(): boolean {
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
      await this.platform.setTray({
        title: `${time} ${short}`,
        tooltip: t('trayTooltipRunning', { task: timer.taskTitle, time, today }),
        status: `● ${time} · ${timer.taskTitle}`,
        running: true,
      });
    } else {
      await this.platform.setTray({
        title: null,
        tooltip: t('trayTooltipIdle', { today }),
        status: t('trayNotTracking'),
        running: false,
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
      openBeacon: dashboardUrl(server) !== null ? t('openBeacon') : null,
      myTime: myTimeUrl(server) !== null ? t('myTime') : null,
      checkUpdates: signedIn && this.channel === 'direct' ? t('trayCheckUpdates') : null,
      pauseFriendly: !signedIn || (!this.state.settings.funMessages && !this.state.settings.wellbeingReminders)
        ? null
        : pausedAt(this.state.messages, this.now())
          ? { id: 'resume-friendly', label: t('trayFriendlyPaused', { time: this.time(this.state.messages.pausedUntil as string) }) }
          : { id: 'pause-friendly', label: t('trayPauseFriendly') },
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
    else if (action === 'open-beacon') this.openBeacon(dashboardUrl(server));
    else if (action === 'my-time') this.openBeacon(myTimeUrl(server));
    else if (action === 'settings' && this.state.session !== null) this.show('settings');
    else if (action === 'check-updates' && this.state.session !== null) {
      if (this.view !== 'update-required') this.show('main');
      await this.checkUpdates(true);
    }
    else if (action.startsWith('switch:')) {
      const task = this.quickTasks().find((item) => item.id === action.slice(7));
      if (task !== undefined) await this.start(task);
    }
  }

  /** Registers the global shortcut; a refusal (in use / invalid) is shown in Settings and the previous one is kept. */
  async applyShortcut(accelerator: string, save = true): Promise<boolean> {
    const value = accelerator.trim();
    try {
      await this.platform.setShortcut(value);
    } catch {
      this.shortcutMessage = { text: this.t('shortcutFailed', { shortcut: value }), ok: false };
      this.render();
      return false;
    }
    if (save) {
      this.persist({ settings: { ...this.state.settings, shortcut: value } });
      this.shortcutMessage = { text: this.t('shortcutSaved', { shortcut: value }), ok: true };
      this.render();
    }
    return true;
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
    await this.updateTray();
    if (this.view === 'main' && this.longRunning() !== (this.main?.banners.querySelector('#long-running') !== null)) this.render();
    this.checkReminders();
    this.checkFriendly();
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
    const url = this.deps.storeUrl !== undefined && this.deps.storeUrl.startsWith('https://') ? this.deps.storeUrl : session !== null ? appsPage(session.server) : null;
    if (url !== null) void this.platform.openUrl(url);
  }

  openApps(): void {
    const session = this.state.session;
    if (session !== null) void this.platform.openUrl(appsPage(session.server));
  }

  /**
   * Opens a Beacon page in the browser. The URL is checked again against the connected server right before opening
   * (https, same origin, no credentials); anything else is ignored.
   */
  openBeacon(url: string | null | undefined): void {
    const safe = sameOriginHttps(url, this.state.session?.server);
    if (safe !== null) void this.platform.openUrl(safe);
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
    for (const key of LOCAL_KEYS) this.storage.removeItem(key);
    this.token = null;
    this.state = emptyState();
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

  // ---- keyboard ---------------------------------------------------------------------------------------------------

  focusSearch(): void {
    if (this.state.session === null) return;
    if (this.view !== 'main') this.show('main');
    this.main?.search.focus();
    this.main?.search.select();
  }

  /** In-app shortcuts: Ctrl/⌘+K or "/" search, Alt+1…9 quick tasks, Ctrl/⌘+Shift+S stop / resume, Ctrl/⌘+, settings. */
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
      } else if (error instanceof ApiError && error.isNetwork && this.state.session !== null) {
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
    const reminderAt = this.nextReminderAt();
    if (!this.idleCheckEnabled()) return { deadlineAt: null, idleAfterSeconds: null, reminderAt };
    const settings = this.idleSettings();
    return {
      deadlineAt: state.phase === 'asking' && state.returnedAt === null ? Date.parse(state.askedAt) + settings.answerTimeoutMinutes * 60_000 : null,
      idleAfterSeconds: state.phase === 'watching' && this.state.activeTimer !== null ? settings.thresholdMinutes * 60 : null,
      reminderAt,
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
        this.view === 'main' && this.iconButton('settings', t('settings'), { id: 'open-settings', onClick: () => this.show('settings'), shortcut: 'Control+,' }),
        this.view === 'login' && this.iconButton('help', t('whereFind'), { id: 'help', onClick: () => this.toggleWhere() }),
      ),
    ]);
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
        safe !== null
          ? h('button', { class: 'secondary', id: 'open-again', key: 'open-again', attrs: { type: 'button' }, on: { click: () => void this.platform.openUrl(safe) } }, icon('external'), t('openAgain'))
          : h('button', { class: 'secondary', id: 'copy-address', attrs: { type: 'button' }, on: { click: () => void this.copy(this.deviceUntrusted ?? '') } }, icon('copy'), t('copyAddress')),
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
    for (const child of [this.header, ...Array.from(main.root.children)]) {
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
    const key = `${card === null ? '' : `${card.kind}:${card.line}:${card.shownAt}`}|${daily?.text ?? ''}|${reminder === null ? '' : `${reminder.slot}:${reminder.shownAt}:${this.reminderActionable(reminder)}`}`;
    if (key === this.toastKey) return;
    this.toastKey = key;
    patch(this.toastRegion, [
      reminder !== null && this.renderReminder(reminder),
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
      this.renderLists(this.main as MainRegions);
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
      footer: h('footer', { class: 'footer' }),
      modal,
      prompt: new PromptMount(modal, { onAnswer: (answer) => void this.answerPrompt(answer), onExpired: () => void this.tick(), now: this.now }),
    };
    regions.root.addEventListener('keydown', (event) => {
      if (event.target !== search && !regions.modal.contains(event.target as Node)) this.onListKey(event);
    });
    regions.root.append(
      regions.banners,
      regions.timer,
      regions.totals,
      h('div', { class: 'search' }, icon('search'), search),
      h('p', { class: 'sr-only', id: 'search-hint' }, t('searchHint')),
      regions.quick,
      regions.list,
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
      this.renderUpdateCard(),
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

  /** A friendly message: smile, cheer or a gentle nudge, in the Beacon user's language. A toast, never focused. */
  /** A working-hours reminder as a toast: its line, the button (Start / Stop / Resume) while it applies, ×. */
  private renderReminder(note: ReminderNote): HTMLElement {
    const action = note.action !== null && note.actionLabel !== null && this.reminderActionable(note)
      ? h('button', { class: 'secondary small toast-action', id: 'reminder-action', key: 'reminder-action', attrs: { type: 'button', lang: note.locale, 'data-action': note.action }, on: { click: () => void this.reminderAction(note.action) } }, note.actionLabel)
      : null;
    return this.toast('reminder', note.pose, note.text, note.locale, () => this.showReminderToast(null), note.kind, action);
  }

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
            h('button', { class: 'primary', id: 'resume', key: 'resume', attrs: { 'aria-disabled': this.busy ? 'true' : undefined, 'aria-label': t('resumeTask', { task: last.title }), 'aria-keyshortcuts': 'Control+Shift+S' }, on: { click: () => this.whenIdle(() => this.resume()) } }, icon('play'), t('resume')),
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
      myTime !== null && this.beaconLink(myTime, t('myTime'), { id: 'open-my-time', key: 'open-my-time', className: 'my-time' }),
    ]);
  }

  private renderLists(main: MainRegions): void {
    const t = this.t;
    const searching = this.query.trim() !== '';
    const perTask = this.entries !== null ? todayByTask(this.entries, this.state.activeTimer, this.now()) : new Map<string, number>();
    const quick = this.quickTasks();
    if (searching) {
      patch(main.quick, [], '#search');
    } else {
      patch(
        main.quick,
        [
          h('h2', { class: 'section-title', id: 'quick-title' }, t('pinnedRecent')),
          quick.length > 0
            ? h('ul', { class: 'tasks', id: 'quick', attrs: { 'aria-labelledby': 'quick-title' } }, ...quick.map((task, index) => this.taskRow(task, perTask, index + 1)))
            : h('p', { class: 'empty-state', id: 'quick-empty' }, t('noRecent')),
        ],
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
          h('p', { class: 'empty-state', id: 'tasks-empty' }, moment(searching ? 'noResults' : 'noTasks', 'mascot tiny', t), h('span', {}, searching ? t('noResults', { query: this.query.trim() }) : t('noTasks'))),
      ],
      this.state.activeTimer !== null ? 'stop' : '#search',
    );
  }

  private taskRow(task: Task, perTask: Map<string, number>, number?: number): HTMLElement {
    const t = this.t;
    const running = this.state.activeTimer !== null;
    const link = taskUrl(task.url, this.state.session?.server);
    const pinned = this.isPinned(task.id);
    const seconds = perTask.get(task.id) ?? 0;
    const meta = [taskContext(task), seconds > 0 ? t('todayOnTask', { time: formatHoursMinutes(seconds) }) : ''].filter((part) => part !== '').join(' · ');
    const label = running ? t('switchTask', { task: task.title }) : t('startTask', { task: task.title });
    return h(
      'li',
      { attrs: { 'data-task': task.id } },
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
    if (state.phase === 'watching') return null;
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
        const blocks: PromptBlock[] = [
          ...(quip !== null ? [text(quip.text, 'idle-quip', 'quip', locale)] : []),
          text(t('stillThereText', { minutes: Math.max(minutes, settings.thresholdMinutes), task: state.taskTitle }), 'idle-text'),
          text(t('stillThereSince', { time: this.time(state.from) }), undefined, 'muted'),
          this.meetingOpen
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
                items: [
                  button('idle-here', t('idleHere'), 'primary', 'here'),
                  button('idle-meeting', t('idleMeeting'), 'secondary', 'meeting-open', { expanded: false }),
                  button('idle-discard', t('idleDiscardMinutes', { minutes }), 'secondary', 'discard'),
                  button('idle-pause', t('idlePause', { time: this.time(state.from) }), 'secondary', 'pause'),
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
        const targets = options(this.reassignTargets(state.taskId));
        const choices: PromptChoices =
          features.startBackdate && features.stopBackdate
            ? {
                kind: 'choices',
                layout: 'list',
                labelledBy: 'gap-title',
                items: [
                  resumeNow(state.taskTitle),
                  button('gap-keep', t('gapKeep', { task: state.taskTitle }), 'secondary', 'gap-keep'),
                  ...(targets.length > 0 ? [{ kind: 'reassign' as const, label: t('gapOtherTask'), options: targets, button: button('gap-reassign', t('gapReassign'), 'secondary', 'gap-reassign') }] : []),
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
    const task = (id: string | undefined) => (id === undefined || id === '' ? undefined : this.reassignTargets(state.phase === 'watching' ? '' : state.taskId).find((item) => item.id === id));
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
      case 'resume-now':
        return this.resumeNow();
      case 'resume':
        return this.resumeAfterGap(true);
      case 'not-now':
        return this.resumeAfterGap(false);
      case 'escape':
        // Never a dismissal: the prompt stays until it is answered.
        return;
    }
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
      this.renderIdleSettings(),
      this.renderSchedule(),
      this.renderFriendlySettings(),
      this.renderFeature('notifications', 'featureNotifications', 'featureNotificationsText'),
      // Store (MSIX) builds cannot register the login item the autostart plugin writes: no switch there.
      this.channel === 'direct' && this.renderFeature('autostart', 'featureAutostart', 'featureAutostartText'),
      h('p', { class: 'muted', id: 'background-note' }, this.t('backgroundNote')),
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
      section('privacy-local', 'privacyLocalTitle', ['privacyLocalToken', 'privacyLocalState', 'privacyLocalIdle', 'privacyLocalTotals']),
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
