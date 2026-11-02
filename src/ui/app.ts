import { ApiError, TimeTrackApi, normalizeServerUrl } from '../api/client';
import type { DeviceCode, IdleAction, Me, Task, Timer } from '../api/types';
import { DeviceFlowError, runDeviceFlow } from '../lib/deviceFlow';
import { createTranslator, detectLocale, type Locale, type MessageKey, type Translate } from '../lib/i18n';
import { IdleMonitor, clampPeriod, type IdlePeriod } from '../lib/idle';
import { OfflineQueue } from '../lib/queue';
import { type Feature, type LocalState, hasConsent, loadLocal, recordConsent, saveLocal } from '../lib/settings';
import { elapsedSeconds, formatElapsed } from '../lib/time';
import { updateRequired } from '../lib/version';
import { withinWorkingHours } from '../lib/workingHours';
import type { Platform } from '../platform';
import { h } from './dom';

export type View = 'loading' | 'login' | 'device' | 'main' | 'settings' | 'privacy' | 'update-required';

export interface AppDeps {
  storage?: Storage;
  now?: () => Date;
  locale?: Locale;
  beaconUrl?: string;
  /** Device-flow sleep (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
  searchDelayMs?: number;
}

const ERROR_KEYS: Record<string, MessageKey> = {
  network_error: 'errorNetwork',
  rate_limited: 'errorRateLimited',
  insecure_url: 'errorInsecureUrl',
  invalid_url: 'errorInvalidUrl',
  task_forbidden: 'errorTaskForbidden',
  timer_running: 'errorTimerRunning',
  insufficient_scope: 'errorScope',
};

const DEVICE_ERRORS: Record<string, MessageKey> = {
  expired: 'deviceExpired',
  denied: 'deviceDenied',
  invalid_scope: 'deviceScope',
};

/** Desktop UI state machine. DOM nodes only (no innerHTML); all platform access goes through `Platform`. */
export class DesktopApp {
  view: View = 'loading';
  state: LocalState;
  tasks: Task[] = [];
  me: Me | null = null;
  device: DeviceCode | null = null;
  idle: IdlePeriod | null = null;
  update: { version: string; min?: string | null } | null = null;
  error: string | null = null;
  notice: string | null = null;
  offline = false;
  busy = false;
  query = '';
  version = '0.0.0';
  readonly t: Translate;
  readonly queue: OfflineQueue;
  readonly monitor: IdleMonitor;
  private token: string | null = null;
  private abort: AbortController | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;
  private readonly storage: Storage;

  constructor(
    private readonly root: HTMLElement,
    private readonly platform: Platform,
    private readonly deps: AppDeps = {},
  ) {
    this.storage = deps.storage ?? localStorage;
    this.now = deps.now ?? (() => new Date());
    this.t = createTranslator(deps.locale ?? detectLocale(globalThis.navigator?.language));
    this.state = loadLocal(this.storage);
    this.queue = new OfflineQueue(this.storage);
    this.monitor = new IdleMonitor(this.state.settings.idleMinutes * 60);
  }

  async init(): Promise<void> {
    this.version = await this.platform.appVersion();
    this.platform.on('tray-stop', () => void this.stop());
    this.platform.on('shortcut', () => (this.root.querySelector('#search') as HTMLInputElement | null)?.focus());
    this.token = await this.platform.secretGet();
    if (this.state.session === null || this.token === null) {
      this.show('login');
      return;
    }
    this.show('main');
    await this.refresh();
    await this.checkUpdates();
  }

  destroy(): void {
    this.abort?.abort();
    if (this.ticker !== null) clearInterval(this.ticker);
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
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
    this.view = view;
    this.render();
  }

  // ---- connection -------------------------------------------------------------------------------------------------

