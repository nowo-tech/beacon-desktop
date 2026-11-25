/**
 * The app shell (BD-2, approved prototype): title bar (brand, organization, quick switcher, timer pill, theme, help),
 * left rail (organization tiles, Chat / Time module tabs, settings) and the modules. The Time module is the existing
 * DesktopApp, unchanged inside its panel; Tasks is registered but off (BEACON_DESKTOP_TASKS.md, BD-2 row).
 *
 * Owner decisions 2026-11-25: landing = Chat on first launch, then the last-used module, Time when a timer runs (Q1);
 * timer in the title bar, optionally also in the sidebar (Q2); sidebar density comfortable / compact (Q3); organization
 * switcher as rail tiles or a dropdown, and a timer never keeps running in another organization (Q4).
 */
import type { DesktopApp } from '../ui/app';
import { h } from '../ui/dom';
import type { Platform } from '../platform';
import type { Locale } from '../lib/i18n';
import type { ThemePreference } from '../lib/theme';
import { chatText, type ChatText } from '../chat/i18n';
import { chatIcon, type ChatIconName } from '../chat/icons';
import { ChatModule, showMenu } from '../chat/module';
import { rankConversations } from '../chat/format';
import type { Context, Conversation } from '../chat/types';
import { isMuted, sectionOf } from '../chat/store';

export type ModuleId = 'chat' | 'time';
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
}

export const SHELL_KEY = 'beacon-desktop-shell';
const DEFAULTS: ShellPrefs = { module: null, density: 'comfortable', switcher: 'tiles', timer: 'title', context: null };

export function loadShellPrefs(storage: Storage | undefined): ShellPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(SHELL_KEY) ?? 'null') as Partial<ShellPrefs> | null;
    if (raw === null || typeof raw !== 'object') return { ...DEFAULTS };
    return {
      module: raw.module === 'chat' || raw.module === 'time' ? raw.module : null,
      density: raw.density === 'compact' ? 'compact' : 'comfortable',
      switcher: raw.switcher === 'dropdown' ? 'dropdown' : 'tiles',
      timer: raw.timer === 'title-sidebar' ? 'title-sidebar' : 'title',
      context: typeof raw.context === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.context) ? raw.context : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Landing module (owner Q1): a running timer wins; else the last module; first launch: Chat. */
