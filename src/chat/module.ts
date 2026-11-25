/**
 * The Chat module (BD-2, read-only): connect card and device flow, sidebar with sections, timeline with infinite
 * scroll, read-only thread panel and reaction chips, read marks, realtime hints with polling fallback.
 *
 * UX rules (owner, 2026-11-25): the cached state paints at once and refreshes quietly; no layout shift (older pages and
 * new messages keep the reading position; at the bottom the view sticks to it, scrolled up a "N new messages" pill
 * appears); skeletons that match the layout, never a spinner; keyboard first.
 */
import { ApiError } from '../api/client';
import type { TimeTrackApi } from '../api/client';
import { DeviceFlowError, runDeviceFlow } from '../lib/deviceFlow';
import type { ChatHost, ChatRealtimeMode } from '../platform';
import { type Child, h } from '../ui/dom';
import { ChatApi } from './api';
import { plainText, renderBlocks } from './body';
import { dayLabel, History, rows, step } from './format';
import type { ChatText } from './i18n';
import { type ChatIconName, chatIcon } from './icons';
import { isMuted, type SectionId, sectionOf } from './store';
import { ChatSync, type SyncClock, realClock } from './sync';
import type { ChatMe, Context, Conversation, Message } from './types';
import { parseHint } from './types';

export interface ChatModuleDeps {
  t: ChatText;
  locale: string;
  host: ChatHost;
  fetchImpl: typeof fetch;
  /** The time API (chained device code, opening the verification page). */
  timeApi(): TimeTrackApi | null;
  /** The signed-in server (`null` while signed out). */
  server(): string | null;
  openVerification(url: string): void;
  copy(text: string): Promise<void>;
  announce(text: string): void;
  /** The context changed (the shell redraws its switcher and title). */
  onContexts(contexts: Context[], current: string | null): void;
  /** Unread counts per conversation changed (rail badge, tray / Dock badge). */
  onUnread(total: number, capped: boolean): void;
  /** Chat connected / disconnected. */
  onConnection(connected: boolean): void;
  /** The context last used on this device (a fresh connection starts there). */
  preferredContext?(): string | null;
  /** A slot at the sidebar's foot for the running timer ("title bar + sidebar"). */
  sidebarTimer(): HTMLElement | null;
  clock?: SyncClock;
  now?: () => Date;
  /** Device-flow sleep (tests shorten it). */
  sleep?: (ms: number) => Promise<void>;
  storage?: Storage;
}

type ConnectState =
  | { kind: 'idle'; message: string | null }
  | { kind: 'starting' }
  | { kind: 'code'; userCode: string; url: string }
  | { kind: 'done' };

/** Device-local chat view state (never message data): collapsed sections, last conversation per context, thread width. */
interface ViewPrefs {
  collapsed: Partial<Record<SectionId, boolean>>;
  lastConversation: Record<string, string>;
  threadWidth: number;
}

const PREFS_KEY = 'beacon-desktop-chat-view';
const THREAD_MIN = 300;
const THREAD_MAX = 640;

function loadPrefs(storage: Storage | undefined): ViewPrefs {
  const fallback: ViewPrefs = { collapsed: {}, lastConversation: {}, threadWidth: 380 };
  try {
    const raw = JSON.parse(storage?.getItem(PREFS_KEY) ?? 'null') as Partial<ViewPrefs> | null;
    if (raw === null || typeof raw !== 'object') return fallback;
    const collapsed: ViewPrefs['collapsed'] = {};
    for (const id of ['channels', 'projects', 'dms', 'support'] as SectionId[]) if (raw.collapsed?.[id] === true) collapsed[id] = true;
    const lastConversation: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.lastConversation ?? {})) if (typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) lastConversation[key] = value;
    const width = typeof raw.threadWidth === 'number' ? Math.min(Math.max(raw.threadWidth, THREAD_MIN), THREAD_MAX) : 380;
    return { collapsed, lastConversation, threadWidth: width };
  } catch {
    return fallback;
  }
}

const SECTION_LABEL: Record<SectionId, 'sectionChannels' | 'sectionProjects' | 'sectionDms' | 'sectionSupport'> = {
  channels: 'sectionChannels',
  projects: 'sectionProjects',
  dms: 'sectionDms',
  support: 'sectionSupport',
};

export class ChatModule {
  readonly root: HTMLElement;
  connected = false;
  me: ChatMe | null = null;
  context: string | null = null;
  api: ChatApi | null = null;
  sync: ChatSync | null = null;
  connect: ConnectState = { kind: 'idle', message: null };
  /** Realtime state from the host; `banner` shows only after a live stream was lost. */
  mode: ChatRealtimeMode = 'stopped';
  netState: 'ok' | 'offline' | 'limited' = 'ok';
  private wasLive = false;
  error: string | null = null;
  /** The module is shown (chat tab selected, window visible). */
  private shown = false;
  private readonly side: HTMLElement;
  private readonly main: HTMLElement;
  private readonly threadSlot: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly list: HTMLElement;
  private readonly pill: HTMLButtonElement;
  private readonly head: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly foot: HTMLElement;
  private prefs: ViewPrefs;
  private readonly history = new History();
  /** Recently opened conversations (switcher order), per session. */
  recent: string[] = [];
  /** The read cursor seen when the open conversation was opened: the "New" divider stays put while reading. */
  private dividerAt: number | null = null;
  private newBelow = 0;
  private stick = true;
  private abort: AbortController | null = null;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private hostWired = false;
  private readonly clock: SyncClock;
  private readonly now: () => Date;
  private loadingOlder = false;
  /** Contexts the server refused (`403`) in this run: never used or remembered again. */
  private readonly refused = new Set<string>();