  /** Device-flow sign-in: shows the user code, opens the verification page, polls until approved. */
  async connect(server: string): Promise<void> {
    let normalized: string;
    try {
      normalized = normalizeServerUrl(server);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.abort = new AbortController();
    const api = new TimeTrackApi({ baseUrl: normalized, source: 'desktop', fetchImpl: this.platform.fetch });
    await this.guard(async () => {
      try {
        const login = await runDeviceFlow(api, {
          clientName: `TimeTrack desktop (${await this.platform.hostName()})`,
          sleep: this.deps.sleep,
          signal: this.abort?.signal,
          onCode: async (code) => {
            this.device = code;
            this.show('device');
            await this.platform.openUrl(code.verificationUriComplete ?? code.verificationUri);
          },
        });
        await this.platform.secretSet(login.token);
        this.token = login.token;
        api.setToken(login.token);
        const me = await api.me();
        this.me = me;
        this.persist({
          lastServer: normalized,
          session: { server: normalized, identifier: me.identifier, displayName: me.displayName ?? null, scopes: login.scopes, expiresAt: login.expiresAt },
        });
        this.device = null;
        this.notice = null;
        this.view = 'main';
        await this.load(api);
      } catch (error) {
        this.device = null;
        this.view = 'login';
        if (error instanceof DeviceFlowError) {
          if (error.reason !== 'cancelled') this.error = this.t(DEVICE_ERRORS[error.reason]);
          return;
        }
        throw error;
      }
    });
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
    this.me = null;
    this.idle = null;
    this.notice = notice;
    await this.platform.setTray(this.t('noTimer'), false);
    this.show('login');
  }

  // ---- timer ------------------------------------------------------------------------------------------------------

  async refresh(): Promise<void> {
    await this.guard(() => this.load(this.api()));
  }

  private async load(api: TimeTrackApi): Promise<void> {
    if (this.queue.size > 0) {
      const result = await this.queue.sync(api, this.now);
      this.notice = this.t('synced', { count: result.synced });
      if (result.dropped.length > 0) this.error = this.t('dropped', { count: result.dropped.length });
    }
    const [timer, tasks, me] = await Promise.all([api.timer(), api.tasks({ search: this.query }), api.me()]);
    this.offline = false;
    this.tasks = tasks;
    this.me = me;
    await this.setTimer(timer);
  }

  async search(query: string): Promise<void> {
    this.query = query;
    await this.guard(async () => {
      this.tasks = await this.api().tasks({ search: query });
    });
  }

  async start(task: Task): Promise<void> {
    const running = this.state.activeTimer;
    await this.guard(
      async () => {
        const api = this.api();
        await this.setTimer(running !== null ? (await api.switchTask(task.id)).timer : await api.start(task.id));
      },
      () => {
        const at = this.now().toISOString();
        this.queue.push(running !== null ? { kind: 'switch', taskId: task.id, taskTitle: task.title, at } : { kind: 'start', taskId: task.id, taskTitle: task.title, at });
        return this.setTimer({ id: 'offline', taskId: task.id, taskTitle: task.title, startedAt: at });
      },
    );
  }

  async stop(): Promise<void> {
    if (this.state.activeTimer === null) return;
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
  }

  private async setTimer(timer: Timer | null): Promise<void> {
    this.persist({ activeTimer: timer });
    if (timer === null) this.monitor.reset();
    await this.updateTray();
  }

  async updateTray(): Promise<void> {
    const timer = this.state.activeTimer;
    const text = timer !== null ? `${formatElapsed(elapsedSeconds(timer.startedAt, this.now()))} · ${timer.taskTitle}` : this.t('noTimer');
    await this.platform.setTray(text, timer !== null);
  }

  // ---- idle (local only) -----------------------------------------------------------------------------------------

  /** Called every ~30 s: local idle check (opt-in) and tray refresh. */
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
    if (result.status !== 'available') return;
    this.update = { version: result.version, min: result.min_supported_version };
    if (updateRequired(this.version, result.min_supported_version)) {
      this.show('update-required');
    } else {
      this.render();
    }
  }

