/**
 * The app shell (BD-2, approved prototype): title bar (brand, organization, quick switcher, timer pill, theme, help),
 * left rail (organization tiles, Chat / Tasks / Time module tabs, settings) and the modules. The Time module is the
 * existing DesktopApp, unchanged inside its panel; Tasks (BD-3b) is the TaskBoard client API module
 * (BEACON_DESKTOP_TASKS.md §9), hidden while the server answers `403 module_forbidden`.
 *
 * Owner decisions 2026-11-25: landing = Chat on first launch, then the last-used module, Time when a timer runs (Q1);
 * timer in the title bar, optionally also in the sidebar (Q2); sidebar density comfortable / compact (Q3); organization
 * switcher as rail tiles or a dropdown, and a timer never keeps running in another organization (Q4).
 */
import type { DesktopApp } from '../ui/app';
import { type Child, h, patch } from '../ui/dom';
import { type ChromeMode, type DeepLink, hostOs, type Platform } from '../platform';
import { windowControls } from './windowControls';
import { ChatNotifier, chatClickTarget, NOTIFY_KEY, PAUSE_HOUR_MS, parseChatClick, tomorrowMorning } from '../chat/notifications';
import type { Locale } from '../lib/i18n';
import type { ThemePreference } from '../lib/theme';
import { chatText, type ChatText } from '../chat/i18n';
import { chatIcon, type ChatIconName } from '../chat/icons';
import { CHAT_VIEW_KEY, ChatModule, showMenu } from '../chat/module';
import { tasksText, type TasksText } from '../tasks/i18n';
import { type Markers, OFFER_KEY as TASKS_OFFER_KEY, TasksModule, TASKS_VIEW_KEY } from '../tasks/module';
import { rankConversations } from '../chat/format';
import type { Context, Conversation } from '../chat/types';
import { isMuted, sectionOf } from '../chat/store';
import type { Allocation } from '../api/types';
import { type AskOn, meContexts } from '../lib/allocation';
import { AllocationDialog, type AllocationRequest } from './allocationDialog';
import type { MiniAction, MiniView } from '../ui/miniWindow';
import { shellText, type ShellText } from './i18n';
import { type AnyTab, isTimeTab, SettingsDialog, type SettingsSource } from './settings';
import { type SetupState, type SetupStep, SetupView } from './setup';
import { mergeSwitch, scoreItems, type SwitchGroup, type SwitchItem } from './switcher';
import { taskRef } from '../tasks/format';
import { ToastRegion } from '../ui/toastRegion';

export type ModuleId = 'chat' | 'tasks' | 'time';
export type Density = 'comfortable' | 'compact';
export type SwitcherStyle = 'tiles' | 'dropdown';
export type TimerPlacement = 'title' | 'title-sidebar';

export interface ShellPrefs {
  /** Last module used (`null`: never launched with the shell yet → Chat). */
  module: ModuleId | null;
  density: Density;
  switcher: SwitcherStyle;
  timer: TimerPlacement;
  /** Last context (`personal`, `org:<uuid>`). */
  context: string | null;
  /** Column markers (owner decision 2026-11-25): TaskBoard's emojis or colour dots. */
  markers: Markers;
  /** Guided first run (UX batch 6): `null` never run, `pending` on screen when the app quit, `done`. */
  setup: SetupState;
  /** Setup steps skipped. */
  skipped: SetupStep[];
}

export const SHELL_KEY = 'beacon-desktop-shell';
/** "Finish setup" chips dismissed (0.14.1): `<server origin>|<context>` keys. No account data. */
export const SETUP_CHIP_KEY = 'beacon-desktop-setup-chip';
const DEFAULTS: ShellPrefs = { module: null, density: 'comfortable', switcher: 'tiles', timer: 'title', context: null, markers: 'emoji', setup: null, skipped: [] };

export function loadShellPrefs(storage: Storage | undefined): ShellPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(SHELL_KEY) ?? 'null') as Partial<ShellPrefs> | null;
    if (raw === null || typeof raw !== 'object') return { ...DEFAULTS, skipped: [] };
    return {
      module: raw.module === 'chat' || raw.module === 'time' || raw.module === 'tasks' ? raw.module : null,
      density: raw.density === 'compact' ? 'compact' : 'comfortable',
      switcher: raw.switcher === 'dropdown' ? 'dropdown' : 'tiles',
      timer: raw.timer === 'title-sidebar' ? 'title-sidebar' : 'title',
      context: typeof raw.context === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.context) ? raw.context : null,
      markers: raw.markers === 'dots' ? 'dots' : 'emoji',
      setup: raw.setup === 'pending' || raw.setup === 'done' ? raw.setup : null,
      skipped: Array.isArray(raw.skipped) ? (['chat', 'tasks'] as const).filter((step) => raw.skipped?.includes(step)) : [],
    };
  } catch {
    return { ...DEFAULTS, skipped: [] };
  }
}

/**
 * Landing module (owner Q1, `BEACON_DESKTOP_TASKS.md` §9): a running timer wins; else the last module; first launch:
 * Chat. A module without its token opens on its "Connect" card in place (never another module silently); a module the
 * server hides (`tasksHidden`) falls back to Chat.
 */
export function landingModule(prefs: ShellPrefs, timerRunning: boolean, tasksHidden = false): ModuleId {
  if (timerRunning) return 'time';
  if (prefs.module === 'tasks' && tasksHidden) return 'chat';
  return prefs.module ?? 'chat';
}

const CONTEXT_COLORS = ['#1f6f54', '#2e5f8a', '#6a4c93', '#a2553a', '#8a6a1f', '#7a3e5c', '#3d6b6b'];

/** Tile letters and colour of a context (personal: neutral). */
export function contextBadge(context: Context, index: number): { tile: string; color: string } {
  if (context.key === 'personal') return { tile: context.label.slice(0, 1).toUpperCase() || 'P', color: '#4b5e56' };
  const words = context.label.split(/\s+/).filter((word) => word !== '');
  const tile = (words.length > 1 ? words[0][0] + words[1][0] : context.label.slice(0, 2)).toUpperCase();
  return { tile, color: CONTEXT_COLORS[index % CONTEXT_COLORS.length] };
}

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export interface ShellDeps {
  locale: Locale;
  storage?: Storage;
  now?: () => number;
}

export class Shell {
  readonly root: HTMLElement;
  readonly timeRoot: HTMLElement;
  readonly chat: ChatModule;
  /** Tasks (BD-3b); `null` on hosts without it. */
  readonly tasks: TasksModule | null;
  /** `403 module_forbidden`: the Tasks tab is hidden, the token kept. */
  tasksForbidden = false;

  /**
   * The Tasks module is hidden: `403 module_forbidden`, or a server known not to offer tasks (0.14.1, Beacon before
   * 1.183). A module on screen when the server's "no" arrives (its "Connect tasks" answer) stays until the person leaves
   * it, so that answer can still be read there.
   */
  get tasksHidden(): boolean {
    if (this.tasksForbidden) return true;
    return this.tasks?.unavailable === true && !(this.module === 'tasks' && !this.setupShown && !this.tasksPanel.hidden);
  }
  /** Chat notifications (BD-3b): opt-in, level None, pause. */
  readonly notifier: ChatNotifier;
  /** A notification click to open once the chat (or the tasks) are ready (links wait in the host, BDA13-L1). */
  private pendingTarget: DeepLink | null = null;
  /** The modules started after the sign-in (links wait for it). */
  private ready = false;
  app: DesktopApp | null = null;
  prefs: ShellPrefs;
  module: ModuleId = 'chat';
  contexts: Context[] = [];
  context: string | null = null;
  unread = 0;
  unreadCapped = false;
  private readonly t: ChatText;
  private readonly titlebar: HTMLElement;
  /** The title bar's own content, rebuilt on every render (the window buttons stay, so they keep the focus). */
  private readonly titleMain: HTMLElement;
  /** Who draws the title bar (UX batch 7, UXA-45): until the host answers, the system (nothing changes). */
  chrome: ChromeMode = 'native';
  /** The update offer's panel, opened from the title bar's pill (UX batch 7, UXA-22). */
  private readonly updatePop: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly chatPanel: HTMLElement;
  private readonly timePanel: HTMLElement;
  private readonly tasksPanel: HTMLElement;
  private readonly tt: TasksText;
  private readonly live: HTMLElement;
  /** The one toast region with *Undo* (UX batch 4, UXA-8). */
  readonly toasts: ToastRegion;
  private readonly switcher: HTMLDialogElement;
  private readonly settings: HTMLDialogElement;
  /** The one Settings (UX batch 6). */
  private readonly settingsDialog: SettingsDialog;
  /** The guided first run (UX batch 6). */
  private readonly setup: SetupView;
  private readonly st: ShellText;
  private readonly keys: HTMLDialogElement;
  private readonly confirm: HTMLDialogElement;
  /** Required time fields (Q5, BD-3a). */
  readonly allocation: AllocationDialog;
  /** The mini timer window is open (Q2, BD-3a). */
  miniOpen = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private signedIn = false;
  private started = false;
  private lastBadge = -1;
  private switcherIndex = 0;
  private switcherItems: SwitchItem[] = [];