export function landingModule(prefs: ShellPrefs, timerRunning: boolean): ModuleId {
  if (timerRunning) return 'time';
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
  app: DesktopApp | null = null;
  prefs: ShellPrefs;
  module: ModuleId = 'chat';
  contexts: Context[] = [];
  context: string | null = null;
  unread = 0;
  unreadCapped = false;
  private readonly t: ChatText;
  private readonly titlebar: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly chatPanel: HTMLElement;
  private readonly timePanel: HTMLElement;
  private readonly live: HTMLElement;
  private readonly switcher: HTMLDialogElement;
  private readonly settings: HTMLDialogElement;
  private readonly keys: HTMLDialogElement;
  private readonly confirm: HTMLDialogElement;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private signedIn = false;
  private started = false;
  private lastBadge = -1;
  private switcherIndex = 0;
  private switcherItems: Conversation[] = [];

  constructor(
    private readonly mount: HTMLElement,
    private readonly platform: Platform,
    private readonly deps: ShellDeps,
  ) {
    this.t = chatText(deps.locale);
    this.prefs = loadShellPrefs(deps.storage);
    this.timeRoot = h('div', { class: 'time-root', id: 'app', attrs: { 'aria-busy': 'true' } });
    this.titlebar = h('header', { class: 'titlebar', id: 'titlebar' });
    this.rail = h('nav', { class: 'rail', id: 'rail', attrs: { 'aria-label': this.t('modules') } });
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
      copy: (text) => this.copy(text),
      announce: (text) => this.announce(text),
      onContexts: (contexts, current) => {
        this.contexts = contexts;
        this.context = current;
        if (current !== null && current !== this.prefs.context) {
          this.prefs.context = current;
          this.save();
        }
        this.renderChrome();
      },
      onUnread: (total, capped) => {
        this.unread = total;
        this.unreadCapped = capped;
        this.renderRail();
        if (total !== this.lastBadge) {
          this.lastBadge = total;
          void host.setUnreadBadge(total).catch(() => undefined);
        }
      },
      onConnection: () => this.renderChrome(),
      sidebarTimer: () => this.sidebarTimer(),
      storage: deps.storage,
    });
    this.chatPanel = h('section', { class: 'module', id: 'mod-chat', attrs: { role: 'tabpanel', 'aria-labelledby': 'tab-chat' } }, this.chat.root);
    this.timePanel = h('section', { class: 'module', id: 'mod-time', attrs: { role: 'tabpanel', 'aria-labelledby': 'tab-time' } }, this.timeRoot);
    this.live = h('p', { class: 'sr-only', id: 'shell-live', attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    this.switcher = this.buildSwitcher();
    this.settings = h('dialog', { class: 'sh-dialog', id: 'shell-settings', attrs: { 'aria-labelledby': 'shell-settings-title', closedby: 'any' } });
    this.keys = h('dialog', { class: 'sh-dialog', id: 'shell-keys', attrs: { 'aria-labelledby': 'shell-keys-title', closedby: 'any' } });
    this.confirm = h('dialog', { class: 'sh-dialog', id: 'shell-confirm', attrs: { 'aria-labelledby': 'shell-confirm-title' } });
    this.root = h('div', { class: 'shell', id: 'shell', attrs: { 'data-bare': 'true' } }, this.titlebar, h('div', { class: 'body' }, this.rail, this.chatPanel, this.timePanel), this.live, this.switcher, this.settings, this.keys, this.confirm);
    this.mount.replaceChildren(this.root);
    this.root.addEventListener('chat-switcher', () => this.openSwitcher());
    document.addEventListener('keydown', (event) => this.onKey(event));
    globalThis.addEventListener?.('focus', () => this.chat.setShown(this.module === 'chat' && !document.hidden));
    document.addEventListener('visibilitychange', () => this.chat.setShown(this.module === 'chat' && !document.hidden));
    this.applyDensity();
  }

  /** Attaches the Time module (its constructor needs `timeRoot`) and follows its renders. */
  attach(app: DesktopApp): void {
    this.app = app;
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
      this.chat.signedOut();
      this.contexts = [];
      this.context = null;
      void this.platform.chat?.setUnreadBadge(0).catch(() => undefined);
    }
    this.root.dataset.bare = signedIn ? 'false' : 'true';
    if (!signedIn) this.show('time', false);
    this.renderTitlebar();
    this.syncTicker();
  }

  /** Signed in (at start-up or after the sign-in): landing module, then chat. */
  private async enter(): Promise<void> {
    const app = this.app;
    if (app === null || this.started) return;
    this.started = true;
    // A fresh interactive sign-in stays on Time (where it happened); a launch follows the landing rule (Q1).
    this.show(this.freshSignIn ? 'time' : landingModule(this.prefs, app.state.activeTimer !== null), false);
    await this.chat.init(this.prefs.context);
    this.renderChrome();
  }

  /** Set by main.ts when the session came from a sign-in in this run (not a launch with a stored session). */
  freshSignIn = false;

  show(module: ModuleId, remember = true): void {
    this.module = module;
    this.chatPanel.hidden = module !== 'chat';
    this.timePanel.hidden = module !== 'time';
    this.root.dataset.module = module;
    if (remember && this.signedIn) {
      this.prefs.module = module;
      this.save();
    }
    this.chat.setShown(module === 'chat' && !document.hidden);
    this.renderRail();
    this.renderTitlebar();
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
    const search = h('button', { class: 'tb-search', id: 'tb-search', attrs: { type: 'button', 'aria-haspopup': 'dialog', 'aria-keyshortcuts': 'Control+K Meta+K' } }, chatIcon('search', 'sm'), h('span', {}, t('searchJump')), h('kbd', {}, `${modKey()} K`));
    search.addEventListener('click', () => this.openSwitcher());
    search.hidden = !this.chat.connected;
    const right = h('div', { class: 'tb-right' }, this.timerPill());
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (document.documentElement.getAttribute('data-theme') === null && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
    const theme = this.iconButton('tb-btn', dark ? 'sun' : 'moon', dark ? t('themeLight') : t('themeDark'), () => void this.setTheme(dark ? 'light' : 'dark'), 'tb-theme');
    const help = this.iconButton('tb-btn', 'keyboard', t('shortcuts'), () => this.openKeys(), 'tb-help');
    right.append(theme, help);
    this.titlebar.replaceChildren(left, h('div', { class: 'tb-mid' }, search), right);
    document.title = current !== null ? `${current.context.label} · ${t('appName')}` : t('appName');
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
    const specs: [ModuleId, ChatIconName, string, string][] = [
      ['chat', 'chat', t('moduleChat'), this.unread > 0 ? t('moduleChatUnread', { count: this.badgeText() }) : t('moduleChat')],
      ['time', 'clock', t('moduleTime'), this.app?.state.activeTimer ? t('moduleTimeRunning') : t('moduleTime')],
    ];
    specs.forEach(([id, icon, label, aria], index) => {
      const selected = this.module === id;
      const tab = h(
        'button',
        {
          class: 'rail-tab',
          id: `tab-${id}`,
          attrs: { type: 'button', role: 'tab', 'aria-selected': selected ? 'true' : 'false', 'aria-controls': `mod-${id}`, tabindex: selected ? '0' : '-1', title: `${label} (${modKey()}+${index + 1})`, 'aria-keyshortcuts': `Control+${index + 1}` },
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
    const timer = this.app?.state.activeTimer ?? null;
    if (timer !== null) {
      const confirmed = await this.askStopAndSwitch(key);
      if (!confirmed) return;
      await this.app?.stop();
      if (this.app?.state.activeTimer !== null) {
        this.announce(this.t('stopFailed'));
        return;
      }
    }
    this.prefs.context = key;
    this.save();
    await this.chat.switchContext(key);
    const label = this.contexts.find((item) => item.key === key)?.label ?? key;
    this.announce(this.t('contextSwitched', { name: label }));
    this.renderChrome();
  }

  private askStopAndSwitch(key: string): Promise<boolean> {
    const t = this.t;
    const timer = this.app?.state.activeTimer;
    const org = this.currentContext()?.context.label ?? '';
    const target = this.contexts.find((item) => item.key === key)?.label ?? key;
    return new Promise((resolve) => {
      const cancel = h('button', { class: 'btn', id: 'confirm-cancel', attrs: { type: 'button', autofocus: true } }, t('cancel'));
      const go = h('button', { class: 'btn primary', id: 'confirm-stop-switch', attrs: { type: 'button' } }, chatIcon('stop', 'sm'), t('stopAndSwitch'));
      this.confirm.replaceChildren(
        h(
          'div',
          { class: 'dlg' },
          h('div', { class: 'dlg-h' }, h('h1', { id: 'shell-confirm-title' }, t('stopAndSwitchTitle', { org }))),
          h('div', { class: 'dlg-b' }, h('p', {}, t('stopAndSwitchText', { task: timer?.taskTitle ?? '', time: timer ? elapsed(timer.startedAt, this.now()) : '', org, target }))),
          h('div', { class: 'dlg-f' }, cancel, go),
        ),
      );
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
    const list = h('div', { class: 'sw-list', id: 'sw-list', attrs: { role: 'listbox', 'aria-label': t('conversations') } });
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

  openSwitcher(): void {
    if (!this.chat.connected) return;
    for (const dialog of [this.settings, this.keys]) if (dialog.open) dialog.close();
    const input = this.switcher.querySelector<HTMLInputElement>('#sw-input');
    if (input === null) return;
    input.value = '';
    input.placeholder = this.t('switcherPlaceholder');
    this.switcherIndex = 0;
    this.renderSwitcher();
    if (!this.switcher.open) this.switcher.showModal();
    input.focus();
  }

  private renderSwitcher(): void {
    const t = this.t;
    const input = this.switcher.querySelector<HTMLInputElement>('#sw-input');
    const list = this.switcher.querySelector<HTMLElement>('#sw-list');
    if (input === null || list === null) return;
    this.switcherItems = rankConversations(this.chat.allConversations(), this.chat.recent, input.value).slice(0, 14);
    this.switcherIndex = Math.min(this.switcherIndex, Math.max(0, this.switcherItems.length - 1));
    if (this.switcherItems.length === 0) {
      list.replaceChildren(h('div', { class: 'sw-empty' }, t('switcherEmpty')));
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const now = this.now();
    list.replaceChildren(
      ...this.switcherItems.map((row, index) => {
        const section = sectionOf(row);
        const icon: ChatIconName = row.kind === 'direct' ? 'users' : row.kind === 'support' ? 'headset' : section === 'projects' ? 'folder' : 'hash';
        const meta = row.unread > 0 ? t('switcherUnread', { count: row.unread }) : this.chat.recent.includes(row.uuid) ? t('switcherRecent') : row.kind === 'direct' ? t('kindDirect') : section === 'projects' ? t('kindProject') : row.kind === 'support' ? t('kindSupport') : t('kindChannel');
        const option = h(
          'div',
          { class: `opt${row.unread > 0 && !isMuted(row, now) ? ' unread' : ''}`, id: `sw-${index}`, attrs: { role: 'option', 'aria-selected': index === this.switcherIndex ? 'true' : 'false' } },
          h('span', { class: 'o-ico' }, chatIcon(icon, 'sm')),
          h('span', { class: 'o-t' }, row.title),
          row.unread > 0 ? h('span', { class: 'badge', attrs: { 'aria-hidden': 'true' } }, String(row.unread)) : null,
          h('span', { class: 'o-m' }, meta),
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
    const row = this.switcherItems[this.switcherIndex];
    if (row === undefined) return;
    this.switcher.close();
    this.show('chat');
    void this.chat.open(row.uuid);
  }

  // ---- settings and the shortcut sheet ------------------------------------------------------------------------------

  async setTheme(theme: ThemePreference): Promise<void> {
    await this.app?.setTheme(theme);
    this.renderTitlebar();
    if (this.settings.open) this.renderSettings();
  }

  openSettings(): void {
    this.renderSettings();
    if (!this.settings.open) this.settings.showModal();
    this.settings.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
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

  private settingRow(title: string, hint: string | null, control: HTMLElement): HTMLElement {
    return h('div', { class: 'set-row' }, h('div', { class: 's-l' }, h('div', { class: 's-t' }, title), hint !== null ? h('div', { class: 's-d' }, hint) : null), control);
  }

  private renderSettings(): void {
    const t = this.t;
    const theme = (this.app?.state.settings.theme ?? 'system') as ThemePreference;
    const update = (patch: Partial<ShellPrefs>) => {
      this.prefs = { ...this.prefs, ...patch };
      this.save();
      this.renderChrome();
      this.renderSettings();
    };
    const close = this.iconButton('x-btn', 'x', t('close'), () => this.settings.close(), 'settings-close');
    const look = h(
      'div',
      { class: 'set-group' },
      h('h3', {}, t('settingsAppearance')),
      this.settingRow(t('theme'), null, this.segmented(t('theme'), [['system', t('themeSystem')], ['light', t('themeLightOption')], ['dark', t('themeDarkOption')]], theme, (value) => void this.setTheme(value))),
      this.settingRow(t('density'), t('densityHint'), this.segmented(t('density'), [['comfortable', t('densityComfortable')], ['compact', t('densityCompact')]], this.prefs.density, (density) => update({ density }))),
      this.settingRow(t('switcherStyle'), t('switcherStyleHint'), this.segmented(t('switcherStyle'), [['tiles', t('switcherTiles')], ['dropdown', t('switcherDropdown')]], this.prefs.switcher, (switcher) => update({ switcher }))),
      this.settingRow(t('timerPlacement'), t('timerPlacementHint'), this.segmented(t('timerPlacement'), [['title', t('timerTitle')], ['title-sidebar', t('timerTitleSidebar')]], this.prefs.timer, (timer) => update({ timer }))),
    );
    const connection = h('div', { class: 'set-group' }, h('h3', {}, t('settingsChat')));
    if (this.chat.connected) {
      const disconnect = h('button', { class: 'btn sm danger', id: 'chat-disconnect', attrs: { type: 'button' } }, t('disconnect'));
      disconnect.addEventListener('click', () => {
        void this.chat.disconnect().then(() => this.renderSettings());
      });
      connection.append(this.settingRow(t('chatConnection'), `${t('chatConnected')}. ${t('disconnectHint')}`, disconnect));
    } else {
      const connect = h('button', { class: 'btn sm primary', attrs: { type: 'button' } }, t('connectButton'));
      connect.addEventListener('click', () => {
        this.settings.close();
        this.show('chat');
        void this.chat.connectChat();
      });
      connection.append(this.settingRow(t('chatConnection'), t('chatNotConnected'), connect));
    }
    this.settings.replaceChildren(h('div', { class: 'dlg settings' }, h('div', { class: 'dlg-h' }, h('h1', { id: 'shell-settings-title' }, t('shellSettings')), close), h('div', { class: 'dlg-b' }, look, connection)));
  }

  openKeys(): void {
    const t = this.t;
    const mod = modKey();
    const sections: [string, [string, string[]][]][] = [
      [t('keysAnywhere'), [[t('keySwitcher'), [mod, 'K']], [t('keyModules'), [mod, '1 2']], [t('keySettings'), [mod, ',']], [t('keyTheme'), [mod, 'Shift', 'L']], [t('keySheet'), ['?']]]],
      [
        t('keysChat'),
        [
          [t('keyConv'), ['Alt', '↑ ↓']],
          [t('keyUnread'), ['Alt', 'Shift', '↑ ↓']],
          [t('keyJumpUnread'), [mod, 'J']],
          [t('keyHistory'), [mod, '[ ]']],
          [t('keyMessages'), ['↑ ↓']],
          [t('keyThread'), ['Enter']],
          [t('keyLeave'), ['Esc']],
        ],
      ],
    ];
    const close = this.iconButton('x-btn', 'x', t('close'), () => this.keys.close(), 'keys-close');
    const body = h('div', { class: 'keys' });
    for (const [title, rows] of sections) {
      body.append(h('h2', {}, title));
      for (const [label, combo] of rows) body.append(h('div', { class: 'k' }, h('span', {}, label), h('span', {}, ...combo.map((key) => h('kbd', {}, key)))));
    }
    this.keys.replaceChildren(h('div', { class: 'dlg' }, h('div', { class: 'dlg-h' }, h('h1', { id: 'shell-keys-title' }, t('keysTitle')), close), body));
    if (!this.keys.open) this.keys.showModal();
    close.focus();
  }

  // ---- keys ---------------------------------------------------------------------------------------------------------

  private onKey(event: KeyboardEvent): void {
    if (this.root.dataset.bare === 'true') return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const dialogOpen = [this.switcher, this.settings, this.keys, this.confirm].some((dialog) => dialog.open);
    const target = event.target as HTMLElement | null;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable === true;
    if (mod && !event.shiftKey && key === 'k' && this.module === 'chat') {
      event.preventDefault();
      if (this.switcher.open) this.switcher.close();
      else this.openSwitcher();
      return;
    }
    if (dialogOpen) return;
    if (mod && !event.shiftKey && !event.altKey && (event.key === '1' || event.key === '2')) {
      event.preventDefault();
      const next: ModuleId = event.key === '1' ? 'chat' : 'time';
      this.show(next);
      this.rail.querySelector<HTMLElement>(`#tab-${next}`)?.focus();
      return;
    }
    if (mod && event.shiftKey && key === 'l' && this.module === 'chat') {
      event.preventDefault();
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      void this.setTheme(dark ? 'light' : 'dark');
      return;
    }
    if (this.module !== 'chat') return;
    if (mod && event.key === ',') {
      event.preventDefault();
      this.openSettings();
      return;
    }
    if (!typing && !mod && !event.altKey && event.key === '?') {
      event.preventDefault();
      this.openKeys();
      return;
    }
    if (!typing && this.chat.onKey(event)) event.preventDefault();
  }
}

function modKey(): string {
  return /mac/i.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl';
}