  async installUpdate(): Promise<void> {
    const session = this.state.session;
    if (session === null || this.token === null) return;
    await this.guard(() => this.platform.installUpdate(session.server, this.token ?? ''));
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

  // ---- plumbing ---------------------------------------------------------------------------------------------------

  private async guard(action: () => Promise<void>, offline?: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = null;
    this.render();
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        await this.signedOut(this.t('sessionExpired'));
      } else if (error instanceof ApiError && error.isNetwork && this.state.session !== null) {
        this.offline = true;
        if (offline !== undefined) await offline();
      } else {
        this.fail(error);
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private fail(error: unknown): void {
    const key = error instanceof ApiError ? ERROR_KEYS[error.code] : undefined;
    const message = error instanceof Error ? error.message : String(error);
    this.error = key !== undefined ? this.t(key) : this.t('errorGeneric', { message });
    this.render();
  }

  render(): void {
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    const t = this.t;
    const signedIn = this.state.session !== null;
    const header = h(
      'header',
      { class: 'bar' },
      h('h1', {}, t('appName')),
      this.view === 'main' && h('button', { class: 'link', id: 'open-settings', on: { click: () => this.show('settings') } }, t('settings')),
      (this.view === 'settings' || this.view === 'privacy') &&
        h(
          'button',
          { class: 'link', id: 'back', on: { click: () => this.show(this.view === 'privacy' && signedIn ? 'settings' : signedIn ? 'main' : 'login') } },
          t('back'),
        ),
    );
    const messages = h(
      'div',
      { attrs: { 'aria-live': 'polite' } },
      this.notice !== null && h('p', { class: 'notice', id: 'notice' }, this.notice),
      this.offline && signedIn && h('p', { class: 'notice offline', id: 'offline' }, t('offline', { count: this.queue.size })),
      this.error !== null && h('p', { class: 'error', id: 'error', attrs: { role: 'alert' } }, this.error),
    );
    const views: Record<View, () => HTMLElement> = {
      loading: () => h('p', {}, '…'),
      login: () => this.renderLogin(),
      device: () => this.renderDevice(),
      main: () => this.renderMain(),
      settings: () => this.renderSettings(),
      privacy: () => this.renderPrivacy(),
      'update-required': () => this.renderUpdateRequired(),
    };
    this.root.replaceChildren(header, messages, views[this.view]());
    this.root.setAttribute('aria-busy', this.busy ? 'true' : 'false');
  }

  private renderLogin(): HTMLElement {
    const t = this.t;
    const server = h('input', { id: 'server', attrs: { type: 'url', required: true, placeholder: 'https://beacon.example.com' } });
    server.value = this.state.lastServer ?? this.deps.beaconUrl ?? '';
    return h(
      'form',
      {
        id: 'login-form',
        on: {
          submit: (event) => {
            event.preventDefault();
            void this.connect(server.value);
          },
        },
      },
      h('h2', {}, t('loginTitle')),
      h('p', { class: 'help' }, t('loginHelp')),
      h('label', {}, t('serverUrl'), server),
      h('button', { class: 'primary', id: 'connect', attrs: { type: 'submit', disabled: this.busy } }, t('connect')),
      h('button', { class: 'link', id: 'open-privacy', attrs: { type: 'button' }, on: { click: () => this.show('privacy') } }, t('whatWeCollect')),
    );
  }

  private renderDevice(): HTMLElement {
    const t = this.t;
    const code = this.device;
    const uri = code?.verificationUriComplete ?? code?.verificationUri ?? '';
    return h(
      'main',
      { id: 'device' },
      h('h2', {}, t('deviceTitle')),
      h('p', { class: 'user-code', id: 'user-code' }, code?.userCode ?? ''),
      h('p', { class: 'help' }, t('deviceHelp', { uri: code?.verificationUri ?? '' })),
      h('button', { class: 'link', id: 'open-again', on: { click: () => void this.platform.openUrl(uri) } }, t('openAgain')),
      h('p', { class: 'muted' }, t('waiting')),
      h('button', { class: 'danger', id: 'cancel-device', on: { click: () => this.cancelDevice() } }, t('cancel')),
    );
  }

  private renderMain(): HTMLElement {
    const t = this.t;
    const timer = this.state.activeTimer;
    let card: HTMLElement;
    if (timer !== null) {
      const elapsed = h('span', { class: 'elapsed', id: 'elapsed' }, formatElapsed(elapsedSeconds(timer.startedAt, this.now())));
      this.ticker = setInterval(() => {
        elapsed.textContent = formatElapsed(elapsedSeconds(timer.startedAt, this.now()));
      }, 1000);
      card = h(
        'section',
        { class: 'card running', id: 'timer' },
        h('span', { class: 'label' }, t('tracking')),
        h('strong', { id: 'timer-task' }, timer.taskTitle),
        elapsed,
        h('button', { class: 'danger', id: 'stop', attrs: { disabled: this.busy }, on: { click: () => void this.stop() } }, t('stop')),
      );
    } else {
      card = h('section', { class: 'card', id: 'timer' }, h('span', {}, t('noTimer')));
    }
    const search = h('input', { id: 'search', attrs: { type: 'search', placeholder: t('searchTasks'), 'aria-label': t('searchTasks') } });
    search.value = this.query;
    search.addEventListener('input', () => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => void this.search(search.value), this.deps.searchDelayMs ?? 250);
    });
    const list = h('ul', { class: 'tasks', id: 'tasks' });
    for (const task of this.tasks) {
      const current = timer?.taskId === task.id;
      list.append(
        h(
          'li',
          { attrs: { 'data-task': task.id } },
          h('span', { class: 'task' }, h('span', {}, task.title), task.boardTitle ? h('small', {}, task.boardTitle) : null),
          current
            ? h('span', { class: 'label' }, t('tracking'))
            : h('button', { class: 'primary small', attrs: { disabled: this.busy }, on: { click: () => void this.start(task) } }, timer !== null ? t('switch') : t('start')),
        ),
      );
    }
    if (this.tasks.length === 0 && !this.busy) list.append(h('li', { class: 'empty' }, t('noTasks')));
    const update = this.update;
    return h(
      'main',
      {},
      update !== null &&
        h(
          'section',
          { class: 'card update', id: 'update' },
          h('span', {}, t('updateAvailable', { version: update.version })),
          h('button', { class: 'primary small', id: 'install-update', on: { click: () => void this.installUpdate() } }, t('installUpdate')),
        ),
      this.idle !== null && this.renderIdle(this.idle),
      card,
      this.offline && h('p', { class: 'muted' }, t('offlineStartNote')),
      search,
      list,
      h('p', { class: 'muted' }, t('signedInAs', { name: this.state.session?.displayName ?? this.state.session?.identifier ?? '' })),
    );
  }

