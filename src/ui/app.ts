import { ApiError, TimeTrackApi, normalizeServerUrl } from '../api/client';
import type { DeviceCode, Entry, IdleAction, Me, Task, Timer } from '../api/types';
import { dashboardUrl, myTimeUrl, sameOriginHttps, taskUrl } from '../lib/beacon';
import { DeviceFlowError, runDeviceFlow } from '../lib/deviceFlow';
import { type ErrorStage, type ErrorView, describeError } from '../lib/errors';
import { createTranslator, detectLocale, type Locale, type MessageKey, type Translate } from '../lib/i18n';
import { IdleMonitor, clampPeriod, type IdlePeriod } from '../lib/idle';
import { preflight } from '../lib/preflight';
import { OfflineQueue } from '../lib/queue';
import { hostOf, prepareServerUrl, type ServerUrlProblem } from '../lib/serverUrl';
import { type Feature, type LocalState, DEFAULT_SETTINGS, MAX_PINNED, hasConsent, loadLocal, recordConsent, saveLocal } from '../lib/settings';
import { computeTotals, formatHoursMinutes, recentTasks, startOfWeek, taskContext, todayByTask, type Totals } from '../lib/summary';
import { elapsedSeconds, formatElapsed } from '../lib/time';
import { appsPage, safeVerificationUri } from '../lib/urls';
import { compareVersions, isVersion, updateRequired } from '../lib/version';
import { withinWorkingHours } from '../lib/workingHours';
import type { Platform, TrayMenu } from '../platform';
import { h, patch, type Child } from './dom';
import { icon, type IconName } from './icons';

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
}

type DeviceState = 'waiting' | 'expired' | 'denied' | 'scope';

const URL_PROBLEMS: Record<ServerUrlProblem, MessageKey> = {
  empty: 'urlEmpty',
  invalid: 'urlInvalid',
  credentials: 'urlCredentials',
  insecure: 'urlInsecure',
};

/** Mascot illustration for an error (Beacon brand: friendly, empty and error states only). */
const ERROR_ART: Record<string, string> = {
  not_beacon: 'error-404',
  no_device_flow: 'error-404',
  invalid_response: 'error-404',
  unreachable: 'error-503',
  server: 'error-503',
  rate_limited: 'error-429',
  insufficient_scope: 'error-401',
};

const MAX_TRAY_TASKS = 7;
/** Entries pages fetched for the week totals (100 each). */
const MAX_ENTRY_PAGES = 5;

/** `m:ss` for the device-code countdown. */
function countdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Image with 1x / 2x sources from `public/mascot/`. */
function art(name: string, alt: string, className: string): HTMLImageElement {
  return h('img', {
    class: className,
    attrs: { src: `mascot/${name}.webp`, srcset: `mascot/${name}.webp 1x, mascot/${name}@2x.webp 2x`, alt, decoding: 'async' },
  });
}

interface MainRegions {
  root: HTMLElement;
  banners: HTMLElement;
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
  idle: IdlePeriod | null = null;
  update: { version: string; min: string | null; installable: boolean } | null = null;
  /** Non-blocking update message (no automatic update possible, or it failed): shown with a Beacon download link. */
  updateMessage: string | null = null;
  /** "Remind me later" on the update-required screen: hidden until the next launch. */
  updateDismissed = false;
  /** Verification URI that failed the same-host check: shown as text, never opened. */
  deviceUntrusted: string | null = null;
  /** The current failure (error catalogue), shown with its actions until dismissed or resolved. */
  error: ErrorView | null = null;
  notice: string | null = null;
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
  readonly monitor: IdleMonitor;
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
  private lastTrayMenu = '';
  private main: MainRegions | null = null;
  private readonly header: HTMLElement;
  private readonly status: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly body: HTMLElement;
  private readonly now: () => Date;
  private readonly storage: Storage;
  private readonly timeFormat: Intl.DateTimeFormat;
  private readonly dateFormat: Intl.DateTimeFormat;