  constructor(private readonly deps: ChatModuleDeps) {
    this.clock = deps.clock ?? realClock;
    this.now = deps.now ?? (() => new Date());
    this.prefs = loadPrefs(deps.storage);
    this.side = h('aside', { class: 'side', id: 'chat-side', attrs: { 'aria-label': deps.t('conversations') } });
    this.head = h('header', { class: 'ch-head', id: 'chat-head' });
    this.banner = h('div', { class: 'ch-banner', id: 'chat-banner', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.list = h('ul', { class: 'msg-list', id: 'msg-list', attrs: { role: 'list' } });
    this.scroller = h('div', { class: 'msgs', id: 'msg-scroll', attrs: { tabindex: '-1', role: 'region' } }, this.list);
    this.pill = h('button', { class: 'new-pill', id: 'new-pill', attrs: { type: 'button', hidden: true } });
    this.pill.addEventListener('click', () => this.scrollToBottom(true));
    this.foot = h('div', { class: 'ch-foot', id: 'chat-foot' });
    this.main = h('div', { class: 'chat-main', id: 'chat-main' }, this.head, this.banner, h('div', { class: 'msgs-wrap' }, this.scroller, this.pill), this.foot);
    this.threadSlot = h('div', { class: 'thread-slot', id: 'thread-slot' });
    this.root = h('div', { class: 'chat', id: 'chat' }, this.side, this.main, this.threadSlot);
    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    // The thread panel or a window resize reflows the timeline: keep the bottom when reading there.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        if (this.stick) this.scroller.scrollTop = this.scroller.scrollHeight;
      }).observe(this.scroller);
    }
    this.list.addEventListener('keydown', (event) => this.onMessageKey(event, this.list));
    this.list.addEventListener('contextmenu', (event) => this.onContextMenu(event));
    this.list.addEventListener('focusin', (event) => this.roving(event, this.list));
  }

  private get t(): ChatText {
    return this.deps.t;
  }

  // ---- connection ---------------------------------------------------------------------------------------------------

  /** Reads whether a chat token is stored and starts the module when it is. */
  async init(context: string | null): Promise<void> {
    this.wireHost();
    const server = this.deps.server();
    const token = server === null ? null : await this.deps.host.token();
    if (server === null || token === null) {
      this.setDisconnected(null);
      return;
    }
    await this.start(server, token, context);
  }

  private wireHost(): void {
    if (this.hostWired) return;
    this.hostWired = true;
    this.deps.host.onHint((raw) => {
      const hint = parseHint(raw);
      if (hint !== null) this.sync?.hint(hint);
    });
    this.deps.host.onRealtime((mode) => this.setMode(mode));
  }

  private async start(server: string, token: string, context: string | null): Promise<void> {
    this.connected = true;
    this.deps.onConnection(true);
    this.api = new ChatApi({ baseUrl: server, token, context: null, fetchImpl: this.deps.fetchImpl });
    this.sync = new ChatSync(
      this.api,
      {
        changed: (scope) => this.changed(scope),
        arrived: (count, author) => this.arrived(count, author),
        unauthorized: () => void this.lostAuthorization(),
        status: (state) => {
          this.netState = state;
          this.renderBanner();
          this.renderSideFoot();
        },
      },
      this.clock,
    );
    this.sync.visible = this.shown;
    this.render();
    try {
      // `me` lists the person's contexts. ChatKit wants a context on every request when the host has a context
      // policy: the last one used, else Personal (always the person's own); a context no longer allowed falls back.
      this.api.setContext(context ?? 'personal');
      try {
        this.me = await this.api.me();
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 403 && context !== null && context !== 'personal')) throw error;
        this.refused.add(context);
        this.api.setContext('personal');
        this.me = await this.api.me();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return this.lostAuthorization();
      // A refused context header or an unreachable server: show the error, keep the connection.
      this.error = this.t('errorGeneric');
      this.render();
      return;
    }
    const contexts = this.me.contexts;
    // A context refused above is never used again in this run (Beacon's rule for the fallback).
    const usable = context !== null && !this.refused.has(context) && contexts.some((item) => item.key === context);
    const wanted = usable ? context : (this.me.context ?? contexts.find((item) => !this.refused.has(item.key))?.key ?? null);
    await this.switchContext(wanted);
  }

  /**
   * Switches the tenant: memory cleared, list loaded, the last conversation of that context reopened. A `403` for an
   * organization falls back to Personal **once** (no loop); a refused context is never remembered or used again.
   */
  async switchContext(context: string | null, fallback = true): Promise<void> {
    if (this.api === null || this.sync === null) return;
    const previous = this.context;
    this.context = context;
    this.api.setContext(context);
    this.history.clear();
    this.error = null;
    this.render();
    try {
      await this.sync.start();
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && context !== null && context !== 'personal') {
        this.refused.add(context);
        this.context = previous;
        if (fallback) return this.switchContext('personal', false);
        this.error = this.t('errorGeneric');
        this.render();
        return;
      }
      if (!(error instanceof ApiError && error.status === 401)) this.error = this.t('errorGeneric');
    }
    // Only a context the server served is shown as current and remembered.
    this.deps.onContexts((this.me?.contexts ?? []).filter((item) => !this.refused.has(item.key)), context);
    const server = this.deps.server();
    if (server !== null && context !== null) void this.deps.host.realtimeStart(server, context).catch(() => this.setMode('polling'));
    const last = context === null ? undefined : this.prefs.lastConversation[context];
    if (last !== undefined && this.sync.store.conversation(last) !== null) await this.open(last, false);
    this.render();
  }

  private async lostAuthorization(): Promise<void> {
    await this.deps.host.disconnect().catch(() => undefined);
    this.setDisconnected(this.t('disconnected'));
  }

  private setDisconnected(message: string | null): void {
    void this.deps.host.realtimeStop().catch(() => undefined);
    // Which conversation was open last (ids only) goes too (audit ZBZ-I3).
    this.prefs.lastConversation = {};
    this.savePrefs(true);
    this.sync?.reset();
    this.sync = null;
    this.api = null;
    this.me = null;
    this.connected = false;
    this.mode = 'stopped';
    this.connect = { kind: 'idle', message };
    this.deps.onConnection(false);
    this.deps.onContexts([], null);
    this.deps.onUnread(0, false);
    this.render();
  }

  /**
   * Revokes the chat token on the server before it is deleted here (ChatKit 2.4.1 `POST logout`, audit ZBZ-L4): best
   * effort, short timeout; a 2.4.0 server (404) or no network just continues.
   */
  async revokeOnServer(): Promise<void> {
    const server = this.deps.server();
    const token = this.api === null && server !== null && this.connected ? await this.deps.host.token() : null;
    const api = this.api ?? (server !== null && token !== null ? new ChatApi({ baseUrl: server, token, context: null, fetchImpl: this.deps.fetchImpl }) : null);
    await api?.logout(this.logoutTimeoutMs);
  }

  /** "Disconnect chat" (Settings): revoked on the server (best effort), then deleted here; time stays signed in. */
  async disconnect(): Promise<void> {
    await this.revokeOnServer();
    await this.deps.host.disconnect();
    this.setDisconnected(null);
  }

  /** How long a best-effort logout may take (ms). */
  logoutTimeoutMs = 3000;

  /** Sign-out of the whole app: Rust already deleted both tokens; forget everything in memory. */
  signedOut(): void {
    this.abort?.abort();
    this.setDisconnected(null);
  }

  /** "Connect chat": chained device flow for the `chat` family (TimeTrackBundle 2.2, contract v0.5). */
  async connectChat(): Promise<void> {
    const api = this.deps.timeApi();
    const server = this.deps.server();
    if (api === null || server === null) {
      this.connect = { kind: 'idle', message: this.t('connectNeedsTime') };
      this.render();
      return;
    }
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.connect = { kind: 'starting' };
    this.render();
    try {
      await this.deps.host.connectBegin();
      const result = await runDeviceFlow(
        { deviceCode: (clientName) => api.chatDeviceCode(clientName), deviceToken: (code) => api.deviceToken(code) },
        {
          clientName: 'Beacon Desktop',
          signal: abort.signal,
          sleep: this.deps.sleep,
          onCode: (code) => {
            const url = code.verificationUriComplete ?? code.verificationUri;
            this.connect = { kind: 'code', userCode: code.userCode, url };
            this.render();
            this.deps.openVerification(url);
          },
        },
      );
      if (abort.signal.aborted) return;
      await this.deps.host.tokenSet(result.token);
      const token = await this.deps.host.token();
      if (token === null) throw new Error('not stored');
      this.connect = { kind: 'done' };
      this.deps.announce(this.t('connectDone'));
      await this.start(server, token, this.context ?? this.deps.preferredContext?.() ?? null);
    } catch (error) {
      if (abort.signal.aborted && !(error instanceof DeviceFlowError && error.reason !== 'cancelled')) return;
      const message =
        error instanceof DeviceFlowError
          ? error.reason === 'expired'
            ? this.t('connectExpired')
            : error.reason === 'denied'
              ? this.t('connectDenied')
              : error.reason === 'invalid_scope'
                ? this.t('connectRefused')
                : null
          : error instanceof ApiError && (error.status === 400 || error.status === 403 || error.status === 404)
            ? this.t('connectRefused')
            : this.t('connectFailed');
      this.connect = { kind: 'idle', message };
      this.render();
    }
  }

  cancelConnect(): void {
    this.abort?.abort();
    this.connect = { kind: 'idle', message: null };
    this.render();
    this.root.querySelector<HTMLElement>('#chat-connect')?.focus();
  }

  // ---- visibility, realtime -------------------------------------------------------------------------------------------

  setShown(shown: boolean): void {
    this.shown = shown;
    this.sync?.setVisible(shown);
    if (shown) this.scheduleRead();
  }

  setMode(mode: ChatRealtimeMode): void {
    if (mode === 'unauthorized' && this.connected) {
      void this.lostAuthorization();
      return;
    }
    if (mode === 'live') this.wasLive = true;
    this.mode = mode;
    this.sync?.setLive(mode === 'live');
    this.renderBanner();
    this.renderSideFoot();
  }

  // ---- navigation ---------------------------------------------------------------------------------------------------

  conversations(): Conversation[] {
    return this.sync?.store.sections().flatMap((section) => (this.prefs.collapsed[section.id] === true ? section.conversations.filter((row) => row.unread > 0 || row.uuid === this.sync?.openUuid) : section.conversations)) ?? [];
  }

  allConversations(): Conversation[] {
    return this.sync?.store.conversations() ?? [];
  }

  openUuid(): string | null {
    return this.sync?.openUuid ?? null;
  }

  /** Opens a conversation: cached messages paint at once, then a quiet refresh. */
  async open(uuid: string, focus = true): Promise<void> {
    const sync = this.sync;
    if (sync === null || sync.store.conversation(uuid) === null) return;
    const previous = sync.openUuid;
    if (previous !== null && previous !== uuid) void sync.markRead(previous).catch(() => undefined);
    const timeline = sync.store.timeline(uuid);
    this.dividerAt = timeline?.readUpTo ?? this.readCursorGuess(uuid);
    this.newBelow = 0;
    this.stick = true;
    this.history.push(uuid);
    this.recent = [uuid, ...this.recent.filter((item) => item !== uuid)].slice(0, 20);
    if (this.context !== null) {
      this.prefs.lastConversation[this.context] = uuid;
      this.savePrefs();
    }
    this.root.classList.remove('list-open');
    const promise = sync.open(uuid);
    this.render();
    if (focus) this.scroller.focus({ preventScroll: true });
    const row = sync.store.conversation(uuid);
    if (row !== null) this.deps.announce(row.title);
    try {
      await promise;
    } catch (error) {
      this.handleError(error);
    }
    if (this.dividerAt === null) this.dividerAt = sync.store.timeline(uuid)?.readUpTo ?? null;
    this.renderMessages();
    this.scheduleRead();
  }

  /** Without a loaded timeline: the unread count tells where the divider goes once the page arrives. */
  private readCursorGuess(uuid: string): number | null {
    const row = this.sync?.store.conversation(uuid);
    return row !== null && row !== undefined && row.unread === 0 ? Number.MAX_SAFE_INTEGER : null;
  }

  /** Esc: marks the conversation read and leaves it (back to the list). */
  async leave(): Promise<void> {
    const sync = this.sync;
    const open = sync?.openUuid ?? null;
    if (sync === null || open === null) return;
    await sync.markRead(open).catch(() => undefined);
    sync.openUuid = null;
    sync.closeThread();
    this.root.classList.add('list-open');
    this.render();
    this.side.querySelector<HTMLElement>(`[data-conv="${open}"]`)?.focus();
  }

  stepConversation(direction: 1 | -1, unreadOnly: boolean): void {
    const next = step(this.conversations(), this.openUuid(), direction, unreadOnly);
    if (next !== null) void this.open(next, false).then(() => this.side.querySelector<HTMLElement>(`[data-conv="${next}"]`)?.focus());
  }

  jumpUnread(): void {
    const target = this.allConversations().find((row) => row.unread > 0 && row.uuid !== this.openUuid() && !isMuted(row, this.clock.now()));
    if (target !== undefined) void this.open(target.uuid);
  }

  back(): void {
    const uuid = this.history.back();
    if (uuid !== null) void this.openWithoutHistory(uuid);
  }

  forward(): void {
    const uuid = this.history.forward();
    if (uuid !== null) void this.openWithoutHistory(uuid);
  }

  private async openWithoutHistory(uuid: string): Promise<void> {
    const saved = this.history;
    const push = saved.push.bind(saved);
    saved.push = () => undefined;
    try {
      await this.open(uuid);
    } finally {
      saved.push = push;
    }
  }

  async openThread(root: string): Promise<void> {
    const sync = this.sync;
    const open = sync?.openUuid ?? null;
    if (sync === null || open === null) return;
    const promise = sync.openThread(open, root);
    this.renderThread();
    try {
      await promise;
    } catch (error) {
      this.handleError(error);
    }
    this.renderThread();
    this.threadSlot.querySelector<HTMLElement>('.thread .msgs')?.focus({ preventScroll: true });
  }

  closeThread(): boolean {
    const sync = this.sync;
    if (sync === null || sync.threadRoot === null) return false;
    const root = sync.threadRoot;
    sync.closeThread();
    this.renderThread();
    this.list.querySelector<HTMLElement>(`[data-uuid="${root}"]`)?.focus();
    return true;
  }

  /** Keys while the chat is shown (the shell routes them here). Returns whether it handled the key. */
  onKey(event: KeyboardEvent): boolean {
    if (!this.connected) return false;
    const mod = event.ctrlKey || event.metaKey;
    if (event.altKey && !mod && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      this.stepConversation(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
      return true;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'j') {
      this.jumpUnread();
      return true;
    }
    if (mod && event.key === '[') {
      this.back();
      return true;
    }
    if (mod && event.key === ']') {
      this.forward();
      return true;
    }
    if (event.key === 'Escape' && !mod) {
      if (this.closeThread()) return true;
      if (this.openUuid() !== null) {
        void this.leave();
        return true;
      }
    }
    return false;
  }

  // ---- sync events --------------------------------------------------------------------------------------------------

  private changed(scope: 'list' | 'messages' | 'thread'): void {
    if (scope === 'list') {
      this.renderSide();
      this.renderHead();
      const store = this.sync?.store;
      if (store !== undefined) this.deps.onUnread(store.badgeCount(this.clock.now()), store.unreadTotalCapped);
    } else if (scope === 'messages') {
      this.renderMessages();
      this.scheduleRead();
    } else this.renderThread();
  }

  private arrived(count: number, author: string | null): void {
    if (!this.atBottom()) {
      this.newBelow += count;
      this.renderPill();
    }
    if (author !== null) this.deps.announce(count === 1 ? this.t('arrivedOne', { author }) : this.t('arrived', { count, author }));
  }

  private handleError(error: unknown): void {
    if (error instanceof ApiError && error.status === 404) this.error = this.t('errorNotFound');
    else if (error instanceof ApiError && error.status !== 401 && error.status !== 429 && !error.isNetwork && error.status !== 0) this.error = this.t('errorGeneric');
    this.renderBanner();
  }

  // ---- read marks ---------------------------------------------------------------------------------------------------

  private scheduleRead(): void {
    if (this.readTimer !== null) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      const open = this.openUuid();
      if (open !== null && this.shown && this.atBottom()) void this.sync?.markRead(open).catch(() => undefined);
    }, 600);
  }

  // ---- scrolling ----------------------------------------------------------------------------------------------------

  private atBottom(): boolean {
    return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 48;
  }

  private onScroll(): void {
    this.stick = this.atBottom();
    if (this.stick && this.newBelow > 0) {
      this.newBelow = 0;
      this.renderPill();
      this.scheduleRead();
    }
    const open = this.openUuid();
    if (open !== null && this.scroller.scrollTop < 240 && !this.loadingOlder) {
      const timeline = this.sync?.store.timeline(open);
      if (timeline?.hasMore === true) {
        this.loadingOlder = true;
        void this.sync
          ?.loadOlder(open)
          .catch((error: unknown) => this.handleError(error))
          .finally(() => {
            this.loadingOlder = false;
          });
      }
    }
  }

  private scrollToBottom(focus = false): void {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.stick = true;
    this.newBelow = 0;
    this.renderPill();
    this.scheduleRead();
    if (focus) this.list.querySelector<HTMLElement>('li.msg:last-of-type')?.focus({ preventScroll: true });
  }

  // ---- rendering ----------------------------------------------------------------------------------------------------

  render(): void {
    this.root.dataset.state = this.connected ? 'connected' : 'disconnected';
    if (!this.connected) {
      this.root.replaceChildren(this.renderConnect());
      return;
    }
    if (this.root.firstChild !== this.side) this.root.replaceChildren(this.side, this.main, this.threadSlot);
    this.renderSide();
    this.renderHead();
    this.renderBanner();
    this.renderMessages();
    this.renderFoot();
    this.renderThread();
  }

  private renderConnect(): HTMLElement {
    const t = this.t;
    const state = this.connect;
    const body: Child[] = [];
    if (state.kind === 'code') {
      body.push(
        h('p', { class: 'cc-wait', attrs: { role: 'status' } }, t('connectWaiting')),
        h('div', { class: 'cc-code' }, h('span', { class: 'cc-code-label' }, t('connectCode')), h('output', { class: 'cc-code-value', id: 'chat-user-code' }, state.userCode)),
        h(
          'div',
          { class: 'cc-row' },
          this.button('btn primary', t('connectOpen'), () => this.deps.openVerification(state.url), 'chat-open-approval'),
          this.button('btn', t('connectCopy'), () => void this.deps.copy(state.userCode.replace('-', ''))),
          this.button('btn-ghost', t('connectCancel'), () => this.cancelConnect(), 'chat-cancel'),
        ),
      );
    } else {
      if (state.kind === 'idle' && state.message !== null) body.push(h('p', { class: 'cc-error', attrs: { role: 'alert' } }, state.message));
      body.push(h('div', { class: 'cc-row' }, this.button('btn primary', t('connectButton'), () => void this.connectChat(), 'chat-connect', state.kind === 'starting')));
    }
    return h(
      'section',
      { class: 'connect-card', id: 'chat-connect-card', attrs: { 'aria-labelledby': 'chat-connect-title' } },
      h('span', { class: 'cc-ico', attrs: { 'aria-hidden': 'true' } }, chatIcon('chat', 'lg')),
      h('h1', { id: 'chat-connect-title' }, t('connectTitle')),
      h('p', { class: 'cc-text' }, t('connectText')),
      h('p', { class: 'cc-points' }, t('connectPoints')),
      ...body,
    );
  }

  private button(className: string, label: string, onClick: () => void, id?: string, disabled = false): HTMLButtonElement {
    const button = h('button', { class: className, id, attrs: { type: 'button', disabled: disabled || undefined } }, label);
    button.addEventListener('click', onClick);
    return button;
  }

  private contextName(): string {
    return this.me?.contexts.find((item) => item.key === this.context)?.label ?? this.t('moduleChat');
  }

  private convIcon(row: Conversation, size: '' | 'sm' = 'sm'): Element {
    if (row.kind === 'direct') {
      return h('span', { class: `av s22 ${avatarHue(row.uuid)}`, attrs: { 'aria-hidden': 'true' } }, row.initials, presence(row.peerStatus));
    }
    const name: ChatIconName = row.kind === 'support' ? 'headset' : sectionOf(row) === 'projects' ? 'folder' : 'hash';
    return chatIcon(name, size);
  }

  /** Read before the name by screen readers (the name itself is the visible text, WCAG 2.5.3). */
  private convKind(row: Conversation): string {
    const t = this.t;
    return row.kind === 'direct' ? t('kindDirect') : row.kind === 'support' ? t('kindSupport') : sectionOf(row) === 'projects' ? t('kindProject') : t('kindChannel');
  }

  /** Unread and muted, after the name (not by colour or weight alone). */
  private convSuffix(row: Conversation): string {
    const parts: string[] = [];
    if (row.unread > 0 && row.uuid !== this.openUuid()) parts.push(this.t('convUnread', { count: row.unread }));
    if (isMuted(row, this.clock.now())) parts.push(this.t('convMuted'));
    return parts.length === 0 ? '' : `, ${parts.join(', ')}`;
  }

  private renderSide(): void {
    const t = this.t;
    const sync = this.sync;
    if (sync === null) return;
    const store = sync.store;
    const open = sync.openUuid;
    const nodes: Child[] = [];
    nodes.push(
      h(
        'div',
        { class: 'side-head' },
        h('h2', { id: 'chat-side-title' }, this.contextName()),
        this.iconButton('side-icon', 'search', t('searchConversations'), () => this.root.dispatchEvent(new CustomEvent('chat-switcher', { bubbles: true })), 'chat-search'),
      ),
    );
    const anyUnread = store.conversations().some((row) => row.unread > 0 && row.uuid !== open && !isMuted(row, this.clock.now()));
    const jump = h('button', { class: 'jump', id: 'chat-jump', attrs: { type: 'button', disabled: !anyUnread || undefined, 'aria-keyshortcuts': 'Control+J Meta+J' } }, chatIcon('down', 'sm'), h('span', {}, anyUnread ? t('jumpUnread') : t('caughtUp')), h('kbd', {}, `${modKey()} J`));
    jump.addEventListener('click', () => this.jumpUnread());
    nodes.push(jump);
    const scroll = h('nav', { class: 'side-scroll', attrs: { 'aria-labelledby': 'chat-side-title' } });
    if (!store.loaded) {
      scroll.append(skeletonRows(8));
    } else if (store.conversations().length === 0) {
      scroll.append(h('p', { class: 'side-empty' }, t('emptyContext', { name: this.contextName() })));
    }
    for (const section of store.sections()) {
      const collapsed = this.prefs.collapsed[section.id] === true;
      const listId = `sec-${section.id}`;
      const toggle = h('button', { class: 'sec-h', key: `sec-${section.id}`, attrs: { type: 'button', 'aria-expanded': collapsed ? 'false' : 'true', 'aria-controls': listId } }, chatIcon('chev', 'xs'), t(SECTION_LABEL[section.id]));
      toggle.addEventListener('click', () => {
        this.prefs.collapsed[section.id] = !collapsed;
        this.savePrefs();
        this.renderSide();
        this.side.querySelector<HTMLElement>(`[data-key="sec-${section.id}"]`)?.focus();
      });
      const ul = h('ul', { id: listId });
      for (const row of section.conversations) {
        const unread = row.unread > 0 && row.uuid !== open;
        if (collapsed && !unread && row.uuid !== open) continue;
        const muted = isMuted(row, this.clock.now());
        const button = h(
          'button',
          {
            class: `conv${unread && !muted ? ' unread' : ''}${muted ? ' muted' : ''}`,
            attrs: { type: 'button', 'data-conv': row.uuid, 'aria-current': row.uuid === open ? 'true' : 'false' },
          },
          h('span', { class: 'c-ico' }, this.convIcon(row)),
          h('span', { class: 'sr-only' }, `${this.convKind(row)} `),
          h('span', { class: 'c-name' }, row.title),
          h('span', { class: 'sr-only' }, this.convSuffix(row)),
          row.ticketStatus !== null ? h('span', { class: 'sup' }, row.ticketStatus) : null,
          muted ? chatIcon('bell-off', 'xs') : null,
          unread ? h('span', { class: `badge${muted ? ' soft' : ''}`, attrs: { 'aria-hidden': 'true' } }, row.unread > 99 ? '99+' : String(row.unread)) : null,
        );
        button.addEventListener('click', () => void this.open(row.uuid));
        ul.append(h('li', {}, button));
      }
      scroll.append(h('div', { class: 'sec' }, toggle, ul));
    }
    if (store.nextCursor !== null) {
      const more = h('button', { class: 'sec-more', attrs: { type: 'button' } }, t('loadMore'));
      more.addEventListener('click', () => void sync.loadMoreConversations().catch((error: unknown) => this.handleError(error)));
      scroll.append(more);
    }
    nodes.push(scroll);
    const foot = h('div', { class: 'side-foot', id: 'chat-side-foot' });
    nodes.push(foot);
    const timer = this.deps.sidebarTimer();
    if (timer !== null) nodes.push(timer);
    const active = document.activeElement;
    const key = active instanceof HTMLElement && this.side.contains(active) ? (active.dataset.conv ?? active.dataset.key ?? active.id) : null;
    this.side.replaceChildren(...(nodes.filter(Boolean) as Node[]));
    if (key !== null && key !== '') (this.side.querySelector<HTMLElement>(`[data-conv="${key}"], [data-key="${key}"], [id="${key}"]`))?.focus({ preventScroll: true });
    this.renderSideFoot();
  }

  private renderSideFoot(): void {
    const foot = this.side.querySelector('#chat-side-foot');
    if (foot === null) return;
    const t = this.t;
    const [dot, text] =
      this.netState === 'offline'
        ? ['off', t('statusOffline')]
        : this.netState === 'limited'
          ? ['warn', t('statusLimited')]
          : this.mode === 'live'
            ? ['ok', t('statusLive')]
            : this.wasLive
              ? ['warn', t('statusReconnecting')]
              : ['ok', t('statusPolling')];
    foot.replaceChildren(h('span', { class: `dot ${dot}`, attrs: { 'aria-hidden': 'true' } }), h('span', {}, text));
  }

  private iconButton(className: string, name: ChatIconName, label: string, onClick: () => void, id?: string): HTMLButtonElement {
    const button = h('button', { class: className, id, attrs: { type: 'button', 'aria-label': label, title: label } }, chatIcon(name));
    button.addEventListener('click', onClick);
    return button;
  }

  private renderHead(): void {
    const t = this.t;
    const row = this.sync?.store.conversation(this.openUuid()) ?? null;
    if (row === null) {
      this.head.replaceChildren();
      this.head.hidden = true;
      return;
    }
    this.head.hidden = false;
    const back = this.iconButton('btn-ghost ch-back', 'chev-l', t('back'), () => void this.leave());
    const open = this.iconButton('btn-ghost', 'external', t('openInBeacon'), () => this.openInBeacon(row.uuid), 'chat-open-beacon');
    this.head.replaceChildren(
      back,
      h('div', { class: 'ch-title' }, h('h1', { id: 'chat-title' }, this.convIcon(row, ''), h('span', {}, row.title)), row.subtitle !== '' ? h('span', { class: 'ch-topic' }, row.subtitle) : null),
      h('div', { class: 'ch-tools' }, row.membersCount !== undefined ? h('span', { class: 'members' }, chatIcon('users', 'sm'), String(row.membersCount)) : null, open),
    );
    this.scroller.setAttribute('aria-label', t('messagesIn', { title: row.title }));
  }

  private openInBeacon(uuid: string): void {
    const server = this.deps.server();
    if (server !== null) void this.deps.host.openLink(`${server}/dashboard?chat=${uuid}`).catch(() => undefined);
  }

  /** Slim, non-blocking: realtime lost (after it was live) or offline; never for a 429 (quiet backoff). */
  private renderBanner(): void {
    const t = this.t;
    let text: string | null = null;
    if (this.netState === 'offline') text = t('bannerOffline');
    else if (this.wasLive && this.mode === 'polling') text = t('bannerReconnecting');
    const nodes: Child[] = [];
    if (text !== null) nodes.push(h('span', { class: 'cb-text' }, text));
    if (this.error !== null) {
      const retry = this.button('btn sm', t('retry'), () => {
        this.error = null;
        this.renderBanner();
        void this.sync?.poll();
      });
      nodes.push(h('span', { class: 'cb-text' }, this.error), retry);
    }
    this.banner.replaceChildren(...(nodes.filter(Boolean) as Node[]));
    this.banner.hidden = nodes.length === 0;
  }

  private renderFoot(): void {
    const open = this.openUuid();
    this.foot.hidden = open === null;
    if (open === null) return;
    this.foot.replaceChildren(h('p', { class: 'readonly-note' }, chatIcon('lock', 'xs'), this.t('readOnlyNote')));
  }

  private renderPill(): void {
    this.pill.hidden = this.newBelow === 0;
    this.pill.replaceChildren(chatIcon('down', 'xs'), this.newBelow === 1 ? this.t('newPillOne') : this.t('newPill', { count: this.newBelow }));
  }

  /** The timeline, keeping the reading position (anchor message and its offset) or the bottom. */
  renderMessages(): void {
    const t = this.t;
    const sync = this.sync;
    const open = sync?.openUuid ?? null;
    this.renderHead();
    this.renderFoot();
    this.main.dataset.open = open === null ? 'false' : 'true';
    if (sync === null || open === null) {
      const store = sync?.store;
      const empty =
        store !== undefined && store.loaded && store.conversations().length === 0
          ? emptyState('chat', t('emptyContext', { name: this.contextName() }), t('emptyContextHint'))
          : emptyState('chat', t('emptyPick'), t('emptyPickHint', { keys: `${modKey()} K` }));
      this.list.replaceChildren(h('li', { class: 'empty-li' }, empty));
      this.pill.hidden = true;
      return;
    }
    const timeline = sync.store.timeline(open);
    if (timeline === null) {
      this.list.replaceChildren(...skeletonMessages(6));
      return;
    }
    // Anchor: the first message visible at the top, and how far from the top it is.
    const wasBottom = this.stick;
    const anchor = wasBottom ? null : this.topVisible();
    const anchorOffset = anchor === null ? 0 : anchor.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    const anchorUuid = anchor?.dataset.uuid ?? null;
    const focused = document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>('li.msg')?.dataset.uuid : undefined;
    const row = sync.store.conversation(open);
    const items: Node[] = [];
    if (timeline.hasMore) items.push(...skeletonMessages(2, true));
    else if (row !== null) items.push(h('li', { class: 'conv-start' }, this.convIcon(row, ''), h('span', {}, t('startOfConversation', { title: row.title }))));
    for (const item of rows(timeline.messages, this.dividerAt, this.now(), t, this.deps.locale)) {
      if (item.day !== null) items.push(h('li', { class: 'day-div', attrs: { 'aria-hidden': 'true' } }, h('span', {}, item.day)));
      if (item.firstUnread) items.push(h('li', { class: 'new-div', id: 'new-div', attrs: { 'aria-hidden': 'true' } }, t('newDivider')));
      const node = this.messageItem(item.message, item.continued, false);
      if (item.firstUnread) node.setAttribute('aria-label', `${t('newMessages')}. ${node.getAttribute('aria-label') ?? ''}`);
      items.push(node);
    }
    this.list.replaceChildren(...items);
    this.setRovingStop(this.list, focused);
    if (wasBottom) {
      const divider = this.list.querySelector<HTMLElement>('#new-div');
      // First paint of a conversation with unread messages: start at the divider, else at the bottom.
      if (divider !== null && this.scroller.dataset.conv !== open) this.scroller.scrollTop = Math.max(0, divider.offsetTop - 80);
      else this.scroller.scrollTop = this.scroller.scrollHeight;
    } else if (anchorUuid !== null) {
      const again = this.list.querySelector<HTMLElement>(`li.msg[data-uuid="${anchorUuid}"]`);
      if (again !== null) this.scroller.scrollTop += again.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - anchorOffset;
    }
    this.scroller.dataset.conv = open;
    if (focused !== undefined) this.list.querySelector<HTMLElement>(`li.msg[data-uuid="${focused}"]`)?.focus({ preventScroll: true });
    this.renderPill();
  }

  private topVisible(): HTMLElement | null {
    const top = this.scroller.getBoundingClientRect().top;
    for (const item of this.list.querySelectorAll<HTMLElement>('li.msg')) if (item.getBoundingClientRect().bottom > top) return item;
    return null;
  }

  private time(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(this.deps.locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  }

  private messageItem(message: Message, continued: boolean, inThread: boolean): HTMLElement {
    const t = this.t;
    const time = this.time(message.createdAt);
    const classes = ['msg'];
    if (continued) classes.push('cont');
    if (message.mentionsMe && !message.mine) classes.push('mentioned');
    if (message.kind === 'system') classes.push('system');
    const item = h('li', {
      class: classes.join(' '),
      attrs: {
        tabindex: '-1',
        'data-uuid': message.uuid,
        'data-id': String(message.id),
        'aria-label': t('messageLabel', { author: message.author.name, time: `${dayLabel(message.createdAt, this.now(), t, this.deps.locale)} ${time}` }),
      },
    });
    item.append(
      h(
        'div',
        { class: 'gutter' },
        continued
          ? h('time', { class: 'stamp', attrs: { datetime: message.createdAt } }, time)
          : h('span', { class: `av s36 ${message.author.bot ? 'bot' : avatarHue(message.author.uuid ?? message.author.name)}`, attrs: { 'aria-hidden': 'true' } }, message.author.initials),
      ),
    );
    const column = h('div', { class: 'm-col' });
    if (!continued) {
      column.append(
        h(
          'div',
          { class: 'm-head' },
          h('span', { class: 'm-author' }, message.author.name),
          message.author.bot ? h('span', { class: 'm-tag' }, t('bot')) : null,
          h('time', { class: 'm-time', attrs: { datetime: message.createdAt } }, time),
        ),
      );
    }
    if (message.blocks === null) column.append(h('div', { class: 'm-body deleted' }, t('deleted')));
    else {
      const body = renderBlocks(message.blocks, { t, me: this.me?.user.uuid ?? null, open: (url) => void this.deps.host.openLink(url).catch(() => undefined) });
      if (message.edited) body.append(h('span', { class: 'edited' }, t('edited')));
      column.append(body);
    }
    if (message.reactions.length > 0) {
      column.append(
        h(
          'div',
          { class: 'reacts', attrs: { role: 'group', 'aria-label': t('reactionsReadOnly') } },
          ...message.reactions.map((reaction) =>
            h(
              'span',
              {
                class: reaction.mine ? 'react mine' : 'react',
                attrs: { title: reaction.emoji, role: 'img', 'aria-label': reaction.mine ? t('reactionMine', { emoji: reaction.emoji, count: reaction.count }) : t('reactionLabel', { emoji: reaction.emoji, count: reaction.count }) },
              },
              h('span', { class: 'e', attrs: { 'aria-hidden': 'true' } }, reaction.emoji),
              h('span', { attrs: { 'aria-hidden': 'true' } }, String(reaction.count)),
            ),
          ),
        ),
      );
    }
    if (!inThread && message.thread !== null) {
      const count = message.thread.count === 1 ? t('reply') : t('replies', { count: message.thread.count });
      const link = h(
        'button',
        { class: 'thread-link', attrs: { type: 'button' } },
        chatIcon('thread', 'sm'),
        h('span', {}, count),
        h('span', { class: 'sr-only' }, `, ${t('thread')}`),
        message.thread.lastReplyAt !== null ? h('span', { class: 'tl-meta' }, t('lastReply', { time: this.time(message.thread.lastReplyAt) })) : null,
      );
      link.addEventListener('click', () => void this.openThread(message.uuid));
      column.append(link);
    }
    item.append(column);
    return item;
  }

  private setRovingStop(list: HTMLElement, focused: string | undefined): void {
    const items = [...list.querySelectorAll<HTMLElement>('li.msg')];
    const stop = items.find((item) => item.dataset.uuid === focused) ?? items[items.length - 1];
    for (const item of items) item.tabIndex = item === stop ? 0 : -1;
  }

  private roving(event: FocusEvent, list: HTMLElement): void {
    const item = (event.target as HTMLElement).closest?.('li.msg');
    if (!(item instanceof HTMLElement) || item.parentElement !== list) return;
    for (const other of list.querySelectorAll<HTMLElement>('li.msg')) other.tabIndex = other === item ? 0 : -1;
  }

  private onMessageKey(event: KeyboardEvent, list: HTMLElement): void {
    const item = (event.target as HTMLElement).closest?.('li.msg');
    if (!(item instanceof HTMLElement) || event.target !== item || event.altKey || event.ctrlKey || event.metaKey) return;
    const items = [...list.querySelectorAll<HTMLElement>('li.msg')];
    const index = items.indexOf(item);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = items[index + 1];
    else if (event.key === 'ArrowUp') next = items[index - 1];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    else if ((event.key === 'Enter' || event.key.toLowerCase() === 'r') && list === this.list) {
      const link = item.querySelector<HTMLButtonElement>('.thread-link');
      if (link !== null) {
        event.preventDefault();
        link.click();
      }
      return;
    } else return;
    event.preventDefault();
    if (next !== undefined) {
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Right-click on a message: Copy text, Copy link, Open thread (the webview's own menu is off in the app). */
  private onContextMenu(event: MouseEvent): void {
    const item = (event.target as HTMLElement).closest?.('li.msg');
    if (!(item instanceof HTMLElement) || this.sync === null) return;
    const open = this.openUuid();
    const message = this.sync.store.timeline(open)?.messages.find((entry) => entry.uuid === item.dataset.uuid);
    if (message === undefined || open === null) return;
    event.preventDefault();
    const t = this.t;
    const server = this.deps.server();
    const entries: [string, () => void][] = [[t('copyText'), () => void this.deps.copy(plainText(message.blocks, 4000))]];
    if (server !== null) entries.push([t('copyLink'), () => void this.deps.copy(`${server}/dashboard?chat=${open}&message=${message.uuid}`)]);
    if (message.thread !== null) entries.push([t('openThread', { count: message.thread.count === 1 ? t('reply') : t('replies', { count: message.thread.count }) }), () => void this.openThread(message.uuid)]);
    showMenu(event.clientX, event.clientY, entries, item);
  }

  private renderThread(): void {
    const t = this.t;
    const sync = this.sync;
    const root = sync?.threadRoot ?? null;
    this.root.classList.toggle('thread-open', root !== null);
    if (sync === null || root === null) {
      this.threadSlot.replaceChildren();
      return;
    }
    const page = sync.store.thread(root);
    const row = sync.store.conversation(sync.openUuid);
    const panel = h('aside', { class: 'thread', id: 'thread', attrs: { 'aria-labelledby': 'thread-title' } });
    panel.style.width = `${this.prefs.threadWidth}px`;
    const handle = h('div', { class: 'th-resize', attrs: { role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': t('resizeThread'), 'aria-valuemin': String(THREAD_MIN), 'aria-valuemax': String(THREAD_MAX), 'aria-valuenow': String(this.prefs.threadWidth) } });
    this.wireResize(handle, panel);
    const close = this.iconButton('x-btn', 'x', t('closeThread'), () => this.closeThread(), 'thread-close');
    close.title = `${t('closeThread')} (Esc)`;
    const head = h(
      'div',
      { class: 'th-head' },
      h('h2', { id: 'thread-title' }, t('thread')),
      h('span', { class: 'sub' }, row?.title ?? ''),
      page !== null ? h('span', { class: 'pill following' }, chatIcon('thread', 'xs'), t('following')) : null,
      close,
    );
    const scroller = h('div', { class: 'msgs', attrs: { tabindex: '-1', role: 'region', 'aria-labelledby': 'thread-title' } });
    if (page === null) {
      scroller.append(h('ul', { class: 'msg-list' }, ...skeletonMessages(3)));
    } else {
      const pinned = h('div', { class: 'th-root' }, h('ul', { class: 'msg-list', attrs: { role: 'list' } }, this.messageItem(page.root, false, true)));
      const count = page.replyCount === 0 ? t('noReplies') : page.replyCount === 1 ? t('reply') : t('replies', { count: page.replyCount });
      const list = h('ul', { class: 'msg-list', attrs: { role: 'list' } });
      for (const item of rows(page.replies, null, this.now(), t, this.deps.locale)) list.append(this.messageItem(item.message, item.continued, true));
      list.addEventListener('keydown', (event) => this.onMessageKey(event, list));
      list.addEventListener('focusin', (event) => this.roving(event, list));
      this.setRovingStop(list, undefined);
      scroller.append(list);
      panel.append(handle, head, pinned, h('div', { class: 'th-count', attrs: { role: 'presentation' } }, count), scroller);
      this.threadSlot.replaceChildren(panel);
      return;
    }
    panel.append(handle, head, scroller);
    this.threadSlot.replaceChildren(panel);
  }

  private wireResize(handle: HTMLElement, panel: HTMLElement): void {
    const set = (width: number) => {
      this.prefs.threadWidth = Math.round(Math.min(Math.max(width, THREAD_MIN), THREAD_MAX));
      panel.style.width = `${this.prefs.threadWidth}px`;
      handle.setAttribute('aria-valuenow', String(this.prefs.threadWidth));
    };
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const start = this.prefs.threadWidth;
      handle.setPointerCapture?.(event.pointerId);
      const move = (moved: PointerEvent) => set(start + (startX - moved.clientX));
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.savePrefs();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      set(this.prefs.threadWidth + (event.key === 'ArrowLeft' ? 24 : -24));
      this.savePrefs();
    });
  }

  /** `onlyIfStored`: update what is there, never write a fresh entry (sign-out after "Clear local data" stays clear). */
  private savePrefs(onlyIfStored = false): void {
    try {
      if (onlyIfStored && this.deps.storage?.getItem(PREFS_KEY) === null) return;
      this.deps.storage?.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // Storage unavailable: the view still works, it just does not remember.
    }
  }
}

function modKey(): string {
  return /mac/i.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl';
}

const HUES = 9;
/** A stable avatar colour class from an id. */
export function avatarHue(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hue-${hash % HUES}`;
}

function presence(status: string | null): Child {
  if (status === null || status === 'offline') return null;
  return h('span', { class: `pr ${status === 'online' ? 'active' : status === 'busy' || status === 'dnd' ? 'dnd' : 'away'}` });
}

function emptyState(icon: ChatIconName, title: string, hint: string): HTMLElement {
  return h('div', { class: 'empty' }, h('span', { class: 'e-ico', attrs: { 'aria-hidden': 'true' } }, chatIcon(icon, 'lg')), h('b', {}, title), h('span', {}, hint));
}

/** Skeleton rows shaped like conversations. */
function skeletonRows(count: number): HTMLElement {
  return h('div', { class: 'skel-rows', attrs: { 'aria-hidden': 'true' } }, ...Array.from({ length: count }, (_, i) => h('span', { class: 'skel-row', attrs: { style: `--w:${55 + ((i * 17) % 35)}%` } })));
}

/** Skeleton messages shaped like the timeline (avatar, name, two lines). */
function skeletonMessages(count: number, older = false): HTMLElement[] {
  return Array.from({ length: count }, (_, i) =>
    h('li', { class: `skel-msg${older ? ' older' : ''}`, attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'skel av' }), h('span', { class: 'skel-lines' }, h('span', { class: 'skel l1' }), h('span', { class: 'skel l2', attrs: { style: `--w:${50 + ((i * 23) % 40)}%` } }))),
  );
}

/** A small menu at the pointer (role menu, arrow keys, Esc returns focus). */
export function showMenu(x: number, y: number, entries: [string, () => void][], back: HTMLElement): HTMLElement {
  document.querySelector('.ctx-menu')?.remove();
  const menu = h('div', { class: 'menu ctx-menu', attrs: { role: 'menu' } });
  const close = () => {
    menu.remove();
    back.focus({ preventScroll: true });
  };
  for (const [label, run] of entries) {
    const item = h('button', { attrs: { type: 'button', role: 'menuitem', tabindex: '-1' } }, label);
    item.addEventListener('click', () => {
      close();
      run();
    });
    menu.append(item);
  }
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  menu.addEventListener('focusout', (event) => {
    if (!menu.contains(event.relatedTarget as Node | null)) menu.remove();
  });
  menu.style.left = `${Math.min(x, (globalThis.innerWidth || 800) - 240)}px`;
  menu.style.top = `${Math.min(y, (globalThis.innerHeight || 600) - 40 * entries.length - 16)}px`;
  document.body.append(menu);
  menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  return menu;
}