  constructor(
    private readonly mount: HTMLElement,
    private readonly platform: Platform,
    private readonly deps: ShellDeps,
  ) {
    this.t = chatText(deps.locale);
    this.st = shellText(deps.locale);
    this.prefs = loadShellPrefs(deps.storage);
    this.notifier = new ChatNotifier(deps.storage, () => this.now());
    this.timeRoot = h('div', { class: 'time-root', id: 'app', attrs: { 'aria-busy': 'true' } });
    this.titleMain = h('div', { class: 'tb-main' });
    this.titlebar = h('header', { class: 'titlebar', id: 'titlebar' }, this.titleMain);
    this.rail = h('nav', { class: 'rail', id: 'rail', attrs: { 'aria-label': this.t('modules') } });
    this.toasts = new ToastRegion({
      label: this.st('toasts'),
      undoLabel: this.st('toastUndo'),
      dismissLabel: this.st('toastClose'),
      undoHint: this.st('toastUndoHint', { shortcut: `${modKey()}+Z` }),
      shortcut: `${modKey()}+Z`,
      announce: (text) => this.announce(text),
    });
    const host = platform.chat;
    if (host === undefined) throw new Error('This host has no chat support.');
    this.chat = new ChatModule({
      t: this.t,
      locale: deps.locale,
      host,
      fetchImpl: platform.fetch,
      timeApi: () => this.app?.timeApi() ?? null,
      server: () => this.app?.state.session?.server ?? null,
      openVerification: (url) => void this.app?.openVerification(url),
      verificationLink: (url) => this.app?.verificationLink(url) ?? null,
      copyText: async (text) => {
        try {
          await this.platform.copyText(text);
          return true;
        } catch {
          return false;
        }
      },
      reconnectTime: () => void this.app?.reconnectTime(),
      copy: (text) => this.copy(text),
      announce: (text) => this.announce(text),
      onContexts: (contexts, current, remember) => {
        // Chat disconnected: the time API's contexts stay (BD-3a), the chat's empty list does not replace them.
        if (!this.chat.connected && contexts.length === 0 && this.app?.state.session) {
          this.contexts = [];
          this.context = null;
          this.timeContexts();
          this.renderChrome();
          return;
        }
        this.contexts = contexts;
        this.context = current;
        // ZBZ-v-I3: only a context the server served is remembered (not one shown after a network error).
        if (remember && current !== null && current !== this.prefs.context) {
          this.prefs.context = current;
          this.save();
        }
        // The time API follows the chosen organization (`X-Beacon-Context`, BD-3a); its tasks are reloaded. So does the
        // Tasks module (BD-3b).
        if (current !== null) this.followTimeContext(current);
        void this.tasks?.switchContext();
        this.renderChrome();
        this.refreshSwitcher();
      },
      onUnread: (total, capped) => {
        this.unread = total;
        this.unreadCapped = capped;
        this.renderRail();
        if (total !== this.lastBadge) {
          this.lastBadge = total;
          void host.setUnreadBadge(total).catch(() => undefined);
          void this.app?.updateTray();
        }
      },
      onConnection: (connected) => {
        if (!connected) this.notifier.reset();
        this.renderChrome();
        this.followSetup();
        void this.app?.updateTray();
      },
      onList: (rows, open) => this.onChatList(rows, open),
      notifyCard: () => this.notifyCard(),
      onConnectRender: () => this.followSetup(),
      sidebarTimer: () => this.sidebarTimer(),
      preferredContext: () => this.prefs.context,
      toasts: this.toasts,
      storage: deps.storage,
    });
    this.tt = tasksText(deps.locale);
    const tasksHost = platform.tasks;
    this.tasks =
      tasksHost === undefined
        ? null
        : new TasksModule({
            t: this.tt,
            chatT: this.t,
            locale: deps.locale,
            host: tasksHost,
            fetchImpl: platform.fetch,
            timeApi: () => this.app?.timeApi() ?? null,
            server: () => this.app?.state.session?.server ?? null,
            openVerification: (url) => void this.app?.openVerification(url),
            // Server links and links in task text (BDA13-I2): http(s) and mailto, the chat's checked opener; a link that
            // cannot be opened says so instead of doing nothing.
            openLink: (url) => void this.openContentLink(url),
            copy: (text) => this.copy(text),
            announce: (text) => this.announce(text),
            context: () => this.context,
            contextLabel: () => this.currentContext()?.context.label ?? this.t('moduleTasks'),
            onConnection: () => {
              this.renderRail();
              this.renderTitlebar();
              this.followSetup();
            },
            onConnectRender: () => this.followSetup(),
            onAvailability: () => {
              this.renderRail();
              this.renderTitlebar();
              this.followSetup();
              if (this.settings.open) this.renderSettings();
            },
            onForbidden: (hidden) => {
              this.tasksForbidden = hidden;
              if (hidden && this.module === 'tasks') this.show('chat', false);
              this.renderRail();
            },
            startTimer: async (task) => {
              await this.app?.start({ id: task.id, title: task.title, boardTitle: task.boardTitle, url: task.url });
            },
            stopTimer: async () => {
              await this.app?.stop();
            },
            runningTaskId: () => this.app?.state.activeTimer?.taskId ?? null,
            markers: () => this.prefs.markers,
            toasts: this.toasts,
            storage: deps.storage,
          });
    this.tasksPanel = h('section', { class: 'module', id: 'mod-tasks', attrs: { role: 'tabpanel', 'aria-labelledby': 'tab-tasks', hidden: true } }, this.tasks?.root ?? null);
    this.chatPanel = h('section', { class: 'module', id: 'mod-chat', attrs: { role: 'tabpanel', 'aria-labelledby': 'tab-chat' } }, this.chat.root);
    this.timePanel = h('section', { class: 'module', id: 'mod-time', attrs: { role: 'tabpanel', 'aria-labelledby': 'tab-time' } }, this.timeRoot);
    this.live = h('p', { class: 'sr-only', id: 'shell-live', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    this.switcher = this.buildSwitcher();
    this.settingsDialog = new SettingsDialog(this.settingsSource(), deps.storage);
    this.settings = this.settingsDialog.dialog;
    this.setup = new SetupView({
      t: this.st,
      chat: this.chat,
      tasks: this.tasks,
      tasksHidden: () => this.tasksHidden,
      tasksUnavailable: () => this.tasks?.unavailable === true && this.tasks.connected === false,
      skipped: () => this.prefs.skipped,
      signedIn: () => ({ name: this.app?.state.session?.displayName ?? this.app?.state.session?.identifier ?? '', org: this.currentContext()?.context.label ?? null }),
      skip: (step) => {
        if (!this.prefs.skipped.includes(step)) this.prefs.skipped = [...this.prefs.skipped, step];
        if (step === 'chat') this.chat.cancelConnect();
        else this.tasks?.cancelConnect();
        this.save();
        this.followSetup();
      },
      copy: (text) => void this.copy(text),
      openVerification: (url) => void this.app?.openVerification(url),
      finish: () => this.finishSetup(true),
      later: () => {
        this.chat.cancelConnect();
        this.tasks?.cancelConnect();
        this.finishSetup(false);
      },
    });
    this.keys = h('dialog', { class: 'sh-dialog', id: 'shell-keys', attrs: { 'aria-labelledby': 'shell-keys-title', closedby: 'any' } });
    this.confirm = h('dialog', { class: 'sh-dialog', id: 'shell-confirm', attrs: { 'aria-labelledby': 'shell-confirm-title' } });
    this.allocation = new AllocationDialog(this.t, (text) => this.announce(text), () => this.now());
    this.updatePop = this.buildUpdatePop();
    this.root = h('div', { class: 'shell', id: 'shell', attrs: { 'data-bare': 'true' } }, this.titlebar, h('div', { class: 'body' }, this.rail, this.chatPanel, this.tasksPanel, this.timePanel, this.setup.root), this.live, this.switcher, this.settings, this.keys, this.confirm, this.allocation.dialog, this.updatePop, this.toasts.root);
    platform.miniWindow?.onAction((action) => void this.onMiniAction(action));
    platform.onTray((action) => void this.onTrayAction(action));
    // BDA14-L3: the tray's *Quit* while messages wait to send (closing the window only hides it; *Quit* is the end).
    host.onQuitRequest?.(() => void this.quitRequested());
    platform.onNotificationAction((id) => {
      const target = parseChatClick(id);
      if (target !== null) void this.openTarget({ kind: 'chat', ...target }, 'notification');
    });
    // A ping (BDA13-L1): the link is taken from the host, once.
    platform.onDeepLink(() => void this.takeLink());
    // 0.14.1 (BDA13-L2): a tasks logout the previous run could not reach the server with is tried once more.
    void this.tasks?.retryParkedLogout();
    this.mount.replaceChildren(this.root);
    this.root.addEventListener('chat-switcher', () => this.openSwitcher());
    document.addEventListener('keydown', (event) => this.onKey(event));
    const visible = () => {
      this.chat.setShown(this.module === 'chat' && !document.hidden);
      this.tasks?.setShown(this.module === 'tasks' && !document.hidden);
    };
    globalThis.addEventListener?.('focus', visible);
    document.addEventListener('visibilitychange', visible);
    this.applyDensity();
    void this.initChrome();
  }

  // ---- window chrome and the update pill (UX batch 7) ---------------------------------------------------------------

  /**
   * Custom title bar (UXA-45): on Windows / Linux without a system frame the title bar is the drag region (double click
   * maximises, the OS snaps it) and draws its own window buttons; on macOS the traffic lights overlay its left end.
   */
  private async initChrome(): Promise<void> {
    const host = this.platform.chrome;
    const mode = host === undefined ? 'native' : await host.mode().catch(() => 'native' as const);
    this.chrome = mode;
    document.documentElement.dataset.chrome = mode;
    if (mode === 'native' || host === undefined) return;
    // `deep`: the whole bar drags, except its buttons and links (Tauri's drag script skips clickable elements).
    this.titlebar.setAttribute('data-tauri-drag-region', 'deep');
    if (mode === 'custom') this.titlebar.append(windowControls(host, hostOs(), this.t).root);
    this.renderTitlebar();
  }

  private buildUpdatePop(): HTMLElement {
    const pop = h('div', { class: 'update-pop', id: 'update-pop', attrs: { role: 'dialog', 'aria-labelledby': 'update-title', popover: 'auto', hidden: !supportsPopover() } });
    // The pill is the popover's invoker (`popovertarget`): the browser toggles it, light dismiss and Escape included.
    pop.addEventListener('beforetoggle', (event) => {
      if ((event as ToggleEvent).newState !== 'open') return;
      const app = this.app;
      if (app === null || !app.updateVisible() || this.root.dataset.bare === 'true') event.preventDefault();
      else patch(pop, [app.updatePanel()]);
    });
    pop.addEventListener('toggle', (event) => {
      if ((event as ToggleEvent).newState === 'closed') this.updatePopClosed();
      else {
        this.syncPill();
        this.focusUpdateAction();
      }
    });
    pop.addEventListener('keydown', (event) => {
      // Without the Popover API (tests), Escape closes it like a popover would.
      if (event.key === 'Escape' && !supportsPopover()) {
        event.preventDefault();
        this.closeUpdate();
      }
    });
    return pop;
  }

  /** Whether the update panel is open. */
  updateOpen(): boolean {
    return supportsPopover() ? this.updatePop.matches(':popover-open') : !this.updatePop.hidden;
  }

  /** Opens the update panel (the pill, or a manual "Check for updates…" that found one) and focuses its first action. */
  openUpdate(): void {
    const app = this.app;
    if (app === null || !app.updateVisible() || this.root.dataset.bare === 'true') return;
    patch(this.updatePop, [app.updatePanel()]);
    if (!this.updateOpen()) {
      if (supportsPopover()) this.updatePop.showPopover();
      else this.updatePop.hidden = false;
    }
    this.syncPill();
    this.focusUpdateAction();
  }

  private focusUpdateAction(): void {
    if (this.updatePop.contains(document.activeElement)) return;
    this.updatePop.querySelector<HTMLElement>('#update-now, #update-after-stop, #update-anyway')?.focus();
  }

  closeUpdate(): void {
    if (!this.updateOpen()) return;
    if (supportsPopover()) this.updatePop.hidePopover();
    else {
      this.updatePop.hidden = true;
      this.updatePopClosed();
    }
  }

  private updatePopClosed(): void {
    this.syncPill();
    // Focus goes back to the pill (or to the search when the offer is gone).
    const active = document.activeElement;
    if (active === null || active === document.body || this.updatePop.contains(active)) {
      (this.titlebar.querySelector<HTMLElement>('#tb-update') ?? this.titlebar.querySelector<HTMLElement>('#tb-search:not([hidden])'))?.focus();
    }
  }

  /** After a Time render: the panel follows the update's stage, and closes when there is nothing left to show. */
  private renderUpdate(): void {
    const app = this.app;
    if (app === null || !this.updateOpen()) return;
    if (!app.updateVisible() || this.root.dataset.bare === 'true') {
      this.closeUpdate();
      return;
    }
    patch(this.updatePop, [app.updatePanel()]);
  }

  private syncPill(): void {
    this.titlebar.querySelector('#tb-update')?.setAttribute('aria-expanded', this.updateOpen() ? 'true' : 'false');
  }

  /** The title bar's update pill (UXA-22): the offer, "after stop", then the download's progress. */
  private updatePill(): HTMLElement | null {
    const app = this.app;
    if (app === null || app.update === null || !app.updateVisible()) return null;
    const t = this.t;
    const version = app.update.version;
    const stage = app.updateStage;
    const percent = app.updatePercent();
    const [text, label] =
      stage === 'downloading'
        ? [percent === null ? t('updatePillDownloadingShort') : t('updatePillDownloading', { percent }), percent === null ? t('updatePillDownloadingShort') : t('updatePillDownloading', { percent })]
        : stage === 'installing'
          ? [t('updatePillInstalling'), t('updatePillInstalling')]
          : stage === 'after-stop'
            ? [t('updatePillAfterStop'), t('updatePillAfterStopLabel', { version })]
            : [t('updatePill'), t('updatePillLabel', { version })];
    const busy = stage === 'downloading' || stage === 'installing';
    const pill = h(
      'button',
      {
        class: 'tb-update',
        id: 'tb-update',
        attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-controls': 'update-pop', 'aria-expanded': this.updateOpen() ? 'true' : 'false', 'aria-label': label, title: label, 'data-stage': stage },
      },
      busy ? h('span', { class: 'tu-ring', attrs: { 'aria-hidden': 'true' } }) : chatIcon('down', 'sm'),
      h('span', { class: 'tu-text', attrs: { 'aria-hidden': 'true' } }, text),
    );
    if (supportsPopover()) pill.setAttribute('popovertarget', 'update-pop');
    else pill.addEventListener('click', () => (this.updateOpen() ? this.closeUpdate() : this.openUpdate()));
    return pill;
  }

  /** Attaches the Time module (its constructor needs `timeRoot`) and follows its renders. */
  attach(app: DesktopApp): void {
    this.app = app;
    // UX batch 6 (UXA-1, UXA-2): the Time module drops its own header and Settings; the shell's are the only ones.
    app.embed({ openSettings: (tab) => this.openSettings(tab as AnyTab | undefined), localKeys: [SHELL_KEY, SETUP_CHIP_KEY, TASKS_OFFER_KEY, CHAT_VIEW_KEY, NOTIFY_KEY, TASKS_VIEW_KEY] });
    // Before the first time API request: the organization used last (Personal on a first launch).
    app.setContext(this.prefs.context);
  }

  /** The fields dialog for the Time module (`AppDeps.askAllocation`). */
  askAllocation(request: AllocationRequest): Promise<Allocation | null> {
    for (const dialog of [this.switcher, this.settings, this.keys]) if (dialog.open) dialog.close();
    return this.allocation.ask(request);
  }

  /** Label of the current organization for the dialogs, `null` for Personal or unknown. */
  contextLabel(): string | null {
    const current = this.currentContext();
    return current === null || current.context.key === 'personal' ? null : current.context.label;
  }

  /**
   * The time API was refused the current context (`403 context_forbidden`): the chat leaves it too (Beacon's single
   * fallback to Personal), and the person is told.
   */
  async timeContextRefused(context: string): Promise<void> {
    const label = this.contexts.find((item) => item.key === context)?.label ?? context;
    if (this.chat.connected) await this.chat.refuseContext(context);
    else if (this.context === context) {
      this.context = 'personal';
      this.contexts = this.contexts.filter((item) => item.key !== context);
      this.renderChrome();
    }
    this.announce(this.t('contextRefusedTime', { name: label }));
    // Audit ZCD-L2: the task list still shows the refused organization's tasks: reload it in Personal.
    if (this.app?.state.session) void this.app.refresh();
  }

  /** Label of a known organization, `null` for Personal or unknown (a stop queued offline in another one). */
  contextLabelOf(context: string): string | null {
    if (context === 'personal') return null;
    return this.contexts.find((item) => item.key === context)?.label ?? null;
  }

  /**
   * Chat not connected: the time API's own contexts (`GET me`, TimeTrackBundle 2.2 with Beacon's policy) feed the
   * switcher. Returns whether anything changed.
   */
  private timeContexts(): boolean {
    const app = this.app;
    if (app === null || this.chat.connected || app.state.session === null) return false;
    const own = meContexts(app.me);
    if (own.contexts.length === 0) return false;
    const changed = own.contexts.length !== this.contexts.length || own.contexts.some((item, index) => item.key !== this.contexts[index]?.key);
    const current = own.contexts.some((item) => item.key === app.context) ? app.context : (own.context ?? own.contexts[0].key);
    if (!changed && current === this.context) return false;
    this.contexts = own.contexts;
    this.context = current;
    void this.tasks?.switchContext();
    this.renderRail();
    this.renderTitlebar();
    return true;
  }

  /** Sets the time API's context and reloads the Time module's tasks when it changed. */
  private followTimeContext(context: string): void {
    const app = this.app;
    if (app === null || app.context === context) return;
    app.setContext(context);
    if (app.state.session !== null) void app.refresh();
  }

  /** After every Time render: sign-in state, timer, theme. */
  onAppRender(): void {
    const app = this.app;
    if (app === null) return;
    const signedIn = app.state.session !== null && ['main', 'settings', 'privacy'].includes(app.view);
    if (signedIn && !this.signedIn) {
      this.signedIn = true;
      void this.enter();
    } else if (!signedIn && this.signedIn && app.state.session === null) {
      this.signedIn = false;
      this.started = false;
      this.hideSetup();
      this.settingsDialog.close();
      this.chat.signedOut();
      this.tasks?.signedOut();
      this.tasksForbidden = false;
      this.ready = false;
      // Nothing from before the sign-out opens after the next sign-in (BDA13-L1; the host forgets its link too).
      this.pendingTarget = null;
      this.notifier.reset();
      this.contexts = [];
      this.context = null;
      // Audit ZCD-L3: the next sign-in (maybe another account or server) starts in Personal. Written only when the
      // preferences are stored at all ("Clear local data" before a sign-out leaves nothing behind).
      this.prefs.context = null;
      if (this.deps.storage?.getItem(SHELL_KEY) !== null && this.deps.storage?.getItem(SHELL_KEY) !== undefined) this.save();
      // "Clear local data" removed them (UX batch 6): the next sign-in is a first run again.
      else this.prefs = loadShellPrefs(undefined);
      void this.platform.chat?.setUnreadBadge(0).catch(() => undefined);
    }
    this.root.dataset.bare = signedIn ? 'false' : 'true';
    if (!signedIn) this.show('time', false);
    if (signedIn) this.timeContexts();
    if (!signedIn && this.miniOpen) void this.closeMini();
    this.renderTitlebar();
    this.renderUpdate();
    this.syncTicker();
    this.pushMini();
    if (signedIn) this.renderSettings();
    // The running timer's task is marked in the Tasks views.
    const running = app.state.activeTimer?.taskId ?? null;
    if (this.tasks?.connected === true && running !== this.lastRunning) this.tasks.render();
    this.lastRunning = running;
  }

  private lastRunning: string | null = null;

  // ---- chat notifications, tray, links (BD-3b) ----------------------------------------------------------------------

  /** A new conversation list: notify (level None) when something new arrived elsewhere. */
  private onChatList(rows: Conversation[], open: string | null): void {
    // Another organization's list: what was seen there says nothing here (prime again, notify nothing old).
    if (this.chat.context !== this.notifyContext) {
      this.notifier.reset();
      this.notifyContext = this.chat.context;
    }
    const reading = this.module === 'chat' && !document.hidden && (document.hasFocus?.() ?? true);
    const target = this.notifier.observe(rows, { open, reading });
    if (target === null) return;
    const t = this.t;
    void this.platform.notifyFriendly({ title: t('notifyTitle'), body: t('notifyBody'), pose: null, click: chatClickTarget(this.chat.context, target) }).catch(() => false);
  }

  /** The opt-in card on the first Chat visit (design §3.4: a calm card, not an OS prompt at install). */
  private notifyCard(): HTMLElement | null {
    if (this.notifier.prefs.asked) return null;
    const t = this.t;
    const on = h('button', { class: 'btn sm primary', id: 'notify-on', attrs: { type: 'button' } }, t('notifyTurnOn'));
    on.addEventListener('click', () => void this.setNotifications(true));
    const later = h('button', { class: 'btn sm', id: 'notify-later', attrs: { type: 'button' } }, t('notifyNotNow'));
    later.addEventListener('click', () => {
      this.notifier.dismiss();
      this.chat.renderAsk();
    });
    return h(
      'section',
      { class: 'notif-ask', attrs: { 'aria-labelledby': 'notify-ask-title' } },
      h('span', { class: 'na-ico', attrs: { 'aria-hidden': 'true' } }, chatIcon('bell')),
      h('div', {}, h('h3', { id: 'notify-ask-title' }, t('notifyAskTitle')), h('p', {}, t('notifyAskText')), h('div', { class: 'row' }, on, later)),
    );
  }

  /** Turns chat notifications on (asking the OS for permission first) or off. */
  async setNotifications(enabled: boolean): Promise<void> {
    let permission = enabled ? await this.platform.notificationPermission().catch(() => 'unsupported' as const) : 'granted';
    if (enabled && permission === 'prompt') permission = await this.platform.requestNotificationPermission().catch(() => 'denied' as const);
    this.notifier.setEnabled(enabled);
    this.notifyDenied = enabled && permission !== 'granted';
    if (enabled) this.announce(this.t('notifyOnAnnounce'));
    this.chat.renderAsk();
    if (this.settings.open) this.renderSettings();
    void this.app?.updateTray();
  }

  /** The context the notifier last saw a list of. */
  private notifyContext: string | null = null;

  /** The OS refused notifications when they were turned on (Settings says so). */
  private notifyDenied = false;

  pauseNotifications(until: number | null): void {
    if (until === null) this.notifier.resume();
    else this.notifier.pause(until);
    if (this.settings.open) this.renderSettings();
    void this.app?.updateTray();
  }

  /** The tray's chat items (AppDeps.trayChat): "Open chat", pause / resume chat notifications. */
  /** The tray's tasks items (AppDeps.trayTasks, UXA-41): "Quick add task…" while tasks are connected. */
  trayTasks(): { id: string; label: string }[] {
    if (this.tasks === null || !this.tasks.connected || this.tasksHidden) return [];
    return [{ id: 'quick-add-task', label: this.t('trayQuickAdd') }];
  }

  trayChat(): { id: string; label: string }[] {
    if (!this.chat.connected) return [];
    const t = this.t;
    const items = [{ id: 'open-chat', label: this.unread > 0 ? t('trayOpenChatUnread', { count: this.badgeText() }) : t('trayOpenChat') }];
    if (this.notifier.prefs.enabled) {
      items.push(this.notifier.paused() ? { id: 'resume-chat', label: t('trayResumeChat', { time: this.clockTime(this.notifier.prefs.pausedUntil as number) }) } : { id: 'pause-chat', label: t('trayPauseChat') });
    }
    return items;
  }

  private clockTime(at: number): string {
    return new Intl.DateTimeFormat(this.deps.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  }

  private async onTrayAction(action: string): Promise<void> {
    if (action === 'open-chat') this.show('chat');
    else if (action === 'quick-add-task' && this.tasks !== null && !this.tasksHidden) {
      // The host showed the window: Tasks, quick add focused (the connect card when tasks are not connected).
      this.show('tasks');
      this.tasks.focusQuickAdd();
    }
    else if (action === 'pause-chat') this.pauseNotifications(this.now() + PAUSE_HOUR_MS);
    else if (action === 'resume-chat') this.pauseNotifications(null);
  }

  /** Takes the host's link (BDA13-L1): before the modules are ready it stays there, and `enter()` takes it. */
  private async takeLink(): Promise<void> {
    if (!this.ready) return;
    const link = await this.platform.takeDeepLink().catch(() => null);
    if (link !== null) await this.openTarget(link, 'link');
  }

  /** A link from task text or a server page: the chat's opener (http(s), mailto); a failure is said (BDA13-I2). */
  private async openContentLink(url: string): Promise<void> {
    const opener = this.platform.chat;
    try {
      if (opener === undefined) await this.platform.openExternal(url);
      else await opener.openLink(url);
    } catch {
      // Visible in the Tasks banner when the link was in a task (and announced), else announced.
      if (this.tasks !== null && this.module === 'tasks') this.tasks.notify(this.t('linkOpenFailed'));
      else this.announce(this.t('linkOpenFailed'));
    }
  }

  /**
   * Opens a conversation or a task from a `beacon-desktop://` link or a notification click: only navigation. A context
   * in the link is switched to through the normal flow (a running timer is asked about); an id the person may not see
   * is simply not found (the API answers 404). A link never switches the organization silently (BDA13-I1): without a
   * running timer (whose stop question already asks) the person confirms the switch first. A notification click goes
   * back to the organization it was notified in (BDA13-L3), through the same switch.
   */
  async openTarget(link: DeepLink, source: 'link' | 'notification' = 'link'): Promise<void> {
    if (!this.ready) {
      this.pendingTarget = link;
      return;
    }
    if (link.context !== null && link.context !== this.context && this.contexts.some((item) => item.key === link.context)) {
      const timerRuns = (this.app?.state.activeTimer ?? null) !== null;
      if (source === 'link' && !timerRuns && !(await this.askLinkSwitch(link))) {
        this.announce(this.t('linkSwitchDeclined', { org: this.currentContext()?.context.label ?? '' }));
        return;
      }
      await this.switchContext(link.context);
      if (this.context !== link.context) return;
    }
    if (link.kind === 'chat') {
      this.show('chat');
      if (!this.chat.connected) return;
      const found = this.chat.allConversations().some((row) => row.uuid === link.id);
      if (found) await this.chat.open(link.id);
      else this.announce(this.t('linkNotFound'));
      return;
    }
    if (this.tasks === null || this.tasksHidden) return;
    this.show('tasks');
    if (!this.tasks.connected) {
      this.announce(this.t('linkTasksOff'));
      return;
    }
    await this.tasks.openTask(link.id);
  }

  /**
   * Before a sign-out (AppDeps.beforeSignOut): the chat and tasks tokens are revoked on the server, both at once, best
   * effort (ZBZ-L4, BDA13-L2); the sign-out goes on whatever they answer.
   */
  async revokeOnServer(): Promise<void> {
    await Promise.all([this.chat.revokeOnServer().catch(() => undefined), this.tasks?.revokeOnServer()]);
  }

  /** *Clear local data* (BDA141-L2), after `revokeOnServer`: parked tasks logouts are tried now and not kept. */
  async clearParked(): Promise<void> {
    await this.tasks?.clearParkedLogout();
  }

  /** Signed in (at start-up or after the sign-in): landing module, then chat. */
  private async enter(): Promise<void> {
    const app = this.app;
    if (app === null || this.started) return;
    this.started = true;
    // Landing rule (owner Q1): Chat on the first launch, then the last module, Time while a timer runs. A first sign-in
    // (or a setup the app quit in the middle of) opens the guided setup instead (UX batch 6, UXA-4), which ends on Chat.
    const timer = app.state.activeTimer !== null;
    const setup = (this.freshSignIn && this.prefs.setup === null) || (this.prefs.setup === 'pending' && !timer);
    // 0.14.1: a server known not to offer tasks has no Tasks tab from the first frame (remembered per server); whether
    // it offers them now is asked once per start, in the background, and the rail and the setup card follow the answer.
    this.show(setup ? 'chat' : landingModule(this.prefs, timer, this.tasksHidden), false);
    void this.tasks?.discover();
    await this.chat.init(this.prefs.context);
    await this.tasks?.init();
    this.renderChrome();
    if (setup && this.app?.state.session !== null) this.startSetup();
    // A `beacon-desktop://` link the app was started with.
    this.ready = true;
    // The modules know their connections now: the "Finish setup" chip may show (never before, so it never flickers).
    this.renderTitlebar();
    const pending = this.pendingTarget;
    this.pendingTarget = null;
    const link = await this.platform.takeDeepLink().catch(() => null);
    if (link !== null) await this.openTarget(link, 'link');
    else if (pending !== null) await this.openTarget(pending, 'notification');
  }

  /**
   * Set by main.ts when the session came from a sign-in in this run (not a launch with a stored session): a first one
   * opens the guided setup (UX batch 6).
   */
  freshSignIn = false;

  show(module: ModuleId, remember = true): void {
    if (this.setupShown) {
      // Another module picked from the rail (or a link): the setup is left for later (Settings → Account).
      this.hideSetup();
      this.prefs.setup = 'done';
      this.save();
    }
    this.module = module;
    this.chatPanel.hidden = module !== 'chat';
    this.tasksPanel.hidden = module !== 'tasks';
    this.timePanel.hidden = module !== 'time';
    this.root.dataset.module = module;
    if (remember && this.signedIn) {
      this.prefs.module = module;
      this.save();
    }
    this.chat.setShown(module === 'chat' && !document.hidden);
    this.tasks?.setShown(module === 'tasks' && !document.hidden);
    this.renderRail();
    this.renderTitlebar();
  }

  /** The module tabs shown, in the prototype's order (Chat, Tasks, Time); `Ctrl/Cmd+1..3` follow it. */
  private moduleOrder(): ModuleId[] {
    return this.tasks !== null && !this.tasksHidden ? ['chat', 'tasks', 'time'] : ['chat', 'time'];
  }

  private save(): void {
    try {
      this.deps.storage?.setItem(SHELL_KEY, JSON.stringify(this.prefs));
    } catch {
      // Storage unavailable.
    }
  }

  private announce(text: string): void {
    this.live.textContent = '';
    setTimeout(() => (this.live.textContent = text), 30);
  }

  private async copy(text: string): Promise<void> {
    try {
      await this.platform.copyText(text);
      this.announce(this.t('copied'));
    } catch {
      // No clipboard.
    }
  }

  private applyDensity(): void {
    this.root.dataset.density = this.prefs.density;
    this.root.dataset.timer = this.prefs.timer;
    this.root.dataset.switcher = this.prefs.switcher;
  }

  // ---- chrome -------------------------------------------------------------------------------------------------------

  renderChrome(): void {
    this.applyDensity();
    this.renderTitlebar();
    this.renderRail();
    this.chat.render();
    if (this.tasks?.connected === true) this.tasks.renderBody();
    else this.tasks?.render();
    this.pushMini();
  }

  private currentContext(): { context: Context; index: number } | null {
    const index = this.contexts.findIndex((item) => item.key === this.context);
    return index < 0 ? null : { context: this.contexts[index], index };
  }

  private renderTitlebar(): void {
    const t = this.t;
    const current = this.currentContext();
    const brand = h('div', { class: 'brand' }, h('span', { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } }, chatIcon('beacon')), h('span', {}, t('appName')));
    const left = h('div', { class: 'tb-left' }, brand);
    // Signed out with our own chrome (UX batch 7): a bare bar, the brand and the window buttons only (drag, close).
    if (this.root?.dataset.bare === 'true') {
      this.titleMain.replaceChildren(left);
      document.title = t('appName');
      return;
    }
    // The bar is rebuilt on every render: the focused tool keeps the focus.
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && this.titleMain.contains(active) && active.id !== '' ? active.id : null;
    const chip = this.setupChip('setup-chip');
    this.railSetup.replaceChildren(...(chip !== null ? [this.setupChip('setup-chip-rail') as HTMLElement] : []));
    if (current !== null) {
      const badge = contextBadge(current.context, current.index);
      if (this.prefs.switcher === 'dropdown' && this.contexts.length > 1) {
        const button = h(
          'button',
          { class: 'tb-ctx-btn', id: 'ctx-dropdown', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-label': `${t('contextMenu')}: ${current.context.label}` } },
          h('span', { class: 'ctx-dot', attrs: { style: `background:${badge.color}`, 'aria-hidden': 'true' } }),
          h('span', {}, current.context.label),
          chatIcon('chev', 'xs'),
        );
        button.addEventListener('click', () => {
          const rect = button.getBoundingClientRect();
          showMenu(
            rect.left,
            rect.bottom + 4,
            this.contexts.map((item) => [item.key === this.context ? `✓ ${item.label}` : `   ${item.label}`, () => void this.switchContext(item.key)] as [string, () => void]),
            button,
          );
        });
        left.append(button);
      } else {
        left.append(h('div', { class: 'tb-ctx', attrs: { 'aria-label': t('contextCurrent', { name: current.context.label }) } }, h('span', { class: 'ctx-dot', attrs: { style: `background:${badge.color}`, 'aria-hidden': 'true' } }), h('b', {}, current.context.label)));
      }
    }
    if (chip !== null) left.append(chip);
    const search = h('button', { class: 'tb-search', id: 'tb-search', attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-keyshortcuts': 'Control+K Meta+K' } }, chatIcon('search', 'sm'), h('span', {}, t('searchJump')), h('kbd', {}, `${modKey()} K`));
    search.addEventListener('click', () => this.openSwitcher());
    const right = h('div', { class: 'tb-right' }, this.updatePill(), this.timerPill());
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (document.documentElement.getAttribute('data-theme') === null && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
    const theme = this.iconButton('tb-btn', dark ? 'sun' : 'moon', dark ? t('themeLight') : t('themeDark'), () => void this.setTheme(dark ? 'light' : 'dark'), 'tb-theme');
    const help = this.iconButton('tb-btn', 'keyboard', t('shortcuts'), () => this.openKeys(), 'tb-help');
    if (this.platform.miniWindow !== null) {
      const mini = this.iconButton('tb-btn', 'pip', this.miniOpen ? t('miniClose') : t('miniOpen'), () => void this.toggleMini(), 'tb-mini');
      mini.setAttribute('aria-pressed', this.miniOpen ? 'true' : 'false');
      mini.setAttribute('aria-keyshortcuts', 'Control+Shift+M Meta+Shift+M');
      right.append(mini);
    }
    right.append(theme, help);
    this.titleMain.replaceChildren(left, h('div', { class: 'tb-mid' }, search), right);
    if (focused !== null) this.titleMain.querySelector<HTMLElement>(`[id="${focused}"]`)?.focus();
    document.title = current !== null ? `${current.context.label} · ${t('appName')}` : t('appName');
  }

  /**
   * What the guided first run left to do (0.14.1): Chat not connected, or Tasks not connected where the server offers
   * them and they are not turned off. Time is the sign-in itself, so it is always connected here.
   */
  setupPending(): 'chat' | 'tasks' | null {
    if (!this.chat.connected) return 'chat';
    if (this.tasks !== null && !this.tasks.connected && !this.tasksHidden && !this.tasks.unavailable) return 'tasks';
    return null;
  }

  /** The key a dismissed chip is remembered under: the server and the organization. */
  private setupChipKey(): string | null {
    const server = this.app?.state.session?.server ?? null;
    if (server === null) return null;
    try {
      return `${new URL(server).origin}|${this.context ?? 'personal'}`;
    } catch {
      return null;
    }
  }

  private setupChipsDismissed(): string[] {
    try {
      const raw = JSON.parse(this.deps.storage?.getItem(SETUP_CHIP_KEY) ?? '[]') as unknown;
      return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').slice(-50) : [];
    } catch {
      return [];
    }
  }

  /**
   * "Finish setup" in the title bar (0.14.1, owner approval 2026-11-28): while something is left to connect, the setup
   * card is not on screen and the modules have started. It opens the setup at the pending step; × hides it for this
   * server and organization (remembered); it goes by itself once everything is connected.
   */
  private setupChip(id: string): HTMLElement | null {
    const st = this.st;
    const pending = this.ready && !this.setupShown && this.app?.state.session !== null ? this.setupPending() : null;
    const key = this.setupChipKey();
    if (pending === null || key === null || this.setupChipsDismissed().includes(key)) return null;
    const hint = st(pending === 'chat' ? 'setupChipChat' : 'setupChipTasks');
    const open = h('button', { class: 'tb-setup-go', id, attrs: { type: 'button', title: hint, 'aria-describedby': `${id}-hint` } }, h('span', { class: 'tb-setup-dot', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'tb-setup-label' }, st('setupChip')));
    open.addEventListener('click', () => {
      this.prefs.skipped = [];
      this.startSetup();
    });
    const dismiss = h('button', { class: 'tb-setup-x', id: `${id}-dismiss`, attrs: { type: 'button', 'aria-label': st('setupChipDismiss'), title: st('setupChipDismiss') } }, chatIcon('x', 'xs'));
    dismiss.addEventListener('click', () => {
      try {
        this.deps.storage?.setItem(SETUP_CHIP_KEY, JSON.stringify([...this.setupChipsDismissed(), key]));
      } catch {
        // Storage unavailable: hidden for this run only.
      }
      this.renderTitlebar();
      this.announce(st('setupChipHidden'));
      (id === 'setup-chip' ? this.titleMain.querySelector<HTMLElement>('#tb-search') : this.rail.querySelector<HTMLElement>('#rail-settings'))?.focus();
    });
    return h('div', { class: 'tb-setup', attrs: { role: 'group', 'aria-label': st('setupChip') } }, open, h('span', { class: 'sr-only', id: `${id}-hint` }, hint), dismiss);
  }

  private iconButton(className: string, name: ChatIconName, label: string, onClick: () => void, id?: string): HTMLButtonElement {
    const button = h('button', { class: className, id, attrs: { type: 'button', 'aria-label': label, title: label } }, chatIcon(name));
    button.addEventListener('click', onClick);
    return button;
  }

  private timerPill(): HTMLElement {
    const t = this.t;
    const timer = this.app?.state.activeTimer ?? null;
    const pill = h('div', { class: `timer-pill${timer !== null ? ' running' : ''}`, id: 'timer-pill', attrs: { role: 'group', 'aria-label': t('moduleTime') } });
    if (timer === null) {
      const idle = h('button', { class: 'tp-main', attrs: { type: 'button' } }, chatIcon('clock', 'sm'), h('span', { class: 'tp-idle' }, t('timerNone')));
      idle.addEventListener('click', () => this.show('time'));
      pill.append(idle);
      return pill;
    }
    const time = elapsed(timer.startedAt, this.now());
    const main = h(
      'button',
      { class: 'tp-main', attrs: { type: 'button', title: t('timerOpen', { task: timer.taskTitle, time }) } },
      h('span', { class: 'tp-dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'tp-task' }, timer.taskTitle),
      h('span', { class: 'tp-time', attrs: { 'aria-hidden': 'true' } }, time),
    );
    main.addEventListener('click', () => this.show('time'));
    const stop = this.iconButton('tp-act stop', 'stop', t('timerStop'), () => void this.app?.stop());
    pill.append(main, stop);
    return pill;
  }

  /** "Title bar + sidebar" (Q2): the running timer also at the chat sidebar's foot. */
  private sidebarTimer(): HTMLElement | null {
    if (this.prefs.timer !== 'title-sidebar') return null;
    const timer = this.app?.state.activeTimer ?? null;
    if (timer === null) return null;
    const card = h('div', { class: 'side-timer', id: 'side-timer' }, h('span', { class: 'tp-dot', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'st-task' }, timer.taskTitle), h('span', { class: 'st-time' }, elapsed(timer.startedAt, this.now())));
    const stop = this.iconButton('tp-act stop', 'stop', this.t('timerStop'), () => void this.app?.stop());
    card.append(stop);
    return card;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private syncTicker(): void {
    const running = this.app?.state.activeTimer !== null && this.app?.state.activeTimer !== undefined;
    if (running && this.ticker === null) {
      this.ticker = setInterval(() => {
        const time = this.titlebar.querySelector('.tp-time');
        const timer = this.app?.state.activeTimer;
        if (time !== null && timer !== null && timer !== undefined) time.textContent = elapsed(timer.startedAt, this.now());
        const side = this.root.querySelector('#side-timer .st-time');
        if (side !== null && timer !== null && timer !== undefined) side.textContent = elapsed(timer.startedAt, this.now());
      }, 1000);
    } else if (!running && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private renderRail(): void {
    const t = this.t;
    const nodes: Node[] = [];
    if (this.prefs.switcher === 'tiles' && this.contexts.length > 1) {
      const tiles = h('div', { class: 'ctx-tiles', attrs: { role: 'group', 'aria-label': t('contexts') } });
      this.contexts.forEach((context, index) => {
        const badge = contextBadge(context, index);
        const current = context.key === this.context;
        const tile = h(
          'button',
          { class: 'ctx-tile', attrs: { type: 'button', style: `background:${badge.color}`, 'aria-current': current ? 'true' : 'false', title: context.label, 'data-context': context.key } },
          h('span', { attrs: { 'aria-hidden': 'true' } }, badge.tile),
          h('span', { class: 'sr-only' }, context.label),
        );
        tile.addEventListener('click', () => void this.switchContext(context.key));
        tiles.append(tile);
      });
      nodes.push(tiles, h('div', { class: 'rail-sep', attrs: { 'aria-hidden': 'true' } }));
    }
    const tabs = h('div', { class: 'rail-tabs', attrs: { role: 'tablist', 'aria-label': t('modules'), 'aria-orientation': 'vertical' } });
    const all: Record<ModuleId, [ModuleId, ChatIconName, string, string]> = {
      chat: ['chat', 'chat', t('moduleChat'), this.unread > 0 ? t('moduleChatUnread', { count: this.badgeText() }) : t('moduleChat')],
      tasks: ['tasks', 'tasks', t('moduleTasks'), t('moduleTasks')],
      time: ['time', 'clock', t('moduleTime'), this.app?.state.activeTimer ? t('moduleTimeRunning') : t('moduleTime')],
    };
    const specs = this.moduleOrder().map((id) => all[id]);
    specs.forEach(([id, icon, label, aria], index) => {
      const selected = !this.setupShown && this.module === id;
      const tab = h(
        'button',
        {
          class: 'rail-tab',
          id: `tab-${id}`,
          attrs: { type: 'button', role: 'tab', 'aria-selected': selected ? 'true' : 'false', 'aria-controls': `mod-${id}`, tabindex: selected || (this.setupShown && index === 0) ? '0' : '-1', title: `${label} (${modKey()}+${index + 1})`, 'aria-keyshortcuts': `Control+${index + 1}` },
        },
        h('span', { class: 'rt-ico' }, chatIcon(icon)),
        h('span', { class: 'rt-label' }, label),
        aria !== label ? h('span', { class: 'sr-only' }, aria.slice(label.length)) : null,
      );
      if (id === 'chat' && this.unread > 0) tab.append(h('span', { class: 'badge', attrs: { 'aria-hidden': 'true' } }, this.badgeText()));
      if (id === 'time' && this.app?.state.activeTimer) tab.append(h('span', { class: 'live', attrs: { 'aria-hidden': 'true' } }));
      tab.addEventListener('click', () => this.show(id));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const next = specs[(index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : specs.length - 1)) % specs.length][0];
        this.show(next);
        this.rail.querySelector<HTMLElement>(`#tab-${next}`)?.focus();
      });
      tabs.append(tab);
    });
    nodes.push(tabs, h('div', { class: 'rail-spacer' }));
    // The compact window has no room in its title bar: "Finish setup" sits in the bottom rail there (CSS picks one).
    nodes.push(this.railSetup);
    nodes.push(this.iconButton('rail-tab rail-settings', 'gear', t('settings'), () => this.openSettings(), 'rail-settings'));
    const focused = document.activeElement instanceof HTMLElement && this.rail.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset.context : null;
    this.rail.replaceChildren(...nodes);
    if (focused) this.rail.querySelector<HTMLElement>(`[id="${focused}"], [data-context="${focused}"]`)?.focus();
  }

  private badgeText(): string {
    return this.unreadCapped ? '200+' : this.unread > 99 ? '99+' : String(this.unread);
  }

  // ---- context switch -----------------------------------------------------------------------------------------------

  /** Owner Q4: a timer never keeps running in another organization. Stop it (asked first) or stay. */
  async switchContext(key: string): Promise<void> {
    if (key === this.context || !this.contexts.some((item) => item.key === key)) return;
    const app = this.app;
    // Time recorded offline is replayed in the organization it was recorded in: switch only once it is sent.
    if (app !== null && (app.pendingSync > 0 || app.offline)) {
      if (app.pendingSync > 0 && !app.offline) await app.refresh();
      if (app.pendingSync > 0 || app.offline) {
        // ZCD-v-I2: online with a blocked queue (a 409 waiting for a field) is not "offline".
        this.announce(this.t(app.offline ? 'contextOffline' : 'contextQueued'));
        return;
      }
    }
    // BDA14-L3: the chat's offline queue does not follow to another organization; ask before it goes.
    if (!(await this.askUnsent('unsentSwitch'))) return;
    const timer = app?.state.activeTimer ?? null;
    if (app !== null && timer !== null) {
      const target = this.contexts.find((item) => item.key === key)?.label ?? key;
      const where = { org: this.currentContext()?.context.label ?? null, target };
      // Required fields missing: one dialog asks for them and confirms the switch; otherwise the plain question.
      const missing = app.stopMissing();
      if (!missing.activityType && !missing.subject) {
        const confirmed = await this.askStopAndSwitch(key);
        if (!confirmed) return;
      }
      const outcome = await app.stop(where);
      if (outcome === 'cancelled') return;
      // Audit ZCD-M1: a stop only queued (the network dropped) is sent from here first; no switch before it is.
      if (outcome === 'queued' || app.pendingSync > 0) {
        this.announce(this.t(app.offline ? 'contextOffline' : 'contextQueued'));
        return;
      }
      if (app.state.activeTimer !== null) {
        this.announce(this.t('stopFailed'));
        return;
      }
    }
    const label = this.contexts.find((item) => item.key === key)?.label ?? key;
    if (this.chat.connected) {
      // Remembered by `onContexts` only once the server served it (a refused context is never kept); the time API
      // follows there too.
      await this.chat.switchContext(key);
    } else if (app !== null) {
      // Time only: the time API's contexts. Remembered once the server served it (audit ZCD-I4, as ZBZ-v-I3).
      this.context = key;
      app.setContext(key);
      this.renderChrome();
      await app.refresh();
      if (app.context === key && app.error === null) {
        this.prefs.context = key;
        this.save();
      }
      void this.tasks?.switchContext();
    }
    if (this.context === key) this.announce(this.t('contextSwitched', { name: label }));
    this.renderChrome();
    this.refreshSwitcher();
  }

  /**
   * BDA14-L1: an open quick switcher follows an organization switch (a link or a notification can switch while it is
   * open): its results are built again for the new organization, the typed text kept.
   */
  private refreshSwitcher(): void {
    if (this.switcher.open) this.renderSwitcher();
  }

  /**
   * BDA14-L3: before something drops the chat's offline queue (an organization switch, sign-out, *Quit*), ask: Cancel is
   * the default. Nothing waiting: `true` at once.
   */
  private async askUnsent(action: 'unsentSwitch' | 'unsentSignOut' | 'unsentQuit'): Promise<boolean> {
    const count = this.chat.unsentCount();
    if (count === 0) return true;
    const st = this.st;
    return this.askDestructive(st('unsentTitle', { count }), st('unsentText', { count }), st(action, { count }));
  }

  /** The tray's *Quit* with messages waiting (BDA14-L3): asked in the main window, which Rust has shown. */
  private async quitRequested(): Promise<void> {
    if (!(await this.askUnsent('unsentQuit'))) return;
    await this.platform.chat?.quit?.();
  }

  /** A link wants another organization (BDA13-I1): the same confirm dialog as the timer's switch question. */
  private askLinkSwitch(link: DeepLink): Promise<boolean> {
    const t = this.t;
    const org = this.currentContext()?.context.label ?? '';
    const target = this.contexts.find((item) => item.key === link.context)?.label ?? link.context ?? '';
    const what = t(link.kind === 'chat' ? 'linkSwitchWhatChat' : 'linkSwitchWhatTask');
    return this.askConfirm(t('linkSwitchTitle', { target }), t('linkSwitchText', { what, target, org }), [t('linkSwitch')], 'confirm-link-switch');
  }

  private askStopAndSwitch(key: string): Promise<boolean> {
    const t = this.t;
    const timer = this.app?.state.activeTimer;
    const org = this.currentContext()?.context.label ?? '';
    const target = this.contexts.find((item) => item.key === key)?.label ?? key;
    const text = t('stopAndSwitchText', { task: timer?.taskTitle ?? '', time: timer ? elapsed(timer.startedAt, this.now()) : '', org, target });
    return this.askConfirm(t('stopAndSwitchTitle', { org }), text, [chatIcon('stop', 'sm'), t('stopAndSwitch')], 'confirm-stop-switch');
  }

  /** The confirm dialog (Cancel focused first): resolves `true` only for the primary button. */
  private askConfirm(title: string, text: string, label: Child[], goId: string): Promise<boolean> {
    const t = this.t;
    // One question at a time: a second one (another link while the first is asked) is a "no".
    if (this.confirm.open) return Promise.resolve(false);
    return new Promise((resolve) => {
      const cancel = h('button', { class: 'btn', id: 'confirm-cancel', attrs: { type: 'button', autofocus: true } }, t('cancel'));
      const go = h('button', { class: 'btn primary', id: goId, attrs: { type: 'button' } }, ...label);
      this.confirm.replaceChildren(h('div', { class: 'dlg' }, h('div', { class: 'dlg-h' }, h('h1', { id: 'shell-confirm-title' }, title)), h('div', { class: 'dlg-b' }, h('p', {}, text)), h('div', { class: 'dlg-f' }, cancel, go)));
      let answer = false;
      const done = () => {
        this.confirm.removeEventListener('close', done);
        resolve(answer);
      };
      this.confirm.addEventListener('close', done);
      cancel.addEventListener('click', () => this.confirm.close());
      go.addEventListener('click', () => {
        answer = true;
        this.confirm.close();
      });
      this.confirm.showModal();
      cancel.focus();
    });
  }

  // ---- quick switcher (Cmd+K) ---------------------------------------------------------------------------------------

  private buildSwitcher(): HTMLDialogElement {
    const t = this.t;
    const input = h('input', { id: 'sw-input', attrs: { type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'sw-list', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('switcherLabel') } });
    const list = h('div', { class: 'sw-list', id: 'sw-list', attrs: { role: 'listbox', 'aria-label': this.st('switcherResults') } });
    const dialog = h(
      'dialog',
      { class: 'sh-dialog', id: 'switcher', attrs: { 'aria-label': t('switcherLabel'), closedby: 'any' } },
      h(
        'div',
        { class: 'dlg sw' },
        h('div', { class: 'sw-in' }, chatIcon('search', 'lg'), input),
        list,
        h('div', { class: 'sw-foot' }, h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ` ${t('switcherMove')}`), h('span', {}, h('kbd', {}, 'Enter'), ` ${t('switcherOpen')}`), h('span', {}, h('kbd', {}, 'Esc'), ` ${t('switcherClose')}`)),
      ),
    );
    input.addEventListener('input', () => {
      this.switcherIndex = 0;
      this.renderSwitcher();
    });
    input.addEventListener('keydown', (event) => {
      const count = this.switcherItems.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (count > 0) this.switcherIndex = (this.switcherIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
        this.renderSwitcherSelection();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.runSwitcher();
      }
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    return dialog;
  }

  /** The global quick switcher (UX batch 3, UXA-3): conversations, boards and tasks, Time's timer actions and views. */
  openSwitcher(): void {
    if (this.root.dataset.bare === 'true') return;
    for (const dialog of [this.settings, this.keys]) if (dialog.open) dialog.close();
    const input = this.switcher.querySelector<HTMLInputElement>('#sw-input');
    if (input === null) return;
    input.value = '';
    input.placeholder = this.st('switcherPlaceholderAll');
    this.switcherIndex = 0;
    this.renderSwitcher();
    if (!this.switcher.open) this.switcher.showModal();
    input.focus();
  }

  /** Every module's candidates for `query` (only what is connected and shown). */
  private switchGroups(query: string): SwitchGroup[] {
    const t = this.t;
    const st = this.st;
    const groups: SwitchGroup[] = [];
    if (this.chat.connected) {
      const now = this.now();
      const items = rankConversations(this.chat.allConversations(), this.chat.recent, query).map((row): SwitchItem => {
        const section = sectionOf(row);
        const kind = row.kind === 'direct' ? t('kindDirect') : section === 'projects' ? t('kindProject') : row.kind === 'support' ? t('kindSupport') : t('kindChannel');
        return {
          key: `c-${row.uuid}`,
          module: 'chat',
          label: row.title,
          meta: row.unread > 0 ? t('switcherUnread', { count: row.unread }) : this.chat.recent.includes(row.uuid) ? t('switcherRecent') : kind,
          extra: kind,
          icon: row.kind === 'direct' ? 'users' : row.kind === 'support' ? 'headset' : section === 'projects' ? 'folder' : 'hash',
          unread: row.unread,
          strong: row.unread > 0 && !isMuted(row, now),
          run: () => {
            this.show('chat');
            void this.chat.open(row.uuid);
          },
        };
      });
      groups.push({ module: 'chat', items: scoreItems(query, items) });
    }
    const tasks = this.tasks;
    if (tasks !== null && tasks.connected && !this.tasksHidden) {
      const { boards, tasks: cards } = tasks.switchTargets();
      const boardItems = boards.map((board): SwitchItem => ({
        key: `b-${board.id}`,
        module: 'tasks',
        label: board.title,
        meta: st('switchBoard'),
        extra: board.group?.label,
        icon: 'folder',
        run: () => {
          this.show('tasks');
          tasks.jumpToBoard(board.id);
        },
      }));
      const taskItems = cards.map((card): SwitchItem => {
        const board = boards.find((item) => item.id === card.boardId)?.title;
        return {
          key: `t-${card.id}`,
          module: 'tasks',
          label: card.title,
          meta: board !== undefined ? `${taskRef(card)} · ${board}` : taskRef(card),
          extra: `${taskRef(card)} ${board ?? ''}`,
          icon: 'tasks',
          run: () => {
            this.show('tasks');
            void tasks.openTask(card.id);
          },
        };
      });
      // No query: a few boards, then the tasks (My tasks first), then the other boards.
      groups.push({ module: 'tasks', items: scoreItems(query, [...boardItems.slice(0, 3), ...taskItems, ...boardItems.slice(3)]) });
    }
    const app = this.app;
    if (app !== null && app.state.session !== null) {
      const timer = app.state.activeTimer;
      const items: SwitchItem[] = [];
      if (timer !== null) {
        items.push({ key: 'time-stop', module: 'time', label: st('switchStopLabel'), meta: timer.taskTitle, extra: `${timer.taskTitle} ${st('switchStop')}`, icon: 'stop', run: () => void app.stop() });
      }
      const seen = new Set<string>(timer !== null ? [timer.taskId] : []);
      const verb = timer !== null ? st('switchSwitch') : st('switchStart');
      // BDA14-L1: only tasks of the current organization (the list may still hold the previous one's until it reloads).
      for (const task of [...app.quickTasks(), ...(query.trim() === '' ? [] : app.tasks)]) {
        if (seen.has(task.id) || !app.inCurrentContext(task.id)) continue;
        seen.add(task.id);
        items.push({ key: `s-${task.id}`, module: 'time', label: task.title, meta: verb, extra: `${verb} ${task.boardTitle ?? task.projectTitle ?? ''}`, icon: 'play', run: () => void app.start(task) });
      }
      if (app.fullLayout()) {
        const view = (key: 'quick' | 'time', label: string): SwitchItem => ({
          key: `v-${key}`,
          module: 'time',
          label,
          meta: st('switchTimeView'),
          extra: st('switchTimeView'),
          icon: 'clock',
          run: () => {
            this.show('time');
            app.showSection(key);
          },
        });
        items.push(view('time', app.t('myTime')), view('quick', app.t('pinnedRecent')));
      }
      groups.push({ module: 'time', items: scoreItems(query, items) });
    }
    return groups;
  }

  private renderSwitcher(): void {
    const t = this.t;
    const input = this.switcher.querySelector<HTMLInputElement>('#sw-input');
    const list = this.switcher.querySelector<HTMLElement>('#sw-list');
    if (input === null || list === null) return;
    this.switcherItems = mergeSwitch(this.switchGroups(input.value), this.module, input.value);
    this.switcherIndex = Math.min(this.switcherIndex, Math.max(0, this.switcherItems.length - 1));
    if (this.switcherItems.length === 0) {
      list.replaceChildren(h('div', { class: 'sw-empty' }, t('switcherEmpty')));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    list.replaceChildren(
      ...this.switcherItems.map((item, index) => {
        const option = h(
          'div',
          { class: `opt${item.strong === true ? ' unread' : ''}`, id: `sw-${index}`, attrs: { role: 'option', 'aria-selected': index === this.switcherIndex ? 'true' : 'false', 'data-switch': item.key, 'data-module': item.module } },
          h('span', { class: 'o-ico' }, chatIcon(item.icon, 'sm')),
          h('span', { class: 'o-t' }, item.label),
          item.unread !== undefined && item.unread > 0 ? h('span', { class: 'badge', attrs: { 'aria-hidden': 'true' } }, String(item.unread)) : null,
          h('span', { class: 'o-m' }, item.meta),
        );
        option.addEventListener('click', () => {
          this.switcherIndex = index;
          this.runSwitcher();
        });
        option.addEventListener('mousemove', () => {
          if (this.switcherIndex !== index) {
            this.switcherIndex = index;
            this.renderSwitcherSelection();
          }
        });
        return option;
      }),
    );
    input.setAttribute('aria-activedescendant', `sw-${this.switcherIndex}`);
  }

  private renderSwitcherSelection(): void {
    this.switcher.querySelectorAll('.opt').forEach((option, index) => option.setAttribute('aria-selected', index === this.switcherIndex ? 'true' : 'false'));
    this.switcher.querySelector('#sw-input')?.setAttribute('aria-activedescendant', `sw-${this.switcherIndex}`);
    this.switcher.querySelector(`#sw-${this.switcherIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }

  private runSwitcher(): void {
    const item = this.switcherItems[this.switcherIndex];
    if (item === undefined) return;
    this.switcher.close();
    item.run();
  }

  // ---- settings and the shortcut sheet ------------------------------------------------------------------------------

  async setTheme(theme: ThemePreference): Promise<void> {
    await this.app?.setTheme(theme);
    this.renderTitlebar();
    if (this.settings.open) this.renderSettings();
  }

  /** The one Settings (UXA-2): the rail's gear, Ctrl/⌘+, in every module, the tray, the Time module's own links. */
  openSettings(tab?: AnyTab): void {
    for (const dialog of [this.switcher, this.keys]) if (dialog.open) dialog.close();
    this.app?.prepareSettings();
    this.settingsDialog.show(tab);
  }

  private segmented<T extends string>(label: string, options: [T, string][], value: T, onPick: (value: T) => void): HTMLElement {
    const group = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': label } });
    options.forEach(([id, text], index) => {
      const checked = id === value;
      const button = h('button', { attrs: { type: 'button', role: 'radio', 'aria-checked': checked ? 'true' : 'false', tabindex: checked ? '0' : '-1', 'data-value': id } }, text);
      button.addEventListener('click', () => onPick(id));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const next = options[(index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length][0];
        onPick(next);
        this.settings.querySelector<HTMLElement>(`[aria-label="${label}"] [data-value="${next}"]`)?.focus();
      });
      group.append(button);
    });
    return group;
  }

  private settingRow(title: string, hint: string | null, control: HTMLElement | null): HTMLElement {
    return h('div', { class: 'set-row' }, h('div', { class: 's-l' }, h('div', { class: 's-t' }, title), hint !== null ? h('div', { class: 's-d' }, hint) : null), control);
  }

  private renderSettings(): void {
    this.settingsDialog.render();
  }

  /** What the one Settings shows in each tab (the Time module's panels, then the shell's rows). */
  private settingsSource(): SettingsSource {
    return {
      hasTasks: () => this.tasks !== null,
      label: (tab) => {
        if (isTimeTab(tab)) return this.app?.settingsTabLabel(tab) ?? tab;
        return this.st(tab === 'appearance' ? 'tabAppearance' : tab === 'chat' ? 'tabChat' : tab === 'tasks' ? 'tabTasks' : 'tabAccount');
      },
      content: (tab) => this.settingsContent(tab),
      title: () => this.st('settingsTitle'),
      sectionsLabel: () => this.st('settingsSections'),
      closeLabel: () => this.t('close'),
    };
  }

  private updatePrefs(patch: Partial<ShellPrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    this.save();
    this.renderChrome();
    this.renderSettings();
  }

  private settingsContent(tab: AnyTab): Child[] {
    const app = this.app;
    if (tab === 'appearance') return [this.appearanceSettings()];
    if (tab === 'chat') return [this.chatSettings()];
    if (tab === 'tasks') return [this.tasksSettings()];
    if (tab === 'account') return [this.accountSettings()];
    if (app === null || app.state.session === null) return [];
    if (tab === 'timer') return [this.timeSettings(), ...app.settingsContent(tab)];
    return app.settingsContent(tab);
  }

  private appearanceSettings(): HTMLElement {
    const t = this.t;
    const mini = this.miniSetting();
    return h(
      'div',
      { class: 'set-stack' },
      this.app?.themeSetting() ?? null,
      h(
        'div',
        { class: 'set-group' },
        this.settingRow(t('density'), t('densityHint'), this.segmented(t('density'), [['comfortable', t('densityComfortable')], ['compact', t('densityCompact')]], this.prefs.density, (density) => this.updatePrefs({ density }))),
        this.settingRow(t('switcherStyle'), t('switcherStyleHint'), this.segmented(t('switcherStyle'), [['tiles', t('switcherTiles')], ['dropdown', t('switcherDropdown')]], this.prefs.switcher, (switcher) => this.updatePrefs({ switcher }))),
        this.settingRow(t('timerPlacement'), t('timerPlacementHint'), this.segmented(t('timerPlacement'), [['title', t('timerTitle')], ['title-sidebar', t('timerTitleSidebar')]], this.prefs.timer, (timer) => this.updatePrefs({ timer }))),
        mini,
      ),
    );
  }

  /** The mini timer window (Q2, BD-3a), next to the timer placement it goes with. */
  private miniSetting(): HTMLElement | null {
    if (this.platform.miniWindow === null) return null;
    const t = this.t;
    const mini = h('button', { class: 'btn sm', id: 'settings-mini', attrs: { type: 'button', 'aria-pressed': this.miniOpen ? 'true' : 'false' } }, chatIcon('pip', 'sm'), this.miniOpen ? t('miniClose') : t('miniOpen'));
    mini.addEventListener('click', () => void this.toggleMini().then(() => this.renderSettings()));
    return this.settingRow(t('miniTimer'), t('miniTimerHint'), mini);
  }

  /** Time tracking rows of the shell (BD-3a: required fields), at the top of the Timer tab. */
  private timeSettings(): HTMLElement {
    const t = this.t;
    const settings = this.app?.state.settings;
    const time = h('div', { class: 'set-group', id: 'settings-time-tracking' }, h('h3', {}, t('settingsTime')));
    if (settings !== undefined) {
      time.append(
        this.settingRow(t('askOn'), t('askOnHint'), this.segmented<AskOn>(t('askOn'), [['stop', t('askOnStop')], ['start', t('askOnStart')], ['both', t('askOnBoth')]], settings.askOn, (askOn) => {
          this.app?.setAllocationSetting({ askOn });
          this.renderSettings();
        })),
        this.settingRow(t('inheritActivity'), t('inheritActivityHint'), this.segmented<'on' | 'off'>(t('inheritActivity'), [['on', t('inheritOn')], ['off', t('inheritOff')]], settings.inheritActivity ? 'on' : 'off', (value) => {
          this.app?.setAllocationSetting({ inheritActivity: value === 'on' });
          this.renderSettings();
        })),
      );
    }
    return time;
  }

  private chatSettings(): HTMLElement {
    const t = this.t;
    const st = this.st;
    const connection = h('div', { class: 'set-group' }, h('h3', {}, t('settingsChat')));
    if (this.chat.connected) {
      const manage = h('button', { class: 'btn sm', id: 'settings-chat-manage', attrs: { type: 'button' } }, st('manage'));
      manage.addEventListener('click', () => this.openSettings('account'));
      // UXA-14: the connection detail the sidebar no longer shows while healthy ("Checking for new messages every 30 s").
      const status = this.chat.connectionStatus();
      const row = this.settingRow(t('chatConnection'), status.text, manage);
      row.id = 'settings-chat-status';
      row.querySelector('.s-t')?.append(' ', h('span', { class: `conn-state${status.tone === 'ok' ? ' on' : ''}`, attrs: { title: status.text } }, h('span', { class: `conn-dot ${status.tone}`, attrs: { 'aria-hidden': 'true' } }), st(status.tone === 'ok' ? 'connOn' : 'connTrouble')));
      connection.append(row);
      // Notifications (BD-3b): opt-in, level None, pause.
      const prefs = this.notifier.prefs;
      connection.append(
        this.settingRow(
          t('settingsNotifications'),
          this.notifyDenied ? t('notifyDenied') : t('notificationsHint'),
          this.segmented<'on' | 'off'>(t('settingsNotifications'), [['off', t('notifyOff')], ['on', t('notifyOn')]], prefs.enabled ? 'on' : 'off', (value) => void this.setNotifications(value === 'on')),
        ),
      );
      if (prefs.enabled) {
        connection.append(this.settingRow(t('notifyPreview'), null, h('p', { class: 's-d notify-level', id: 'notify-level' }, t('notifyPreviewHidden'))));
        const pause = h('div', { class: 'cc-row' });
        if (this.notifier.paused()) {
          const resume = h('button', { class: 'btn sm', id: 'notify-resume', attrs: { type: 'button' } }, t('notifyResume'));
          resume.addEventListener('click', () => this.pauseNotifications(null));
          pause.append(resume);
        } else {
          const hour = h('button', { class: 'btn sm', id: 'notify-pause-hour', attrs: { type: 'button' } }, t('notifyPause1h'));
          hour.addEventListener('click', () => this.pauseNotifications(this.now() + PAUSE_HOUR_MS));
          const tomorrow = h('button', { class: 'btn sm', id: 'notify-pause-tomorrow', attrs: { type: 'button' } }, t('notifyPauseTomorrow'));
          tomorrow.addEventListener('click', () => this.pauseNotifications(tomorrowMorning(this.now())));
          pause.append(hour, tomorrow);
        }
        connection.append(this.settingRow(t('notifyPause'), this.notifier.paused() ? t('notifyPausedUntil', { time: this.clockTime(this.notifier.prefs.pausedUntil as number) }) : t('notifyNotPaused'), pause));
      }
    } else {
      connection.append(this.settingRow(t('chatConnection'), t('chatNotConnected'), this.connectButton('chat', 'settings-chat-connect', t('connectButton'))));
    }
    return connection;
  }

  private tasksSettings(): HTMLElement | null {
    const tasks = this.tasks;
    if (tasks === null) return null;
    const tt = this.tt;
    const group = h('div', { class: 'set-group' }, h('h3', {}, tt('settingsTasks')));
    if (tasks.connected) {
      const manage = h('button', { class: 'btn sm', id: 'settings-tasks-manage', attrs: { type: 'button' } }, this.st('manage'));
      manage.addEventListener('click', () => this.openSettings('account'));
      group.append(this.settingRow(tt('tasksConnection'), this.tasksForbidden ? this.st('connTasksHidden') : this.st('connOn'), manage));
    } else if (tasks.unavailable) {
      // 0.14.1: this server has no tasks yet (Beacon before 1.183): said once, nothing to press.
      group.append(this.settingRow(tt('tasksConnection'), this.st('connTasksUnavailable'), null));
    } else {
      group.append(this.settingRow(tt('tasksConnection'), tt('tasksNotConnected'), this.connectButton('tasks', 'settings-tasks-connect', tt('connectButton'))));
    }
    group.append(this.settingRow(tt('markers'), tt('markersHint'), this.segmented<Markers>(tt('markers'), [['emoji', tt('markersEmoji')], ['dots', tt('markersDots')]], this.prefs.markers, (markers) => this.updatePrefs({ markers }))));
    return group;
  }

  /** "Connect" from Settings: closes it and starts the module's device flow in its own module. */
  private connectButton(module: 'chat' | 'tasks', id: string, label = this.st('connect')): HTMLButtonElement {
    const button = h('button', { class: 'btn sm primary', id, attrs: { type: 'button' } }, label);
    button.addEventListener('click', () => {
      this.settingsDialog.close();
      this.show(module);
      if (module === 'chat') void this.chat.connectChat();
      else void this.tasks?.connectTasks();
    });
    return button;
  }

  /** Account (UXA-2): who is signed in, the three connections (Disconnect asks first, UXA-8), Sign out. */
  private accountSettings(): HTMLElement {
    const st = this.st;
    const session = this.app?.state.session ?? null;
    const name = session?.displayName ?? session?.identifier ?? '';
    const host = hostOf(session?.server ?? null);
    const status = (on: boolean) => h('span', { class: `conn-state${on ? ' on' : ''}` }, h('span', { class: 'conn-dot', attrs: { 'aria-hidden': 'true' } }), on ? st('connOn') : st('connOff'));
    const row = (id: string, title: string, hint: string, on: boolean, action: HTMLElement | null) =>
      h('div', { class: 'set-row conn-row', id }, h('div', { class: 's-l' }, h('div', { class: 's-t' }, title, ' ', status(on)), h('div', { class: 's-d' }, hint)), action);
    const chatAction = this.chat.connected ? this.disconnectButton('chat') : this.connectButton('chat', 'account-chat-connect');
    const tasks = this.tasks;
    const connections = h(
      'div',
      { class: 'set-group' },
      h('h3', {}, st('connections')),
      row('account-time', st('connTime'), st('connTimeHint'), session !== null, null),
      row('account-chat', st('connChat'), st('connChatHint'), this.chat.connected, chatAction),
      tasks === null
        ? null
        : !tasks.connected && tasks.unavailable
          ? row('account-tasks', st('connTasks'), st('connTasksUnavailable'), false, null)
          : row('account-tasks', st('connTasks'), this.tasksForbidden ? st('connTasksHidden') : st('connTasksHint'), tasks.connected, tasks.connected ? this.disconnectButton('tasks') : this.connectButton('tasks', 'account-tasks-connect')),
    );
    const privacy = h('button', { class: 'btn sm', id: 'open-privacy', attrs: { type: 'button' } }, st('whatWeCollect'));
    privacy.addEventListener('click', () => {
      this.settingsDialog.close();
      this.show('time');
      this.app?.show('privacy');
    });
    const logout = h('button', { class: 'btn sm danger', id: 'logout', attrs: { type: 'button' } }, st('signOut'));
    logout.addEventListener('click', () => {
      void (async () => {
        // BDA14-L3: messages waiting to send are dropped with the sign-out: asked first.
        if (!(await this.askUnsent('unsentSignOut'))) return;
        this.settingsDialog.close();
        await this.app?.logout();
      })();
    });
    const setup = this.setup.needed() ? h('button', { class: 'btn sm primary', id: 'account-finish-setup', attrs: { type: 'button' } }, st('finishSetup')) : null;
    setup?.addEventListener('click', () => {
      this.settingsDialog.close();
      this.prefs.skipped = [];
      this.startSetup();
    });
    return h(
      'div',
      { class: 'set-stack' },
      h(
        'div',
        { class: 'set-group' },
        this.settingRow(st('accountSignedIn', { name }), host !== '' ? st('accountServer', { host }) : null, null),
        setup !== null ? this.settingRow(st('finishSetup'), st('finishSetupHint'), setup) : null,
      ),
      connections,
      h('div', { class: 'cc-row account-actions' }, privacy, logout),
    );
  }

  private disconnectButton(module: 'chat' | 'tasks'): HTMLButtonElement {
    const st = this.st;
    const button = h('button', { class: 'btn sm danger', id: `${module}-disconnect`, attrs: { type: 'button' } }, st('disconnect'));
    button.addEventListener('click', () => void this.disconnectModule(module));
    return button;
  }

  /** Disconnect chat / tasks, after a confirmation (UXA-8); time stays signed in. */
  async disconnectModule(module: 'chat' | 'tasks'): Promise<void> {
    const st = this.st;
    // BDA14-L3: one question also names the messages still waiting to send (they go with the chat).
    const unsent = module === 'chat' ? this.chat.unsentCount() : 0;
    const text = st(module === 'chat' ? 'confirmChatText' : 'confirmTasksText');
    const ok = await this.askDestructive(st(module === 'chat' ? 'confirmChatTitle' : 'confirmTasksTitle'), unsent > 0 ? `${st('unsentTitle', { count: unsent })} ${text}` : text, st('confirmDisconnect'));
    if (!ok) return;
    if (module === 'chat') await this.chat.disconnect();
    else await this.tasks?.disconnect();
    this.announce(st(module === 'chat' ? 'chatDisconnected' : 'tasksDisconnected'));
    this.renderSettings();
    this.settings.querySelector<HTMLElement>(`#account-${module}-connect`)?.focus();
  }

  /** A destructive question: Cancel is the default (focused first, Esc), the action is named and styled as danger. */
  private askDestructive(title: string, text: string, action: string): Promise<boolean> {
    // One question at a time, as in askConfirm: a second one while the first is asked is a "no".
    if (this.confirm.open) return Promise.resolve(false);
    return new Promise((resolve) => {
      const cancel = h('button', { class: 'btn', id: 'confirm-cancel', attrs: { type: 'button', autofocus: true } }, this.st('cancel'));
      const go = h('button', { class: 'btn primary danger-fill', id: 'confirm-ok', attrs: { type: 'button' } }, action);
      this.confirm.replaceChildren(h('div', { class: 'dlg' }, h('div', { class: 'dlg-h' }, h('h1', { id: 'shell-confirm-title' }, title)), h('div', { class: 'dlg-b' }, h('p', {}, text)), h('div', { class: 'dlg-f' }, cancel, go)));
      let answer = false;
      const done = () => {
        this.confirm.removeEventListener('close', done);
        resolve(answer);
      };
      this.confirm.addEventListener('close', done);
      cancel.addEventListener('click', () => this.confirm.close());
      go.addEventListener('click', () => {
        answer = true;
        this.confirm.close();
      });
      this.confirm.showModal();
      cancel.focus();
    });
  }

  // ---- guided first run (UXA-4) -------------------------------------------------------------------------------------

  /** The setup card on screen (the modules are hidden behind it; the rail stays usable). */
  setupShown = false;

  private startSetup(): void {
    if (!this.setup.needed()) {
      this.finishSetup(false);
      return;
    }
    this.setupShown = true;
    this.prefs.setup = 'pending';
    this.save();
    this.module = 'chat';
    this.chatPanel.hidden = true;
    this.tasksPanel.hidden = true;
    this.timePanel.hidden = true;
    this.setup.root.hidden = false;
    this.root.dataset.setup = 'true';
    this.chat.setShown(false);
    this.tasks?.setShown(false);
    this.setupActive = this.setup.active();
    this.setup.render();
    this.renderRail();
    this.renderTitlebar();
    this.setup.focus();
  }

  private hideSetup(): void {
    this.setupShown = false;
    this.setup.root.hidden = true;
    delete this.root.dataset.setup;
  }

  /** Nothing left (or "Finish later"): the setup is over; the app lands on Chat (owner Q1). */
  private finishSetup(announce: boolean): void {
    const shown = this.setupShown;
    this.hideSetup();
    this.prefs.setup = 'done';
    this.save();
    if (shown) {
      this.show('chat');
      if (announce) this.announce(this.st('setupFinished'));
      this.chatPanel.querySelector<HTMLElement>('#chat-connect, .side .conv, .chat-main')?.focus?.();
    }
  }

  /** A module's connection or its device-flow state changed: the setup card follows, and moves on when done. */
  private followSetup(): void {
    if (!this.setupShown) return;
    if (!this.setup.needed()) {
      this.finishSetup(true);
      return;
    }
    const before = document.activeElement;
    const active = this.setup.active();
    // 0.14.1 (owner approval 2026-11-28): the Chat approval just came through, so the Tasks code is asked for at once,
    // no extra click (only where the server offers tasks: else the step is not there). Skip and "Later" still work.
    const chained = this.setupActive === 'chat' && active === 'tasks' && this.chat.connected && this.tasks !== null && this.tasks.connect.kind === 'idle' && this.tasks.connect.message === null;
    this.setupActive = active;
    this.setup.render();
    if (before === null || before === document.body || !this.setup.root.contains(document.activeElement)) this.setup.focus();
    if (chained) void this.tasks?.connectTasks();
  }

  /** The rail's place for "Finish setup" (the compact window, 0.14.1). */
  private readonly railSetup: HTMLElement = h('div', { class: 'rail-setup' });

  /** The setup step that was active when the card was last drawn (the Chat → Tasks chain, 0.14.1). */
  private setupActive: string | null = null;

  /** The shortcut sheet (`?`, UX batch 3): what works anywhere, then the keys of the module in view, and only those. */
  openKeys(): void {
    const t = this.t;
    const st = this.st;
    const mod = modKey();
    const anywhere: [string, string[]][] = [
      [t('keySwitcher'), [mod, 'K']],
      [t('keyModules'), [mod, this.moduleOrder().length === 3 ? '1 2 3' : '1 2']],
      [st('keyPanes'), ['F6', 'Shift F6']],
      [t('keySettings'), [mod, ',']],
      [t('keyTheme'), [mod, 'Shift', 'L']],
      [t('keyToggleTimer'), [mod, 'Shift', 'S']],
      [st('keyUndo'), [mod, 'Z']],
      ...(this.platform.miniWindow !== null ? [[t('keyMini'), [mod, 'Shift', 'M']] as [string, string[]]] : []),
      [t('keySheet'), ['?']],
    ];
    const sections: [string, [string, string[]][]][] = [[t('keysAnywhere'), anywhere]];
    if (this.module === 'chat') {
      sections.push([
        t('keysChat'),
        [
          [t('keyConv'), ['Alt', '↑ ↓']],
          [t('keyUnread'), ['Alt', 'Shift', '↑ ↓']],
          [t('keyJumpUnread'), [mod, 'J']],
          [t('keyHistory'), [mod, '[ ]']],
          [st('keySideRows'), ['↑ ↓']],
          [t('keyMessages'), ['↑ ↓']],
          [t('keyThread'), ['Enter']],
          [t('keyReply'), ['R']],
          [t('keyReact'), ['E']],
          [t('keyComposer'), ['C']],
          [t('keySend'), ['Enter', 'Shift Enter']],
          [t('keyLeave'), ['Esc']],
        ],
      ]);
    } else if (this.module === 'tasks' && this.tasks !== null && !this.tasksHidden) {
      const tt = this.tt;
      sections.push([
        tt('keysTasks'),
        [
          [tt('keyQuickAdd'), ['N']],
          [tt('keyBoard'), ['Alt', '↑ ↓']],
          [tt('keyOpenCard'), ['Enter']],
          [tt('keyCardNav'), ['← → ↑ ↓']],
          [tt('keyMoveCard'), ['Alt', '← →']],
          [tt('keyRows'), ['↑ ↓']],
          [tt('keyRowCells'), ['← →']],
          [tt('keyStartTimer'), ['S']],
          [tt('keyCloseDetail'), ['Esc']],
        ],
      ]);
    } else if (this.module === 'time') {
      const full = this.app?.fullLayout() === true;
      sections.push([
        st('keysTime'),
        [
          [st('keyTimeSearch'), ['/']],
          [st('keyTimeRows'), ['↑ ↓']],
          [st('keyTimeStart'), ['Enter', 'S']],
          [st('keyTimeQuick'), ['Alt', '1…9']],
          ...(full ? [[st('keyTimeSection'), ['Alt', '↑ ↓']] as [string, string[]]] : []),
        ],
      ]);
    }
    const close = this.iconButton('x-btn', 'x', t('close'), () => this.keys.close(), 'keys-close');
    // Scrollable when the window is short: focusable, so the keyboard can scroll it (axe scrollable-region-focusable).
    const body = h('div', { class: 'keys', attrs: { tabindex: '0', role: 'region', 'aria-label': t('keysTitle') } });
    for (const [title, rows] of sections) {
      body.append(h('h2', {}, title));
      for (const [label, combo] of rows) body.append(h('div', { class: 'k' }, h('span', {}, label), h('span', {}, ...combo.map((key) => h('kbd', {}, key)))));
    }
    this.keys.replaceChildren(h('div', { class: 'dlg' }, h('div', { class: 'dlg-h' }, h('h1', { id: 'shell-keys-title' }, t('keysTitle')), close), body));
    if (!this.keys.open) this.keys.showModal();
    close.focus();
  }

  // ---- mini timer (Q2, BD-3a) ---------------------------------------------------------------------------------------

  /** What the mini timer shows (translated here; the window has no strings of its own). */
  miniView(): MiniView {
    const t = this.t;
    const app = this.app;
    const timer = app?.state.activeTimer ?? null;
    const last = timer === null ? (app?.lastTask() ?? null) : null;
    const org = this.contextLabel();
    const dark = document.documentElement.getAttribute('data-theme');
    return {
      theme: dark === 'dark' || dark === 'light' ? dark : 'system',
      lang: document.documentElement.lang || 'en',
      windowTitle: t('miniTimer'),
      running: timer !== null,
      task: timer?.taskTitle ?? last?.title ?? null,
      startedAt: timer?.startedAt ?? null,
      status: timer !== null ? (org !== null ? t('miniTracking', { org }) : t('miniTrackingPersonal')) : t('miniNotTracking'),
      canStart: timer === null && last !== null,
      busy: app?.busy === true,
      labels: {
        stop: t('miniStop'),
        start: t('miniStart'),
        startTask: t('miniStartTask', { task: last?.title ?? '' }),
        expand: t('miniExpand'),
        close: t('miniClose'),
        noTask: t('miniNoTask'),
        elapsed: t('miniElapsed', { time: '' }).trim(),
      },
    };
  }

  private lastMini = '';

  /** Sends the view to an open mini timer when it changed (renders are frequent; the window ticks by itself). */
  private pushMini(): void {
    const host = this.platform.miniWindow;
    if (host === null || !this.miniOpen) return;
    const view = this.miniView();
    const key = JSON.stringify(view);
    if (key === this.lastMini) return;
    this.lastMini = key;
    void host.update(view).catch(() => undefined);
  }

  async toggleMini(): Promise<void> {
    if (this.miniOpen) return this.closeMini();
    const host = this.platform.miniWindow;
    if (host === null || this.root.dataset.bare === 'true') return;
    const view = this.miniView();
    try {
      await host.open(view);
      this.miniOpen = true;
      this.lastMini = JSON.stringify(view);
    } catch {
      this.miniOpen = false;
    }
    this.renderTitlebar();
  }

  async closeMini(): Promise<void> {
    this.miniOpen = false;
    this.lastMini = '';
    await this.platform.miniWindow?.close().catch(() => undefined);
    this.renderTitlebar();
  }

  /** A button of the mini timer. The decisions (fields dialog, offline queue) stay here, in the main window. */
  private async onMiniAction(action: MiniAction): Promise<void> {
    const app = this.app;
    if (action === 'closed' || action === 'close') {
      if (action === 'close') await this.platform.miniWindow?.close().catch(() => undefined);
      this.miniOpen = false;
      this.lastMini = '';
      this.renderTitlebar();
      return;
    }
    if (action === 'expand') {
      await this.platform.windowHost.bringForward?.().catch(() => undefined);
      this.show('time');
      return;
    }
    if (app === null || app.busy) return;
    if (action === 'stop' && app.state.activeTimer !== null) await app.stop();
    else if (action === 'start' && app.state.activeTimer === null) await app.resume();
    this.pushMini();
  }

  // ---- keys ---------------------------------------------------------------------------------------------------------

  /**
   * Keys (UX batch 3, UXA-3 / UXA-10, owner approval "global shortcuts in every module"). The app-wide ones are handled
   * here first, the same in Chat, Tasks and Time, and marked handled (the Time module then leaves them alone):
   * Ctrl/⌘+K the global switcher, Ctrl/⌘+1…3 the modules, F6 / Shift+F6 the window's areas, Ctrl/⌘+, Settings,
   * Ctrl/⌘+Shift+L light / dark (its one meaning), Ctrl/⌘+Shift+S the timer, Ctrl/⌘+Shift+M the mini timer, `?` the
   * sheet. Then Alt+↑ / Alt+↓ and the module's own keys go to the module in view.
   */
  private onKey(event: KeyboardEvent): void {
    // A shell no longer in the page (tests mount several) never takes a key; a key already handled is not ours either.
    if (!this.root.isConnected || this.root.dataset.bare === 'true' || event.defaultPrevented) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const dialogOpen = [this.switcher, this.settings, this.keys, this.confirm, this.allocation.dialog].some((dialog) => dialog.open);
    const target = event.target as HTMLElement | null;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable === true;
    const handled = (run: () => void) => {
      event.preventDefault();
      run();
    };
    if (mod && !event.shiftKey && !event.altKey && key === 'k') {
      // Toggles from anywhere, even a text field; not over another dialog.
      if (dialogOpen && !this.switcher.open) return;
      return handled(() => (this.switcher.open ? this.switcher.close() : this.openSwitcher()));
    }
    if (dialogOpen) return;
    if (mod && event.shiftKey && !event.altKey && key === 'm' && this.platform.miniWindow !== null) return handled(() => void this.toggleMini());
    const order = this.moduleOrder();
    if (mod && !event.shiftKey && !event.altKey && /^[1-3]$/.test(event.key) && Number(event.key) <= order.length) {
      return handled(() => {
        const next: ModuleId = order[Number(event.key) - 1];
        this.show(next);
        this.rail.querySelector<HTMLElement>(`#tab-${next}`)?.focus();
      });
    }
    if (mod && event.shiftKey && !event.altKey && key === 'l') {
      return handled(() => {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        void this.setTheme(dark ? 'light' : 'dark');
      });
    }
    if (mod && event.shiftKey && !event.altKey && key === 's' && this.app !== null && this.app.state.session !== null) return handled(() => void this.app?.toggle());
    if (mod && !event.shiftKey && !event.altKey && event.key === ',') return handled(() => this.openSettings());
    if (event.key === 'F6' && !mod && !event.altKey) return handled(() => this.cyclePanes(event.shiftKey ? -1 : 1));
    if (!typing && !mod && !event.altKey && event.key === '?') return handled(() => this.openKeys());
    if (this.module === 'tasks') {
      if ((!typing || (event.key === 'Escape' && this.tasks?.detail !== null)) && this.tasks?.onKey(event) === true) event.preventDefault();
      return;
    }
    if (this.module === 'time') {
      if (!typing && event.altKey && !mod && !event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && this.app?.stepSection(event.key === 'ArrowDown' ? 1 : -1) === true) event.preventDefault();
      return;
    }
    if (!typing && this.chat.onKey(event)) event.preventDefault();
  }

  /**
   * The window's areas for F6 / Shift+F6, in visual order: title bar, rail, then the module's panes (Chat: sidebar,
   * conversation, thread; Tasks: page, task panel; Time: sidebar, list, details). From outside any area, F6 starts at the
   * module's first pane (the person is "in" the module), Shift+F6 at its last.
   */
  private areas(): HTMLElement[] {
    const panes = this.setupShown
      ? [this.setup.root]
      : this.module === 'chat'
        ? this.chat.panes()
        : this.module === 'tasks'
          ? (this.tasks?.panes() ?? [])
          : this.app !== null && this.app.state.session !== null
            ? this.app.panes()
            : [this.timePanel];
    return [this.titlebar, this.rail, ...panes.filter((pane) => pane.closest('[hidden]') === null)];
  }

  cyclePanes(step: 1 | -1): void {
    const areas = this.areas();
    const at = areas.findIndex((area) => area.contains(document.activeElement));
    const next = at === -1 ? areas[step === 1 ? Math.min(2, areas.length - 1) : areas.length - 1] : areas[(at + step + areas.length) % areas.length];
    this.focusArea(next);
  }

  private focusArea(area: HTMLElement): void {
    if (area === this.titlebar) {
      (this.titlebar.querySelector<HTMLElement>('#tb-search') ?? this.titlebar.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
    } else if (area === this.rail) {
      this.rail.querySelector<HTMLElement>('.rail-tab[tabindex="0"]')?.focus();
    } else if (this.module === 'chat' && !this.setupShown) {
      this.chat.focusPane(area);
    } else if (this.module === 'tasks' && !this.setupShown && this.tasks !== null && area !== this.tasks.root) {
      if (area.tagName === 'MAIN') this.tasks.focusPage();
      else (area.querySelector<HTMLElement>('#task-close') ?? area).focus();
    } else if (this.module === 'time' && !this.setupShown && this.app !== null && this.app.state.session !== null) {
      this.app.focusPane(area);
    } else {
      (area.querySelector<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex="0"]') ?? area).focus();
    }
  }
}

function modKey(): string {
  return /mac/i.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl';
}

/** The host of a server address for Settings → Account (the address itself when it does not parse). */
function hostOf(server: string | null): string {
  if (server === null) return '';
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** The Popover API (the update panel); test DOMs without it get a `hidden` panel with the same keys. */
function supportsPopover(): boolean {
  return typeof HTMLElement !== 'undefined' && typeof (HTMLElement.prototype as { showPopover?: unknown }).showPopover === 'function';
}