  constructor(
    private readonly root: HTMLElement,
    private readonly platform: Platform,
    private readonly deps: AppDeps = {},
  ) {
    this.storage = deps.storage ?? localStorage;
    this.now = deps.now ?? (() => new Date());
    this.locale = deps.locale ?? detectLocale(globalThis.navigator?.language);
    this.t = createTranslator(this.locale);
    this.timeFormat = new Intl.DateTimeFormat(this.locale, { hour: '2-digit', minute: '2-digit' });
    this.dateFormat = new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeStyle: 'short' });
    this.state = loadLocal(this.storage);
    this.serverDraft = this.state.lastServer ?? deps.beaconUrl ?? '';
    this.queue = new OfflineQueue(this.storage);
    this.monitor = new IdleMonitor(this.state.settings.idleMinutes * 60);
    document.documentElement.lang = this.locale;
    this.header = h('header', { class: 'bar' });
    this.status = h('div', { class: 'messages', id: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.alert = h('div', { class: 'messages', id: 'alerts', attrs: { role: 'alert' } });
    this.body = h('div', { class: 'view', id: 'view' });
    this.root.replaceChildren(this.header, this.status, this.alert, this.body);
    document.addEventListener('keydown', (event) => this.onKey(event));
  }

  async init(): Promise<void> {
    this.version = await this.platform.appVersion();
    this.platform.onTray((action) => void this.trayAction(action));
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
    for (const timer of [this.searchTimer, this.noticeTimer]) if (timer !== null) clearTimeout(timer);
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
      this.live = '';
      if (this.notice !== null) this.setNotice(null);
    }
    this.view = view;
    this.render();
  }

  /** Info notice in the status region; dismissed after a few seconds. */
  setNotice(text: string | null): void {
    this.notice = text;
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
    this.persist({ session: null, activeTimer: null });
    this.queue.clear();
    this.tasks = [];
    this.entries = null;
    this.me = null;
    this.idle = null;
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
      const result = await this.queue.sync(api, this.now);
      this.setNotice(this.t('synced', { count: result.synced }));
      if (result.dropped.length > 0) this.setNotice(this.t('dropped', { count: result.dropped.length }));
    }
    const [timer, tasks, me, entries] = await Promise.all([api.timer(), api.tasks({ search: this.query }), api.me(), this.loadEntries(api)]);
    this.offline = false;
    this.tasks = tasks;
    this.me = me;
    this.entries = entries;
    await this.setTimer(timer);
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
    this.persist({ lastTask: this.taskRef(task) });
    await this.guard(
      async () => {
        const api = this.api();
        await this.setTimer(running !== null ? (await api.switchTask(task.id)).timer : await api.start(task.id));
      },
      () => {
        const at = this.now().toISOString();
        this.queue.push(running !== null ? { kind: 'switch', taskId: task.id, taskTitle: task.title, at } : { kind: 'start', taskId: task.id, taskTitle: task.title, at });
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
    await this.guard(
      async () => {
        await this.api().stop();
        await this.setTimer(null);
      },
      () => {
        this.queue.push({ kind: 'stop', at: this.now().toISOString() });
        return this.setTimer(null);
      },
    );
    if (this.entries !== null) await this.reloadEntries();
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
    this.persist({ activeTimer: timer });
    if (timer === null) this.monitor.reset();
    await this.updateTray();
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
    else if (action === 'search') this.focusSearch();
    else if (action === 'open-beacon') this.openBeacon(dashboardUrl(server));
    else if (action === 'my-time') this.openBeacon(myTimeUrl(server));
    else if (action === 'settings' && this.state.session !== null) this.show('settings');
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

  // ---- idle (local only) -----------------------------------------------------------------------------------------

  /** Called every ~30 s: tray refresh and the local idle check (opt-in). */
  async tick(): Promise<void> {
    await this.updateTray();
    const timer = this.state.activeTimer;
    if (timer === null || this.idle !== null || !hasConsent(this.state, 'idleDetection')) return;
    this.monitor.thresholdSeconds = this.state.settings.idleMinutes * 60;
    const period = this.monitor.observe(await this.platform.idleSeconds(), this.now());
    const clamped = period !== null ? clampPeriod(period, timer.startedAt, this.now()) : null;
    if (clamped === null) return;
    this.idle = clamped;
    this.render();
    if (hasConsent(this.state, 'notifications') && withinWorkingHours(this.me?.workingHours, this.now())) {
      await this.platform.notify(this.t('idleTitle'), this.t('idleNotification'));
    }
  }

  /** The user's decision about the idle period: the only idle-related data that reaches the server. */
  async resolveIdle(action: IdleAction): Promise<void> {
    const period = this.idle;
    if (period === null) return;
    this.idle = null;
    await this.guard(async () => {
      try {
        const change = await this.api().discardIdle(period.from, period.to, action);
        await this.setTimer(change.timer);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'no_active_timer') {
          await this.setTimer(null);
          return;
        }
        throw error;
      }
    });
  }

  // ---- updates ----------------------------------------------------------------------------------------------------

  async checkUpdates(): Promise<void> {
    const session = this.state.session;
    if (session === null || this.token === null) return;
    const result = await this.platform.checkUpdate(session.server, this.token);
    if (result.status === 'unauthorized') {
      await this.signedOut(this.t('sessionExpired'));
      return;
    }
    if (result.status === 'error') return;
    // Validate the server's minimum before ever blocking (audit CN D1).
    const min = isVersion(result.min_supported_version) ? result.min_supported_version : null;
    const below = min !== null && updateRequired(this.version, min);
    if (result.status === 'up_to_date') {
      this.update = null;
      this.updateMessage = below ? this.t('updateUnavailable', { min }) : null;
      this.render();
      return;
    }
    const installable = result.installable !== false && isVersion(result.version);
    this.update = { version: result.version, min, installable };
    const satisfiable = below && isVersion(result.version) && compareVersions(min, result.version) <= 0;
    this.updateMessage = !installable
      ? this.t('updateManual', { version: result.version })
      : below && !satisfiable
        ? this.t('updateUnavailable', { min })
        : null;
    if (below && satisfiable && installable && !this.updateDismissed) {
      this.show('update-required');
    } else {
      if (this.view === 'update-required') this.view = 'main';
      this.render();
    }
  }

  /** Never traps the user: a failed download / verification becomes a non-blocking message with a Beacon link. */
  async installUpdate(): Promise<void> {
    const session = this.state.session;
    if (session === null || this.token === null) return;
    this.busy = true;
    this.render();
    try {
      await this.platform.installUpdate(session.server, this.token);
    } catch (error) {
      this.updateDismissed = true;
      this.updateMessage = this.t('updateFailed', { message: error instanceof Error ? error.message : String(error) });
      this.view = 'main';
    } finally {
      this.busy = false;
      this.render();
    }
  }

  remindLater(): void {
    this.updateDismissed = true;
    this.show('main');
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
      if (feature === 'idleDetection' && !enabled) this.monitor.reset();
    });
  }

  setIdleMinutes(minutes: number): void {
    this.persist({ settings: { ...this.state.settings, idleMinutes: minutes } });
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
    this.renderMessages();
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
      this.live !== '' && h('p', { class: 'sr-only', id: 'live' }, this.live),
      this.notice !== null && h('p', { class: 'notice', id: 'notice' }, this.notice),
      this.offline && signedIn && h('p', { class: 'notice warn', id: 'offline' }, t('offline', { count: this.queue.size })),
    ]);
    patch(this.alert, [this.error !== null ? this.renderError(this.error) : null]);
  }

  private renderError(error: ErrorView): HTMLElement {
    const t = this.t;
    const artName = ERROR_ART[error.id];
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
      artName !== undefined && art(artName, '', 'error-art'),
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
      art('mascot', t('mascotAlt'), 'mascot'),
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
        art('mascot-small', '', 'mascot small'),
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
      h('div', { class: 'mascot-wait', attrs: { 'aria-hidden': 'true' } }, art('mascot-wait', '', 'mascot'), art('mascot-arcs', '', 'mascot arcs')),
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
  }

  private buildMain(): MainRegions {
    const t = this.t;
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
    };
    regions.root.addEventListener('keydown', (event) => {
      if (event.target !== search) this.onListKey(event);
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
    );
    return regions;
  }

  private renderBanners(region: HTMLElement): void {
    const t = this.t;
    const update = this.update;
    patch(region, [
      update !== null &&
        update.installable &&
        this.updateMessage === null &&
        h(
          'section',
          { class: 'card update', id: 'update' },
          h('span', {}, t('updateAvailable', { version: update.version })),
          h('button', { class: 'primary small', id: 'install-update', on: { click: () => void this.installUpdate() } }, t('installUpdate')),
        ),
      this.updateMessage !== null &&
        h(
          'section',
          { class: 'card update', id: 'update-message' },
          h('span', {}, this.updateMessage),
          h('button', { class: 'secondary small', id: 'download-beacon', on: { click: () => this.openApps() } }, t('downloadFromBeacon')),
        ),
      this.idle !== null && this.renderIdle(this.idle),
      this.offline && h('p', { class: 'muted' }, t('offlineStartNote')),
    ]);
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
          last !== null && h('p', { class: 'last', id: 'last-task' }, t('lastTask', { task: last.title })),
          last !== null &&
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
            : h('p', { class: 'empty-state', id: 'quick-empty' }, art('mascot-small', '', 'mascot tiny'), t('noRecent')),
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
          h('p', { class: 'empty-state', id: 'tasks-empty' }, searching ? null : art('mascot-small', '', 'mascot tiny'), searching ? t('noResults', { query: this.query.trim() }) : t('noTasks')),
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

  private renderIdle(period: IdlePeriod): HTMLElement {
    const t = this.t;
    const time = (d: Date) => this.timeFormat.format(d);
    const minutes = Math.round((period.to.getTime() - period.from.getTime()) / 60000);
    return h(
      'section',
      { class: 'card idle', id: 'idle', attrs: { role: 'alertdialog', 'aria-labelledby': 'idle-title' } },
      h('strong', { id: 'idle-title' }, t('idleTitle')),
      h('p', {}, t('idleText', { from: time(period.from), to: time(period.to), minutes })),
      h('button', { class: 'primary', id: 'idle-keep', on: { click: () => void this.resolveIdle('keep') } }, t('idleKeep')),
      h('button', { class: 'secondary', id: 'idle-split', on: { click: () => void this.resolveIdle('split') } }, t('idleSplit')),
      h('button', { class: 'danger', id: 'idle-discard', on: { click: () => void this.resolveIdle('discard') } }, t('idleDiscard')),
    );
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

  private renderSettings(): HTMLElement {
    const t = this.t;
    const minutes = h('select', { id: 'idle-minutes' });
    for (const value of [5, 10, 15, 30]) {
      const option = h('option', { attrs: { value: String(value) } }, String(value));
      option.selected = value === this.state.settings.idleMinutes;
      minutes.append(option);
    }
    minutes.addEventListener('change', () => this.setIdleMinutes(Number(minutes.value)));
    const shortcut = h('input', { id: 'shortcut', attrs: { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'shortcut-help shortcut-message' } });
    shortcut.value = this.state.settings.shortcut;
    return h(
      'main',
      { id: 'settings' },
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
      this.renderFeature('idleDetection', 'featureIdle', 'featureIdleText', h('label', { class: 'inline' }, t('idleMinutes'), minutes)),
      this.renderFeature('notifications', 'featureNotifications', 'featureNotificationsText'),
      this.renderFeature('autostart', 'featureAutostart', 'featureAutostartText'),
      h('button', { class: 'link', id: 'open-privacy', on: { click: () => this.show('privacy') } }, t('whatWeCollect')),
      h('section', { class: 'about', id: 'about', attrs: { 'aria-labelledby': 'about-title' } },
        art('mascot-small', '', 'mascot tiny'),
        h('div', {}, h('h2', { id: 'about-title' }, t('about')), h('p', { class: 'muted' }, t('aboutText', { version: this.version }))),
      ),
      h('button', { class: 'danger', id: 'logout', on: { click: () => void this.logout() } }, t('logout')),
    );
  }

  private renderPrivacy(): HTMLElement {
    const t = this.t;
    return h(
      'main',
      { id: 'privacy' },
      h('p', {}, t('privacyIntro')),
      h(
        'ul',
        { class: 'plain' },
        h('li', {}, t('privacySent')),
        h('li', {}, t('privacyStored')),
        h('li', {}, t('privacyNever')),
        h('li', {}, t('privacyIdle')),
        h('li', {}, t('privacyRights')),
      ),
    );
  }

  private renderUpdateRequired(): HTMLElement {
    const t = this.t;
    return h(
      'main',
      { id: 'update-required', attrs: { role: 'alertdialog', 'aria-labelledby': 'update-required-title' } },
      h('h2', { id: 'update-required-title' }, t('updateRequiredTitle')),
      h('p', {}, t('updateRequiredText', { current: this.version, min: this.update?.min ?? '' })),
      h('button', { class: 'primary', id: 'install-required', attrs: { disabled: this.busy }, on: { click: () => void this.installUpdate() } }, t('installUpdate')),
      h('button', { class: 'secondary', id: 'download-required', on: { click: () => this.openApps() } }, t('downloadFromBeacon')),
      h('button', { class: 'link', id: 'remind-later', on: { click: () => this.remindLater() } }, t('updateLater')),
      h('button', { class: 'danger', id: 'logout-required', on: { click: () => void this.logout() } }, t('logout')),
    );
  }
}

/** Host of the connected server (exported for the tray / tests). */
export { hostOf };