  private renderIdle(period: IdlePeriod): HTMLElement {
    const t = this.t;
    const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    const date = record ? new Date(record.at).toLocaleString() : '';
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
    return h(
      'main',
      {},
      this.renderFeature('idleDetection', 'featureIdle', 'featureIdleText', h('label', { class: 'inline' }, t('idleMinutes'), minutes)),
      this.renderFeature('notifications', 'featureNotifications', 'featureNotificationsText'),
      this.renderFeature('autostart', 'featureAutostart', 'featureAutostartText'),
      h('button', { class: 'link', id: 'open-privacy', on: { click: () => this.show('privacy') } }, t('whatWeCollect')),
      h('button', { class: 'danger', id: 'logout', on: { click: () => void this.logout() } }, t('logout')),
      h('p', { class: 'muted' }, t('version', { version: this.version })),
    );
  }

  private renderPrivacy(): HTMLElement {
    const t = this.t;
    return h(
      'main',
      { id: 'privacy' },
      h('h2', {}, t('whatWeCollect')),
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
      { id: 'update-required', attrs: { role: 'alertdialog' } },
      h('h2', {}, t('updateRequiredTitle')),
      h('p', {}, t('updateRequiredText', { current: this.version, min: this.update?.min ?? '' })),
      h('button', { class: 'primary', id: 'install-required', attrs: { disabled: this.busy }, on: { click: () => void this.installUpdate() } }, t('installUpdate')),
    );
  }
}
