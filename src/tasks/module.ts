/**
 * The Tasks module (BD-3b, `BEACON_DESKTOP_TASKS.md` §9, approved prototype): connect card and chained device flow
 * (`tasks` family), My tasks, boards (kanban and list), the task detail panel, quick add, field edits, moves with
 * `If-Match`, checklists, starting a timer from a task, and polling through `GET changes`.
 *
 * Rules: data in memory only (cleared on a context switch, disconnect and sign-out); the server decides every change
 * (an optimistic move goes back on `409 conflict` or `403 transition_refused`); `403 module_forbidden` (TaskBoard 3.5)
 * hides the module and keeps the token; `401` disconnects tasks only. Polling (design §7.3): the open board or task every
 * 20 s while shown, My tasks every 60 s, 5 min in the background; backoff on errors, `Retry-After` honoured.
 */
import { ApiError, type TimeTrackApi } from '../api/client';
import { renderBlocks } from '../chat/body';
import type { ChatText } from '../chat/i18n';
import { chatIcon } from '../chat/icons';
import { realClock, type SyncClock } from '../chat/sync';
import { DeviceFlowError, runDeviceFlow } from '../lib/deviceFlow';
import type { TasksHost } from '../platform';
import { type Child, h, patch } from '../ui/dom';
import { isModuleForbidden, TasksApi, TasksApiError, type TaskFields } from './api';
import { apiToDateInput, dateInputToApi, dueInfo, duration, groupMine, localDate, parseQuickAdd, priorityLabel, taskRef } from './format';
import type { TasksText } from './i18n';
import { type Board, type Column, isId, PRIORITIES, type Priority, type TaskCard, type TaskDetail, type TasksMe, type Comment } from './types';

export type TasksView = 'mine' | 'board' | 'list';
export type Markers = 'emoji' | 'dots';

export interface TaskTimerRef {
  id: string;
  title: string;
  boardTitle: string | null;
  url: string | null;
}

export interface TasksModuleDeps {
  t: TasksText;
  /** The chat body renderer's strings (mentions, "Content not visible"). */
  chatT: ChatText;
  locale: string;
  host: TasksHost;
  fetchImpl: typeof fetch;
  timeApi(): TimeTrackApi | null;
  server(): string | null;
  openVerification(url: string): void;
  openLink(url: string): void;
  copy(text: string): Promise<void>;
  announce(text: string): void;
  /** The app's context (`personal`, `org:<uuid>`) and its label. */
  context(): string | null;
  contextLabel(): string;
  onConnection(connected: boolean): void;
  /** `403 module_forbidden`: hide (true) or show (false) the module; the token is kept. */
  onForbidden(forbidden: boolean): void;
  startTimer(task: TaskTimerRef): Promise<void>;
  stopTimer(): Promise<void>;
  runningTaskId(): string | null;
  markers(): Markers;
  storage?: Storage;
  clock?: SyncClock;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

type ConnectState = { kind: 'idle'; message: string | null } | { kind: 'starting' } | { kind: 'code'; userCode: string; url: string };

/** Device-local view settings (no task data): view, last board per context, "Only mine". */
interface ViewPrefs {
  view: TasksView;
  board: Record<string, string>;
  onlyMine: boolean;
}

const PREFS_KEY = 'beacon-desktop-tasks-view';
export const POLL_SHOWN_MS = 20_000;
export const POLL_MINE_MS = 60_000;
export const POLL_HIDDEN_MS = 300_000;
const BACKOFF_MAX_MS = 600_000;

function loadPrefs(storage: Storage | undefined): ViewPrefs {
  const fallback: ViewPrefs = { view: 'mine', board: {}, onlyMine: false };
  try {
    const raw = JSON.parse(storage?.getItem(PREFS_KEY) ?? 'null') as Partial<ViewPrefs> | null;
    if (raw === null || typeof raw !== 'object') return fallback;
    const board: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.board ?? {})) if (isId(value)) board[key] = value;
    return { view: raw.view === 'board' || raw.view === 'list' ? raw.view : 'mine', board, onlyMine: raw.onlyMine === true };
  } catch {
    return fallback;
  }
}

interface ColumnPage {
  tasks: TaskCard[];
  nextCursor: string | null;
}

export class TasksModule {
  readonly root: HTMLElement;
  connected = false;
  /** `403 module_forbidden`: the module is hidden, the token kept. */
  forbidden = false;
  me: TasksMe | null = null;
  api: TasksApi | null = null;
  connect: ConnectState = { kind: 'idle', message: null };
  prefs: ViewPrefs;
  boards: Board[] = [];
  boardsLoaded = false;
  /** Board details (columns, people) by id, for the current context. */
  readonly boardDetails = new Map<string, Board>();
  readonly columns = new Map<string, ColumnPage>();
  listTasks: TaskCard[] = [];
  mine: TaskCard[] = [];
  review: TaskCard[] = [];
  mineLoaded = false;
  detail: TaskDetail | null = null;
  comments: Comment[] | null = null;
  error: string | null = null;
  notice: string | null = null;
  offline = false;
  contextRefused = false;
  private shown = false;
  private cursor: string | null = null;
  private pollTimer: unknown = null;
  private failures = 0;
  private pausedUntil = 0;
  private generation = 0;
  private abort: AbortController | null = null;
  private noticeTimer: unknown = null;
  private readonly clock: SyncClock;
  private readonly page: HTMLElement;
  private readonly head: HTMLElement;
  private readonly extras: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly body: HTMLElement;
  private readonly drawerSlot: HTMLElement;
  private readonly quickInput: HTMLInputElement;
  private readonly quickPreview: HTMLElement;
  private readonly quickHelp: HTMLElement;
  private readonly toolbar: HTMLElement;
  /** A card picked up with the keyboard or the mouse. */
  private dragging: string | null = null;

  constructor(private readonly deps: TasksModuleDeps) {
    this.clock = deps.clock ?? realClock;
    this.prefs = loadPrefs(deps.storage);
    const t = deps.t;
    this.head = h('div', { class: 'pg-head', id: 'tasks-head' });
    this.quickInput = h('input', { id: 'qa-input', attrs: { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('quickAddLabel'), 'aria-describedby': 'qa-help', 'aria-keyshortcuts': 'N', placeholder: t('quickAdd') } });
    this.quickPreview = h('div', { class: 'qa-preview', attrs: { 'aria-hidden': 'true' } });
    this.quickHelp = h('span', { class: 'sr-only', id: 'qa-help' });
    this.quickInput.addEventListener('input', () => this.renderQuickPreview());
    this.quickInput.addEventListener('keydown', (event) => this.onQuickKey(event));
    this.extras = h('div', { class: 'tb-extras' });
    this.toolbar = h('div', { class: 'toolbar', id: 'tasks-toolbar' }, h('div', { class: 'qa' }, h('span', { class: 'qa-ico', attrs: { 'aria-hidden': 'true' } }, chatIcon('plus', 'sm')), this.quickInput, this.quickPreview, h('kbd', { attrs: { 'aria-hidden': 'true' } }, 'N'), this.quickHelp), this.extras);
    this.banner = h('div', { class: 'tk-banner', id: 'tasks-banner', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.body = h('div', { class: 'tk-body', id: 'tasks-body' });
    this.page = h('div', { class: 'page' }, this.head, this.toolbar, this.banner, this.body);
    this.drawerSlot = h('div', { class: 'drawer-slot', id: 'tasks-drawer' });
    this.root = h('div', { class: 'tasks-mod', id: 'tasks-root' }, this.page, this.drawerSlot);
  }

  private get t(): TasksText {
    return this.deps.t;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private today(): string {
    return localDate(this.now());
  }

  // ---- connection ---------------------------------------------------------------------------------------------------

  async init(): Promise<void> {
    const server = this.deps.server();
    const token = server === null ? null : await this.deps.host.token();
    if (server === null || token === null) {
      this.setDisconnected(null);
      return;
    }
    await this.start(server, token);
  }

  private async start(server: string, token: string): Promise<void> {
    this.connected = true;
    this.forbidden = false;
    this.deps.onConnection(true);
    this.api = new TasksApi({ baseUrl: server, token, context: this.deps.context() ?? 'personal', fetchImpl: this.deps.fetchImpl, imageLabel: this.t('imageHidden') });
    this.render();
    await this.reload();
  }

  private setDisconnected(message: string | null): void {
    this.stopPolling();
    this.clearData();
    this.api = null;
    this.me = null;
    this.connected = false;
    this.forbidden = false;
    this.connect = { kind: 'idle', message };
    this.deps.onConnection(false);
    this.deps.onForbidden(false);
    this.render();
  }

  private clearData(): void {
    this.generation += 1;
    this.boards = [];
    this.boardsLoaded = false;
    this.boardDetails.clear();
    this.columns.clear();
    this.listTasks = [];
    this.mine = [];
    this.review = [];
    this.mineLoaded = false;
    this.detail = null;
    this.comments = null;
    this.cursor = null;
    this.error = null;
    this.contextRefused = false;
  }

  /** "Disconnect tasks" (Settings): the tasks token only; time and chat stay. */
  async disconnect(): Promise<void> {
    await this.deps.host.disconnect();
    this.setDisconnected(null);
  }

  /** Sign-out of the whole app: Rust already deleted every token; forget everything in memory. */
  signedOut(): void {
    this.abort?.abort();
    this.setDisconnected(null);
  }

  private async lostAuthorization(): Promise<void> {
    await this.deps.host.disconnect().catch(() => undefined);
    this.setDisconnected(this.t('disconnected'));
  }

  /** "Connect tasks": chained device flow for the `tasks` family (TimeTrackBundle 2.2 scope families). */
  async connectTasks(): Promise<void> {
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
        { deviceCode: (clientName) => api.tasksDeviceCode(clientName), deviceToken: (code) => api.deviceToken(code) },
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
      this.connect = { kind: 'idle', message: null };
      this.deps.announce(this.t('connectDone'));
      await this.start(server, token);
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
    this.root.querySelector<HTMLElement>('#tasks-connect')?.focus();
  }

  // ---- context, visibility, polling ---------------------------------------------------------------------------------

  /** The app switched context: memory cleared, the view loaded there. */
  async switchContext(): Promise<void> {
    if (this.api === null) return;
    this.api.setContext(this.deps.context() ?? 'personal');
    this.clearData();
    this.render();
    await this.reload();
  }

  setShown(shown: boolean): void {
    const was = this.shown;
    this.shown = shown;
    if (shown && !was && this.connected && !this.forbidden) void this.poll();
    else this.schedulePoll();
  }

  /** Runs one API call: `401` disconnects tasks, `module_forbidden` hides the module, `429` pauses, others go up. */
  private async call<T>(work: (api: TasksApi) => Promise<T>): Promise<T> {
    const api = this.api;
    if (api === null) throw new ApiError(401, 'invalid_token', 'Tasks are not connected.');
    try {
      const result = await work(api);
      if (this.offline || this.failures > 0) {
        this.offline = false;
        this.failures = 0;
        this.renderBanner();
      }
      return result;
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) void this.lostAuthorization();
        else if (isModuleForbidden(error)) this.setForbidden(true);
        else if (error.status === 403 && error.code === 'context_forbidden') {
          this.contextRefused = true;
          this.render();
        } else if (error.status === 429) {
          this.pausedUntil = this.clock.now() + (error.retryAfter ?? 30) * 1000;
          this.showNotice(this.t('rateLimited'));
        } else if (error.isNetwork || error.status >= 500) {
          this.failures += 1;
          this.offline = error.isNetwork;
          this.renderBanner();
        }
      }
      throw error;
    }
  }

  private setForbidden(forbidden: boolean): void {
    if (this.forbidden === forbidden) return;
    this.forbidden = forbidden;
    if (forbidden) this.stopPolling();
    this.deps.onForbidden(forbidden);
    this.render();
  }

  /** Loads `me` and the current view (and the open task); keeps what is shown until the answers arrive. */
  async reload(): Promise<void> {
    const generation = this.generation;
    try {
      this.me = await this.call((api) => api.me());
      if (generation !== this.generation) return;
      this.setForbidden(false);
      this.contextRefused = false;
      await this.loadView();
      if (this.cursor === null) {
        const first = await this.call((api) => api.changes(null, 1));
        if (generation === this.generation) this.cursor = first.nextCursor;
      }
      this.error = null;
    } catch (error) {
      if (!(error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 429)) && generation === this.generation) this.error = this.t('errorGeneric');
    }
    this.render();
    this.schedulePoll();
  }

  private async loadView(): Promise<void> {
    const generation = this.generation;
    if (this.prefs.view === 'mine') {
      const today = this.today();
      const [mine, review] = await Promise.all([this.call((api) => api.myTasks('all', today)), this.call((api) => api.myTasks('review', today))]);
      if (generation !== this.generation) return;
      this.mine = mine.tasks;
      this.review = review.tasks;
      this.mineLoaded = true;
      if (!this.boardsLoaded) await this.loadBoards();
    } else {
      await this.loadBoards();
      const board = this.currentBoard();
      if (board === null) return;
      const detail = await this.call((api) => api.board(board.id));
      if (generation !== this.generation || detail === null) return;
      this.boardDetails.set(detail.id, detail);
      const assignee = this.prefs.onlyMine ? ('me' as const) : undefined;
      if (this.prefs.view === 'board') {
        const pages = await Promise.all(detail.columns.map((column) => this.call((api) => api.boardTasks(detail.id, { column: column.id, limit: this.me?.limits.columnPageSize ?? 30, assignee }))));
        if (generation !== this.generation) return;
        this.columns.clear();
        detail.columns.forEach((column, index) => this.columns.set(column.id, pages[index]));
      } else {
        const page = await this.call((api) => api.boardTasks(detail.id, { sort: 'position', limit: 100, assignee }));
        if (generation !== this.generation) return;
        this.listTasks = page.tasks;
      }
    }
    if (this.detail !== null) await this.refreshDetail(this.detail.id);
  }

  private async loadBoards(): Promise<void> {
    const generation = this.generation;
    const all: Board[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const answer: { boards: Board[]; nextCursor: string | null } = await this.call((api) => api.boards(cursor));
      if (generation !== this.generation) return;
      all.push(...answer.boards);
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    this.boards = all;
    this.boardsLoaded = true;
  }

  /** The board shown: the last one of this context, else the first. */
  currentBoard(): Board | null {
    const key = this.deps.context() ?? 'personal';
    const wanted = this.prefs.board[key];
    const board = this.boards.find((item) => item.id === wanted) ?? this.boards[0] ?? null;
    return board === null ? null : (this.boardDetails.get(board.id) ?? board);
  }

  /** One polling round: `changes` since the cursor; anything relevant (or a reset) reloads what is shown. */
  async poll(): Promise<void> {
    if (!this.connected || this.forbidden || this.api === null) return;
    if (this.clock.now() < this.pausedUntil) {
      this.schedulePoll();
      return;
    }
    try {
      const changes = await this.call((api) => api.changes(this.cursor));
      this.cursor = changes.nextCursor ?? this.cursor;
      const shownBoard = this.prefs.view === 'mine' ? null : this.currentBoard()?.id;
      const touched = changes.reset || changes.changes.some((change) => this.prefs.view === 'mine' || change.boardId === shownBoard || change.taskId === this.detail?.id);
      if (touched) await this.loadView();
      else if (changes.changes.length > 0 && this.prefs.view === 'mine') await this.loadView();
      this.render();
    } catch {
      // Handled in call(): banner, backoff, disconnect.
    }
    this.schedulePoll();
  }

  nextPollDelay(): number | null {
    if (!this.connected || this.forbidden) return null;
    let delay = !this.shown ? POLL_HIDDEN_MS : this.prefs.view === 'mine' && this.detail === null ? POLL_MINE_MS : POLL_SHOWN_MS;
    if (this.failures > 0) delay = Math.max(delay, Math.min(5000 * 2 ** (this.failures - 1), BACKOFF_MAX_MS));
    return Math.max(delay, this.pausedUntil - this.clock.now());
  }

  private schedulePoll(): void {
    this.stopPolling();
    const delay = this.nextPollDelay();
    if (delay === null) return;
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private showNotice(text: string): void {
    this.notice = text;
    this.deps.announce(text);
    this.renderBanner();
    if (this.noticeTimer !== null) this.clock.clearTimeout(this.noticeTimer);
    this.noticeTimer = this.clock.setTimeout(() => {
      this.noticeTimer = null;
      this.notice = null;
      this.renderBanner();
    }, 6000);
  }

  private savePrefs(): void {
    try {
      this.deps.storage?.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // Storage unavailable.
    }
  }

  // ---- navigation ---------------------------------------------------------------------------------------------------

  setView(view: TasksView): void {
    if (this.prefs.view === view) return;
    this.prefs.view = view;
    this.savePrefs();
    this.render();
    void this.loadView()
      .catch(() => undefined)
      .then(() => {
        this.render();
        this.schedulePoll();
      });
  }

  pickBoard(id: string): void {
    this.prefs.board[this.deps.context() ?? 'personal'] = id;
    this.savePrefs();
    this.columns.clear();
    this.listTasks = [];
    this.render();
    void this.loadView()
      .catch(() => undefined)
      .then(() => this.render());
  }

  toggleOnlyMine(): void {
    this.prefs.onlyMine = !this.prefs.onlyMine;
    this.savePrefs();
    void this.loadView()
      .catch(() => undefined)
      .then(() => this.render());
  }

  focusQuickAdd(): boolean {
    if (!this.connected || this.forbidden) return false;
    this.quickInput.focus();
    return true;
  }

  async openTask(id: string): Promise<void> {
    const card = this.findCard(id);
    if (card !== null && (this.detail === null || this.detail.id !== id)) this.detail = { ...emptyDetail(card) };
    this.comments = null;
    this.renderDrawer();
    this.drawerSlot.querySelector<HTMLElement>('.drawer')?.focus();
    await this.refreshDetail(id);
    this.renderDrawer();
    void this.call((api) => api.comments(id))
      .then((comments) => {
        if (this.detail?.id === id) {
          this.comments = comments;
          this.renderDrawer();
        }
      })
      .catch(() => undefined);
  }

  private async refreshDetail(id: string): Promise<void> {
    try {
      const detail = await this.call((api) => api.task(id));
      if (detail !== null && (this.detail === null || this.detail.id === id)) this.detail = detail;
      // The panel's status and assignee pickers need the board's columns and people (My tasks has not loaded them).
      if (detail !== null && !this.boardDetails.has(detail.boardId)) {
        const board = await this.call((api) => api.board(detail.boardId));
        if (board !== null) this.boardDetails.set(board.id, board);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && this.detail?.id === id) {
        this.detail = null;
        this.showNotice(this.t('notFound'));
      }
    }
  }

  closeTask(): boolean {
    if (this.detail === null) return false;
    const id = this.detail.id;
    this.detail = null;
    this.comments = null;
    this.renderDrawer();
    this.body.querySelector<HTMLElement>(`[data-task="${id}"]`)?.focus();
    return true;
  }

  private findCard(id: string): TaskCard | null {
    if (this.detail?.id === id) return this.detail;
    for (const page of this.columns.values()) {
      const found = page.tasks.find((task) => task.id === id);
      if (found !== undefined) return found;
    }
    return this.listTasks.find((task) => task.id === id) ?? this.mine.find((task) => task.id === id) ?? this.review.find((task) => task.id === id) ?? null;
  }

  /** The shell routes keys here while Tasks is shown and nothing is typed in. */
  onKey(event: KeyboardEvent): boolean {
    if (!this.connected || this.forbidden) return false;
    const mod = event.ctrlKey || event.metaKey;
    if (!mod && !event.altKey && event.key.toLowerCase() === 'n' && !(event.target instanceof HTMLElement && event.target.closest('.card, .row') !== null)) {
      return this.focusQuickAdd();
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') return this.focusQuickAdd();
    if (event.key === 'Escape' && !mod) return this.closeTask();
    return false;
  }

  // ---- writes -------------------------------------------------------------------------------------------------------

  private writable(): boolean {
    return this.me?.scopes.includes('task-board:write') === true;
  }

  /** The error of a refused write as a notice, then a quiet reload (the server's state wins). */
  private writeFailed(error: unknown): void {
    if (error instanceof TasksApiError && error.status === 409 && error.code === 'conflict') this.showNotice(this.t('conflict'));
    else if (error instanceof TasksApiError && error.code === 'transition_refused') this.showNotice(error.details.policyMessage !== undefined ? this.t('moveRefused', { message: error.details.policyMessage }) : this.t('moveRefusedNoMessage'));
    else if (error instanceof ApiError && error.code === 'insufficient_scope') this.showNotice(this.t('readOnlyScope'));
    else if (!(error instanceof ApiError && (error.status === 401 || error.status === 429 || isModuleForbidden(error)))) this.showNotice(this.t('saveFailed'));
    void this.loadView()
      .catch(() => undefined)
      .then(() => this.render());
  }

  /** Moves a card to `columnId` (optimistic on the board; `If-Match` with the card's revision). */
  async move(id: string, columnId: string): Promise<void> {
    const card = this.findCard(id);
    if (card === null || card.column?.id === columnId || !this.writable()) return;
    const board = this.boardDetails.get(card.boardId);
    const column = board?.columns.find((item) => item.id === columnId);
    // Optimistic on the board: out of its column, on top of the new one.
    const from = card.column?.id;
    if (from !== undefined && this.columns.has(from) && this.columns.has(columnId)) {
      const source = this.columns.get(from) as ColumnPage;
      const target = this.columns.get(columnId) as ColumnPage;
      const moved = { ...card, column: column !== undefined ? { id: column.id, name: column.name, icon: column.icon, type: column.type } : card.column };
      this.columns.set(from, { ...source, tasks: source.tasks.filter((task) => task.id !== id) });
      this.columns.set(columnId, { ...target, tasks: [moved, ...target.tasks] });
      this.renderBody();
      this.body.querySelector<HTMLElement>(`[data-task="${id}"]`)?.focus({ preventScroll: true });
    }
    try {
      const detail = await this.call((api) => api.move(id, { columnId }, card.revision));
      this.replaceCard(detail);
      this.deps.announce(this.t('moved', { task: taskRef(card), column: column?.name ?? detail.column?.name ?? '' }));
      if (this.prefs.view !== 'board') await this.loadView().catch(() => undefined);
      this.render();
      this.body.querySelector<HTMLElement>(`[data-task="${id}"]`)?.focus({ preventScroll: true });
    } catch (error) {
      this.writeFailed(error);
    }
  }

  /** Completes a task: to the board's first `done` column. */
  async complete(id: string): Promise<void> {
    const card = this.findCard(id);
    if (card === null) return;
    let board = this.boardDetails.get(card.boardId) ?? null;
    if (board === null) {
      board = await this.call((api) => api.board(card.boardId)).catch(() => null);
      if (board !== null) this.boardDetails.set(board.id, board);
    }
    const done = board?.columns.find((column) => column.type === 'done');
    if (done === undefined) return;
    await this.move(id, done.id);
    this.deps.announce(this.t('completed', { task: taskRef(card) }));
  }

  private replaceCard(detail: TaskDetail): void {
    for (const [key, page] of this.columns) {
      if (page.tasks.some((task) => task.id === detail.id)) {
        const inHere = detail.column?.id === key;
        this.columns.set(key, { ...page, tasks: inHere ? page.tasks.map((task) => (task.id === detail.id ? detail : task)) : page.tasks.filter((task) => task.id !== detail.id) });
      }
    }
    const target = detail.column === null ? undefined : this.columns.get(detail.column.id);
    if (target !== undefined && !target.tasks.some((task) => task.id === detail.id)) this.columns.set(detail.column?.id as string, { ...target, tasks: [detail, ...target.tasks] });
    this.listTasks = this.listTasks.map((task) => (task.id === detail.id ? detail : task));
    this.mine = this.mine.map((task) => (task.id === detail.id ? detail : task));
    if (this.detail?.id === detail.id) this.detail = detail;
  }

  /** A field change from the detail panel, with the task's revision. */
  async save(fields: TaskFields): Promise<void> {
    const detail = this.detail;
    if (detail === null || !this.writable()) return;
    try {
      const saved = await this.call((api) => api.patch(detail.id, fields, detail.revision));
      this.replaceCard(saved);
      this.render();
    } catch (error) {
      this.writeFailed(error);
      await this.refreshDetail(detail.id);
      this.renderDrawer();
    }
  }

  /** The single assignee picker: removes the other assignees, adds the chosen one (`''`: nobody). */
  async assign(userId: string): Promise<void> {
    const detail = this.detail;
    if (detail === null || !this.writable()) return;
    try {
      let current = detail;
      for (const member of detail.members.filter((item) => item.role === 'assignee' && item.user.id !== userId)) {
        current = await this.call((api) => api.member(current.id, member.user.id, 'assignee', current.revision, true));
      }
      if (userId !== '' && !current.assignees.some((person) => person.id === userId)) current = await this.call((api) => api.member(current.id, userId, 'assignee', current.revision));
      this.replaceCard(current);
      this.render();
    } catch (error) {
      this.writeFailed(error);
      await this.refreshDetail(detail.id);
      this.renderDrawer();
    }
  }

  async tick(itemId: string, done: boolean): Promise<void> {
    const detail = this.detail;
    const item = detail?.checklists.flatMap((list) => list.items).find((entry) => entry.id === itemId);
    if (detail === null || item === undefined || !this.writable()) return;
    try {
      this.replaceCard(await this.call((api) => api.patchChecklistItem(detail.id, itemId, { done }, item.revision)));
      this.render();
      this.drawerSlot.querySelector<HTMLElement>(`[data-key="item-${itemId}"]`)?.focus();
    } catch (error) {
      this.writeFailed(error);
      await this.refreshDetail(detail.id);
      this.renderDrawer();
    }
  }

  async addItem(checklist: string, title: string): Promise<boolean> {
    const detail = this.detail;
    if (detail === null || title.trim() === '' || !this.writable()) return false;
    try {
      this.replaceCard(await this.call((api) => api.addChecklistItem(detail.id, checklist, title.trim())));
      this.render();
      return true;
    } catch (error) {
      this.writeFailed(error);
      return false;
    }
  }

  /** Quick add: the prototype's syntax; Ctrl/Cmd+Enter also starts the timer on it. */
  async quickAdd(text: string, startTimer: boolean): Promise<boolean> {
    const parsed = parseQuickAdd(text, this.today());
    const board = this.targetBoard();
    if (parsed.title === '' || board === null || !this.writable()) {
      if (board === null) this.showNotice(this.t('quickAddNoBoard'));
      return false;
    }
    const mine = this.prefs.view === 'mine';
    const dueAt = parsed.dueAt ?? (mine ? `${this.today()}T00:00:00Z` : null);
    try {
      const created = await this.call((api) =>
        api.create({
          boardId: board.id,
          title: parsed.title,
          ...(parsed.priority !== null ? { priority: parsed.priority } : {}),
          ...(parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
          ...(dueAt !== null ? { dueAt, allDay: true } : {}),
          ...(parsed.estimateMinutes !== null ? { estimateMinutes: parsed.estimateMinutes } : {}),
          ...(mine || this.prefs.onlyMine ? { assignees: ['me'] } : {}),
        }),
      );
      this.deps.announce(this.t('added', { task: taskRef(created), board: board.title }));
      if (startTimer) void this.startTimer(created);
      await this.loadView().catch(() => undefined);
      this.render();
      return true;
    } catch (error) {
      this.writeFailed(error);
      return false;
    }
  }

  /** Where quick add creates: the board shown, else (My tasks) the last board of this context the person may add to. */
  private targetBoard(): Board | null {
    const current = this.currentBoard();
    if (current !== null && current.canCreate) return current;
    return this.boards.find((board) => board.canCreate) ?? null;
  }

  async startTimer(task: TaskCard): Promise<void> {
    if (this.deps.runningTaskId() === task.id) {
      await this.deps.stopTimer();
    } else {
      const board = this.boards.find((item) => item.id === task.boardId) ?? this.boardDetails.get(task.boardId);
      await this.deps.startTimer({ id: task.id, title: task.title, boardTitle: board?.title ?? null, url: this.detail?.id === task.id ? this.detail.webUrl : null });
    }
    this.render();
  }

  // ---- rendering ----------------------------------------------------------------------------------------------------

  render(): void {
    this.root.dataset.state = !this.connected ? 'disconnected' : this.forbidden ? 'forbidden' : 'connected';
    if (!this.connected) {
      this.root.replaceChildren(this.renderConnect());
      return;
    }
    if (this.forbidden) {
      this.root.replaceChildren(h('section', { class: 'connect-card', id: 'tasks-forbidden' }, h('span', { class: 'cc-ico', attrs: { 'aria-hidden': 'true' } }, chatIcon('lock', 'lg')), h('h1', {}, this.t('forbiddenTitle')), h('p', { class: 'cc-text' }, this.t('forbiddenText'))));
      return;
    }
    if (this.root.firstChild !== this.page) this.root.replaceChildren(this.page, this.drawerSlot);
    this.root.classList.toggle('drawer-open', this.detail !== null);
    this.renderHead();
    this.renderExtras();
    this.renderBanner();
    this.renderBody();
    this.renderDrawer();
  }

  private renderConnect(): HTMLElement {
    const t = this.t;
    const state = this.connect;
    const body: Child[] = [];
    if (state.kind === 'code') {
      body.push(
        h('p', { class: 'cc-wait', attrs: { role: 'status' } }, t('connectWaiting')),
        h('div', { class: 'cc-code' }, h('span', { class: 'cc-code-label' }, t('connectCode')), h('output', { class: 'cc-code-value', id: 'tasks-user-code' }, state.userCode)),
        h('div', { class: 'cc-row' }, this.button('btn primary', t('connectOpen'), () => this.deps.openVerification(state.url), 'tasks-open-approval'), this.button('btn', t('connectCopy'), () => void this.deps.copy(state.userCode.replace('-', ''))), this.button('btn-ghost', t('connectCancel'), () => this.cancelConnect(), 'tasks-cancel')),
      );
    } else {
      if (state.kind === 'idle' && state.message !== null) body.push(h('p', { class: 'cc-error', attrs: { role: 'alert' } }, state.message));
      body.push(h('div', { class: 'cc-row' }, this.button('btn primary', t('connectButton'), () => void this.connectTasks(), 'tasks-connect', state.kind === 'starting')));
    }
    return h('section', { class: 'connect-card', id: 'tasks-connect-card', attrs: { 'aria-labelledby': 'tasks-connect-title' } }, h('span', { class: 'cc-ico', attrs: { 'aria-hidden': 'true' } }, chatIcon('tasks', 'lg')), h('h1', { id: 'tasks-connect-title' }, t('connectTitle')), h('p', { class: 'cc-text' }, t('connectText')), h('p', { class: 'cc-points' }, t('connectPoints')), ...body);
  }

  private button(className: string, label: string, onClick: () => void, id?: string, disabled = false): HTMLButtonElement {
    const button = h('button', { class: className, id, attrs: { type: 'button', disabled: disabled || undefined } }, label);
    button.addEventListener('click', onClick);
    return button;
  }

  private renderHead(): void {
    const t = this.t;
    const view = this.prefs.view;
    const board = this.currentBoard();
    const name = this.deps.contextLabel();
    const title = view === 'mine' ? t('viewMine') : (board?.title ?? t('viewBoard'));
    const sub = view === 'mine' ? t('mineSub', { name }) : board?.counts !== null && board?.counts !== undefined ? t(board.counts.capped ? 'boardSubCapped' : 'boardSub', { name, count: board.counts.open }) : name;
    const nodes: Child[] = [h('h1', { id: 'tasks-title' }, title), h('span', { class: 'sub' }, sub), h('span', { class: 'grow' })];
    if (view !== 'mine' && this.boards.length > 1) {
      const select = h('select', { class: 'selectish', id: 'tasks-board', key: 'tasks-board', attrs: { 'aria-label': t('boardPicker') } });
      const groups = new Map<string, Board[]>();
      for (const item of this.boards) {
        const label = item.group?.label ?? '';
        groups.set(label, [...(groups.get(label) ?? []), item]);
      }
      for (const [label, items] of groups) {
        const options = items.map((item) => {
          const option = h('option', { attrs: { value: item.id } }, item.title);
          option.selected = item.id === board?.id;
          return option;
        });
        if (label === '') select.append(...options);
        else select.append(h('optgroup', { attrs: { label } }, ...options));
      }
      select.addEventListener('change', () => this.pickBoard(select.value));
      nodes.push(select);
    }
    const tabs = h('div', { class: 'seg', attrs: { role: 'tablist', 'aria-label': t('views') } });
    const specs: [TasksView, string][] = [
      ['mine', t('viewMine')],
      ['board', t('viewBoard')],
      ['list', t('viewList')],
    ];
    specs.forEach(([id, label], index) => {
      const selected = view === id;
      const tab = h('button', { key: `view-${id}`, attrs: { type: 'button', role: 'tab', 'aria-selected': selected ? 'true' : 'false', tabindex: selected ? '0' : '-1', 'data-view': id } }, label);
      tab.addEventListener('click', () => this.setView(id));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const next = specs[(index + (event.key === 'ArrowRight' ? 1 : specs.length - 1)) % specs.length][0];
        this.setView(next);
        this.head.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
      });
      tabs.append(tab);
    });
    nodes.push(tabs);
    patch(this.head, nodes);
    const target = this.targetBoard();
    this.quickHelp.textContent = target === null ? t('quickAddNoBoard') : t('quickAddHelp', { board: target.title });
    this.quickInput.disabled = !this.writable();
  }

  private renderExtras(): void {
    if (this.prefs.view === 'mine') {
      patch(this.extras, []);
      return;
    }
    const mine = h('button', { class: 'btn-ghost', key: 'only-mine', attrs: { type: 'button', 'aria-pressed': this.prefs.onlyMine ? 'true' : 'false' } }, chatIcon('users', 'sm'), this.t('onlyMine'));
    mine.addEventListener('click', () => this.toggleOnlyMine());
    const open = this.currentBoard();
    const nodes: Child[] = [mine];
    const server = this.deps.server();
    if (open !== null && server !== null) {
      const link = h('button', { class: 'btn-ghost', key: 'board-beacon', attrs: { type: 'button', 'aria-label': this.t('openInBeacon'), title: this.t('openInBeacon') } }, chatIcon('external', 'sm'));
      link.addEventListener('click', () => this.deps.openLink(`${server}/dashboard/tasks/boards/${open.id}`));
      nodes.push(link);
    }
    patch(this.extras, nodes);
  }

  private renderBanner(): void {
    const t = this.t;
    const nodes: Child[] = [];
    if (this.offline) nodes.push(h('span', {}, t('offline')));
    if (this.notice !== null) nodes.push(h('span', {}, chatIcon('alert', 'sm'), this.notice));
    if (this.contextRefused) nodes.push(h('span', {}, t('contextRefused', { name: this.deps.contextLabel() })));
    if (this.error !== null) {
      nodes.push(h('span', {}, this.error), this.button('btn sm', t('retry'), () => void this.reload(), 'tasks-retry'));
    }
    this.banner.replaceChildren(...(nodes.filter(Boolean) as Node[]));
    this.banner.hidden = nodes.length === 0;
  }

  renderBody(): void {
    const view = this.prefs.view;
    if (view === 'mine') patch(this.body, [this.renderMine()]);
    else if (this.boardsLoaded && this.boards.length === 0) patch(this.body, [emptyState(this.t('noBoards', { name: this.deps.contextLabel() }), this.t('noBoardsHint'))]);
    else if (view === 'board') patch(this.body, [this.renderBoard()]);
    else patch(this.body, [this.renderList()]);
  }

  // -- My tasks

  private renderMine(): HTMLElement {
    const t = this.t;
    const wrap = h('div', { class: 'mt', id: 'tasks-mine' });
    if (!this.mineLoaded) {
      wrap.append(skeleton(6));
      return wrap;
    }
    const today = this.today();
    const groups = groupMine(this.mine, today);
    const sections: [string, TaskCard[], string, string][] = [
      ['overdue', groups.overdue, t('groupOverdue'), t('emptyOverdue')],
      ['today', groups.today, t('groupToday'), t('emptyGroup')],
      ['upcoming', groups.upcoming, t('groupUpcoming'), t('emptyGroup')],
      ['no-date', groups.noDate, t('groupNoDate'), t('emptyGroup')],
      ['review', this.review, t('groupReview'), t('emptyGroup')],
    ];
    for (const [id, items, label, empty] of sections) {
      const heading = h('h3', { id: `mt-${id}`, class: id === 'overdue' && items.length > 0 ? 'over' : '' }, label, h('span', { class: 'cnt' }, `· ${items.length}`));
      const section = h('section', { class: 'mt-group', attrs: { 'aria-labelledby': `mt-${id}` } }, heading);
      if (items.length === 0) section.append(h('p', { class: 'mt-empty' }, empty));
      else section.append(h('ul', { class: 'rows', attrs: { role: 'list' } }, ...items.map((task) => this.row(task, id === 'review'))));
      wrap.append(section);
    }
    return wrap;
  }

  private row(task: TaskCard, review: boolean): HTMLElement {
    const t = this.t;
    const running = this.deps.runningTaskId() === task.id;
    const due = dueInfo(task, this.today(), t, this.deps.locale);
    const board = this.boards.find((item) => item.id === task.boardId);
    const check = h('button', { class: 'chk', key: `chk-${task.id}`, attrs: { type: 'button', role: 'checkbox', 'aria-checked': task.completed ? 'true' : 'false', 'aria-label': t('complete', { title: task.title }), disabled: !this.writable() || undefined } }, chatIcon('check', 'xs'));
    check.addEventListener('click', () => void this.complete(task.id));
    const open = h('button', { class: 'r-title', key: `open-${task.id}`, attrs: { type: 'button', 'data-task': task.id } }, h('span', { class: 'k-id' }, taskRef(task)), h('span', { class: 't' }, task.title), review ? h('span', { class: 'pill' }, t('groupReview')) : null, task.waitingForMe ? h('span', { class: 'pill q' }, t('questionWaiting')) : null);
    open.addEventListener('click', () => void this.openTask(task.id));
    return h('li', { class: `row${running ? ' live' : ''}` }, check, open, h('span', { class: 'r-b hide-sm' }, board?.title ?? ''), priorityEl(task.priority, t) ?? h('span', {}), due !== null ? h('span', { class: `pill due-${due.tone || 'later'}` }, due.label) : h('span', { class: 'r-b' }, '—'), this.playButton(task, true));
  }

  private playButton(task: TaskCard, visible: boolean): HTMLButtonElement {
    const t = this.t;
    const running = this.deps.runningTaskId() === task.id;
    const label = running ? t('stopTimer') : t('startTimer', { task: taskRef(task) });
    const button = h('button', { class: `k-play${running ? ' on' : ''}${visible ? ' shown' : ''}`, key: `play-${task.id}`, attrs: { type: 'button', 'aria-label': label, title: `${label} (S)`, tabindex: visible ? undefined : '-1' } }, chatIcon(running ? 'stop' : 'play', 'sm'));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.startTimer(task);
    });
    return button;
  }

  // -- Board (kanban)

  private renderBoard(): HTMLElement {
    const t = this.t;
    const board = this.currentBoard();
    const wrap = h('div', { class: 'board-wrap', id: 'tasks-board-view' });
    if (board === null || board.columns.length === 0 || this.columns.size === 0) {
      wrap.append(h('div', { class: 'board' }, ...Array.from({ length: 4 }, () => h('div', { class: 'col skel-col', attrs: { 'aria-hidden': 'true' } }, skeleton(3)))));
      return wrap;
    }
    const grid = h('div', { class: 'board' });
    let first = true;
    for (const column of board.columns) {
      const page = this.columns.get(column.id) ?? { tasks: [], nextCursor: null };
      const label = page.nextCursor !== null ? t('colCountMore', { name: column.name, count: page.tasks.length }) : t('colCount', { name: column.name, count: page.tasks.length });
      const section = h('section', { class: 'col', attrs: { 'aria-label': label, 'data-col': column.id } });
      section.append(h('div', { class: 'col-h' }, this.marker(column), h('h3', {}, column.name), h('span', { class: 'cnt', attrs: { 'aria-hidden': 'true' } }, page.nextCursor !== null ? `${page.tasks.length}+` : String(page.tasks.length))));
      const list = h('ul', { class: 'col-list', attrs: { role: 'list' } });
      if (page.tasks.length === 0) list.append(h('li', { class: 'col-empty' }, h('b', {}, t('colEmpty')), t('colEmptyHint')));
      for (const task of page.tasks) {
        list.append(this.card(task, board, first));
        first = false;
      }
      section.append(list);
      if (page.nextCursor !== null) {
        const more = this.button('btn sm col-more', t('loadMoreCards'), () => void this.loadMore(board.id, column.id));
        section.append(more);
      }
      section.addEventListener('dragover', (event) => {
        if (this.dragging === null) return;
        event.preventDefault();
        section.classList.add('drop');
      });
      section.addEventListener('dragleave', (event) => {
        if (!section.contains(event.relatedTarget as Node | null)) section.classList.remove('drop');
      });
      section.addEventListener('drop', (event) => {
        event.preventDefault();
        section.classList.remove('drop');
        const id = this.dragging;
        this.dragging = null;
        if (id !== null) void this.move(id, column.id);
      });
      grid.append(section);
    }
    wrap.append(grid);
    return wrap;
  }

  private async loadMore(boardId: string, columnId: string): Promise<void> {
    const page = this.columns.get(columnId);
    if (page === undefined || page.nextCursor === null) return;
    try {
      const next = await this.call((api) => api.boardTasks(boardId, { column: columnId, cursor: page.nextCursor, limit: this.me?.limits.columnPageSize ?? 30, assignee: this.prefs.onlyMine ? 'me' : undefined }));
      this.columns.set(columnId, { tasks: [...page.tasks, ...next.tasks.filter((task) => !page.tasks.some((known) => known.id === task.id))], nextCursor: next.nextCursor });
      this.renderBody();
    } catch {
      // Banner from call().
    }
  }

  /** The column's marker (owner decision 2026-11-25): TaskBoard's emoji, or a dot in the column colour. */
  private marker(column: Column): Child {
    if (this.deps.markers() === 'emoji' && column.icon !== null) return h('span', { class: 'col-emoji', attrs: { 'aria-hidden': 'true' } }, column.icon);
    return h('span', { class: 'col-dot', attrs: { 'aria-hidden': 'true', style: `background:${column.color ?? 'var(--ink-3)'}` } });
  }

  private card(task: TaskCard, board: Board, first: boolean): HTMLElement {
    const t = this.t;
    const running = this.deps.runningTaskId() === task.id;
    const due = dueInfo(task, this.today(), t, this.deps.locale);
    const parts = [`${taskRef(task)}: ${task.title}`];
    if (task.priority !== 'normal') parts.push(t('priority', { priority: priorityLabel(task.priority, t) }));
    if (due !== null) parts.push(t('due', { date: due.label }));
    if (running) parts.push(t('cardTimer'));
    const item = h('li', {
      class: `card${running ? ' live' : ''}${task.completed ? ' done' : ''}`,
      key: `card-${task.id}`,
      attrs: { tabindex: first ? '0' : '-1', draggable: this.writable() && board.canMove ? 'true' : 'false', 'data-task': task.id, 'aria-label': `${parts.join(', ')}. ${t('cardHint')}`, 'aria-roledescription': 'task card' },
    });
    item.append(h('div', { class: 'k-top' }, h('span', { class: 'k-id' }, taskRef(task)), priorityEl(task.priority, t), h('span', { class: 'grow' }), this.playButton(task, false)));
    item.append(h('div', { class: 'k-title' }, task.title));
    if (task.tags.length > 0) item.append(h('div', { class: 'k-tags' }, ...task.tags.slice(0, 3).map(tagEl), task.tags.length > 3 ? h('span', { class: 'tag', attrs: { title: task.tags.slice(3).join(', ') } }, `+${task.tags.length - 3}`) : null));
    if (task.waitingForMe) item.append(h('div', { class: 'k-q' }, h('span', { class: 'pill q' }, t('questionWaiting'))));
    const checks = task.checklist.total + task.subtasks.total;
    item.append(
      h(
        'div',
        { class: 'k-foot' },
        due !== null ? h('span', { class: `pill due-${due.tone || 'later'}` }, chatIcon('clock', 'xs'), due.label) : null,
        checks > 0 ? h('span', { class: 'meta', attrs: { title: t('checklists') } }, chatIcon('check', 'xs'), `${task.checklist.done + task.subtasks.done}/${checks}`) : null,
        task.comments > 0 ? h('span', { class: 'meta' }, chatIcon('chat', 'xs'), String(task.comments)) : null,
        task.estimateMinutes !== null ? h('span', { class: 'meta', attrs: { title: t('estimate') } }, chatIcon('clock', 'xs'), duration(task.estimateMinutes)) : null,
        h('span', { class: 'grow' }),
        h('span', { class: 'facepile' }, ...task.assignees.slice(0, 2).map((person) => h('span', { class: `av s20 ${hue(person.id)}`, attrs: { title: person.name, 'aria-hidden': 'true' } }, person.initials))),
      ),
    );
    item.addEventListener('click', () => void this.openTask(task.id));
    item.addEventListener('keydown', (event) => this.onCardKey(event, task, board));
    item.addEventListener('focusin', () => {
      for (const other of this.body.querySelectorAll<HTMLElement>('.card')) other.tabIndex = other === item ? 0 : -1;
    });
    item.addEventListener('dragstart', (event) => {
      this.dragging = task.id;
      event.dataTransfer?.setData('text/plain', task.id);
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      this.dragging = null;
      item.classList.remove('dragging');
    });
    return item;
  }

  private onCardKey(event: KeyboardEvent, task: TaskCard, board: Board): void {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) return;
    const item = event.currentTarget as HTMLElement;
    const columnIndex = board.columns.findIndex((column) => column.id === task.column?.id);
    if ((event.key === 'Enter' || event.key === ' ') && !event.altKey) {
      event.preventDefault();
      void this.openTask(task.id);
    } else if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      const next = board.columns[columnIndex + (event.key === 'ArrowRight' ? 1 : -1)];
      if (next !== undefined) void this.move(task.id, next.id);
    } else if (!event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const sibling = (event.key === 'ArrowDown' ? item.nextElementSibling : item.previousElementSibling) as HTMLElement | null;
      if (sibling?.classList.contains('card') === true) sibling.focus();
    } else if (!event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      const columns = [...this.body.querySelectorAll<HTMLElement>('.col')];
      const here = columns.indexOf(item.closest('.col') as HTMLElement);
      const step = event.key === 'ArrowRight' ? 1 : -1;
      for (let index = here + step; index >= 0 && index < columns.length; index += step) {
        const card = columns[index].querySelector<HTMLElement>('.card');
        if (card !== null) {
          card.focus();
          break;
        }
      }
    } else if (!event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.startTimer(task);
    }
  }

  // -- List

  private renderList(): HTMLElement {
    const t = this.t;
    const board = this.currentBoard();
    const wrap = h('div', { class: 'mt', id: 'tasks-list-view' });
    if (board === null || board.columns.length === 0) {
      wrap.append(skeleton(6));
      return wrap;
    }
    const table = h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...[t('tableId'), t('tableTitle'), t('tableStatus'), t('tablePriority'), t('tableAssignee'), t('tableDue'), t('tableLogged'), ''].map((label, index) => h('th', { class: index === 4 || index === 6 ? 'hide-sm' : '', attrs: { scope: 'col' } }, label)))));
    const body = h('tbody');
    for (const column of board.columns) {
      const items = this.listTasks.filter((task) => task.column?.id === column.id);
      body.append(h('tr', { class: 'tbl-group' }, h('td', { attrs: { colspan: '8' } }, this.marker(column), ` ${column.name} · ${items.length}`)));
      for (const task of items) {
        const due = dueInfo(task, this.today(), t, this.deps.locale);
        const status = h('select', { class: 'selectish sm', key: `status-${task.id}`, attrs: { 'aria-label': t('statusOf', { task: taskRef(task) }), disabled: !this.writable() || !board.canMove || undefined } }, ...board.columns.map((option) => {
          const element = h('option', { attrs: { value: option.id } }, option.name);
          element.selected = option.id === column.id;
          return element;
        }));
        status.addEventListener('change', () => void this.move(task.id, status.value));
        const open = h('button', { class: 't-title', key: `open-${task.id}`, attrs: { type: 'button', 'data-task': task.id } }, task.title);
        open.addEventListener('click', () => void this.openTask(task.id));
        const assignee = task.assignees[0];
        body.append(
          h(
            'tr',
            { class: this.deps.runningTaskId() === task.id ? 'live' : '' },
            h('td', { class: 'k-id' }, taskRef(task)),
            h('td', { class: 'td-title' }, open),
            h('td', {}, status),
            h('td', {}, priorityEl(task.priority, t) ?? h('span', { class: 'muted' }, t('priorityNormal'))),
            h('td', { class: 'hide-sm' }, assignee !== undefined ? h('span', { class: 'person' }, h('span', { class: `av s20 ${hue(assignee.id)}`, attrs: { 'aria-hidden': 'true' } }, assignee.initials), assignee.name) : h('span', { class: 'muted' }, t('unassigned'))),
            h('td', {}, due !== null ? h('span', { class: `pill due-${due.tone || 'later'}` }, due.label) : '—'),
            h('td', { class: 'hide-sm num' }, duration(task.timeSpentMinutes)),
            h('td', {}, this.playButton(task, true)),
          ),
        );
      }
    }
    table.append(body);
    wrap.append(table);
    return wrap;
  }

  // -- Detail

  private renderDrawer(): void {
    const t = this.t;
    const task = this.detail;
    this.root.classList.toggle('drawer-open', task !== null);
    if (task === null) {
      this.drawerSlot.replaceChildren();
      return;
    }
    // Keep what is typed in the panel's fields across a refresh.
    const typed = new Map<string, string>();
    for (const field of this.drawerSlot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[data-key], textarea[data-key]')) if (field.dataset.dirty === 'true') typed.set(field.dataset.key as string, field.value);
    const board = this.boardDetails.get(task.boardId) ?? this.boards.find((item) => item.id === task.boardId) ?? null;
    const editable = this.writable() && task.permissions.canEdit;
    const running = this.deps.runningTaskId() === task.id;
    const panel = h('aside', { class: 'drawer', id: 'task-detail', attrs: { 'aria-label': t('detailLabel', { task: taskRef(task) }), tabindex: '-1' } });
    panel.addEventListener('keydown', (event) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if (event.key === 'Escape' && !typing) {
        event.stopPropagation();
        this.closeTask();
      }
    });
    const close = h('button', { class: 'x-btn', id: 'task-close', attrs: { type: 'button', 'aria-label': t('closeDetail'), title: `${t('closeDetail')} (Esc)` } }, chatIcon('x'));
    close.addEventListener('click', () => this.closeTask());
    const head = h('div', { class: 'dr-head' }, h('div', { class: 'crumbs' }, chatIcon('tasks', 'sm'), h('span', {}, board?.title ?? ''), chatIcon('chev-l', 'xs'), h('span', { class: 'k-id' }, taskRef(task))));
    if (task.webUrl !== null) {
      const url = task.webUrl;
      const open = h('button', { class: 'btn-ghost', id: 'task-open-beacon', attrs: { type: 'button', 'aria-label': t('openInBeacon'), title: t('openInBeacon') } }, chatIcon('external', 'sm'));
      open.addEventListener('click', () => this.deps.openLink(url));
      head.append(open);
    }
    head.append(close);
    const body = h('div', { class: 'dr-body' });
    const title = h('textarea', { class: 'dr-title', key: 'task-title', attrs: { rows: '2', 'aria-label': t('fieldTitle'), readonly: !editable || undefined } });
    title.value = typed.get('task-title') ?? task.title;
    this.dirty(title);
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        title.blur();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        title.value = task.title;
        title.dataset.dirty = 'false';
        title.blur();
      }
    });
    title.addEventListener('change', () => {
      const value = title.value.replace(/\s+/g, ' ').trim();
      title.dataset.dirty = 'false';
      if (value !== '' && value !== task.title) void this.save({ title: value });
    });
    body.append(title);
    // The task's time: what TimeTrack logged, the estimate, start / stop / switch.
    const timerButton = running
      ? this.button('btn signal', t('stopTimer'), () => void this.startTimer(task), 'task-timer')
      : this.button('btn primary', this.deps.runningTaskId() !== null ? t('switchTimer') : t('startTimerShort'), () => void this.startTimer(task), 'task-timer', !task.permissions.canTrackTime);
    timerButton.prepend(chatIcon(running ? 'stop' : 'play', 'sm'));
    body.append(
      h(
        'div',
        { class: `dr-timer${running ? ' on' : ''}` },
        h('div', { class: 'dt-l' }, running ? t('trackingNow') : t('logged'), h('b', {}, duration(task.timeSpentMinutes))),
        task.estimateMinutes !== null ? h('div', { class: 'dt-l dt-est' }, t('estimate'), h('b', {}, duration(task.estimateMinutes))) : null,
        timerButton,
      ),
    );
    // Fields.
    const fields = h('dl', { class: 'fields' });
    const status = h('select', { class: 'selectish', key: 'task-status', attrs: { 'aria-label': t('fieldStatus'), disabled: !(this.writable() && task.permissions.canMove) || undefined } }, ...(board?.columns ?? []).map((column) => {
      const option = h('option', { attrs: { value: column.id } }, column.name);
      option.selected = column.id === task.column?.id;
      return option;
    }));
    if (board === null || board.columns.length === 0) status.append(h('option', {}, task.column?.name ?? '—'));
    status.addEventListener('change', () => void this.move(task.id, status.value).then(() => this.refreshDetail(task.id)).then(() => this.renderDrawer()));
    const priority = h('select', { class: 'selectish', key: 'task-priority', attrs: { 'aria-label': t('fieldPriority'), disabled: !editable || undefined } }, ...PRIORITIES.map((value) => {
      const option = h('option', { attrs: { value } }, priorityLabel(value, t));
      option.selected = value === task.priority;
      return option;
    }));
    priority.addEventListener('change', () => void this.save({ priority: priority.value as Priority }));
    const people = board?.people ?? [];
    const assignee = h('select', { class: 'selectish', key: 'task-assignee', attrs: { 'aria-label': t('fieldAssignee'), disabled: !(this.writable() && task.permissions.canAssign) || undefined } }, h('option', { attrs: { value: '' } }, t('unassigned')));
    const known = new Map([...people, ...task.assignees].map((person) => [person.id, person]));
    for (const person of known.values()) {
      const option = h('option', { attrs: { value: person.id } }, person.id === this.me?.user?.id ? `${person.name} ✓` : person.name);
      option.selected = task.assignees[0]?.id === person.id;
      assignee.append(option);
    }
    assignee.addEventListener('change', () => void this.assign(assignee.value));
    const dueInput = h('input', { class: 'date-in', key: 'task-due', attrs: { type: 'date', 'aria-label': t('fieldDue'), readonly: !editable || undefined } });
    dueInput.value = apiToDateInput(task);
    dueInput.addEventListener('change', () => void this.save(dueInput.value === '' ? { dueAt: null } : { dueAt: dateInputToApi(dueInput.value), allDay: true }));
    const estimate = h('input', { class: 'num-in', key: 'task-estimate', attrs: { type: 'number', min: '0', step: '15', inputmode: 'numeric', 'aria-label': t('fieldEstimate'), readonly: !editable || undefined } });
    estimate.value = typed.get('task-estimate') ?? (task.estimateMinutes === null ? '' : String(task.estimateMinutes));
    this.dirty(estimate);
    estimate.addEventListener('change', () => {
      estimate.dataset.dirty = 'false';
      const value = estimate.value.trim() === '' ? null : Math.max(0, Math.round(Number(estimate.value)));
      if (value === null || Number.isFinite(value)) void this.save({ estimateMinutes: value });
    });
    const tags = h('input', { class: 'tags-in', key: 'task-tags', attrs: { type: 'text', 'aria-label': t('fieldTags'), 'aria-describedby': 'task-tags-hint', readonly: !editable || undefined } });
    tags.value = typed.get('task-tags') ?? task.tags.join(', ');
    this.dirty(tags);
    tags.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        tags.dataset.dirty = 'false';
        const list = [...new Set(tags.value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''))].slice(0, 20);
        void this.save({ tags: list });
      }
    });
    const row = (icon: Parameters<typeof chatIcon>[0], label: string, control: Child, id: string) => [h('dt', { id }, chatIcon(icon, 'sm'), label), h('dd', { attrs: { 'aria-labelledby': id } }, control)];
    fields.append(
      ...row('tasks', t('fieldStatus'), status, 'dt-status'),
      ...row('alert', t('fieldPriority'), priority, 'dt-priority'),
      ...row('users', t('fieldAssignee'), assignee, 'dt-assignee'),
      ...row('clock', t('fieldDue'), dueInput, 'dt-due'),
      ...row('clock', t('fieldEstimate'), estimate, 'dt-estimate'),
      ...row('hash', t('fieldTags'), h('span', { class: 'tags-field' }, tags, h('span', { class: 'hint', id: 'task-tags-hint' }, t('tagsHint'))), 'dt-tags'),
    );
    body.append(fields);
    if (task.waitingForMe) body.append(h('div', { class: 'qbox' }, h('b', {}, t('questionWaiting'))));
    // Parent.
    if (task.parent !== null) body.append(h('section', { class: 'dr-sec' }, h('h3', {}, t('parent')), task.parent.visible ? this.linkButton(task.parent.title, task.parent.id) : h('p', { class: 'muted' }, t('parentHidden'))));
    // Description (read-only here: TaskBoard 3.4 answers tokens, not the Markdown source).
    const description = h('section', { class: 'dr-sec' }, h('h3', {}, t('description')));
    if (task.description === null || task.description.length === 0) description.append(h('p', { class: 'muted' }, t('noDescription')));
    else description.append(renderBlocks(task.description, { t: this.deps.chatT, me: null, open: (url) => this.deps.openLink(url) }));
    if (task.descriptionTruncated) description.append(h('p', { class: 'muted' }, t('descriptionTruncated')));
    if (task.webUrl !== null && editable) {
      const url = task.webUrl;
      const edit = this.button('btn-link', t('editInBeacon'), () => this.deps.openLink(url));
      description.append(edit);
    }
    body.append(description);
    // Checklists.
    const checklists = h('section', { class: 'dr-sec', attrs: { 'aria-labelledby': 'task-checklists' } }, h('h3', { id: 'task-checklists' }, t('checklists'), task.checklist.total > 0 ? h('span', { class: 'num' }, `${task.checklist.done}/${task.checklist.total}`) : null, task.checklist.total > 0 ? h('span', { class: 'progress', attrs: { 'aria-hidden': 'true' } }, h('i', { attrs: { style: `width:${Math.round((task.checklist.done / task.checklist.total) * 100)}%` } })) : null));
    const lists = task.checklists.length > 0 ? task.checklists : editable ? [{ name: t('newChecklist'), items: [] }] : [];
    for (const list of lists) {
      if (task.checklists.length > 1) checklists.append(h('h4', {}, list.name));
      const ul = h('ul', { class: 'sub-list', attrs: { role: 'list' } });
      for (const item of list.items) {
        const box = h('button', { class: 'chk', key: `item-${item.id}`, attrs: { type: 'button', role: 'checkbox', 'aria-checked': item.done ? 'true' : 'false', 'aria-label': item.title, disabled: !editable || undefined } }, chatIcon('check', 'xs'));
        box.addEventListener('click', () => void this.tick(item.id, !item.done));
        ul.append(h('li', { class: `sub-item${item.done ? ' done' : ''}` }, box, h('span', { class: 'st', attrs: { 'aria-hidden': 'true' } }, item.title)));
      }
      checklists.append(ul);
      if (editable) {
        const key = `add-${list.name}`;
        const add = h('input', { class: 'add-item', key, attrs: { type: 'text', placeholder: t('addItemPlaceholder'), 'aria-label': t('addItem', { name: list.name }) } });
        add.value = typed.get(key) ?? '';
        this.dirty(add);
        add.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' || event.isComposing) return;
          event.preventDefault();
          const value = add.value;
          add.dataset.dirty = 'false';
          add.value = '';
          void this.addItem(list.name, value).then((ok) => {
            if (!ok) add.value = value;
            this.drawerSlot.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
          });
        });
        checklists.append(add);
      }
    }
    if (lists.length > 0) body.append(checklists);
    if (task.subtasks.total > 0) body.append(h('section', { class: 'dr-sec' }, h('h3', {}, t('subtasks'), h('span', { class: 'num' }, `${task.subtasks.done}/${task.subtasks.total}`))));
    // Links (visible ones; the others say so without any detail).
    if (task.links.length > 0) {
      body.append(
        h(
          'section',
          { class: 'dr-sec' },
          h('h3', {}, t('links')),
          ...task.links.map((link) => {
            if (!link.visible) return h('div', { class: 'link-row hidden' }, chatIcon('eye-off', 'sm'), h('span', { class: 'lr-t' }, t('linkHidden')));
            const url = link.url;
            const button = h('button', { class: 'link-row', attrs: { type: 'button', disabled: url === null || undefined } }, chatIcon('external', 'sm'), h('span', { class: 'lr-t' }, link.title));
            if (url !== null) button.addEventListener('click', () => this.deps.openLink(url));
            return button;
          }),
        ),
      );
    }
    // Comments (read here; writing them is TaskBoard 3.5).
    const comments = h('section', { class: 'dr-sec' }, h('h3', {}, t('comments', { count: task.comments })));
    if (this.comments === null && task.comments > 0) comments.append(skeleton(2));
    else if (this.comments === null || this.comments.length === 0) comments.append(h('p', { class: 'muted' }, t('noComments')));
    else {
      for (const comment of this.comments) {
        comments.append(
          h(
            'div',
            { class: 'comment' },
            h('span', { class: `av s24 ${hue(comment.author?.id ?? '?')}`, attrs: { 'aria-hidden': 'true' } }, comment.author?.initials ?? '?'),
            h('div', {}, h('div', { class: 'c-h' }, comment.author?.name ?? '?', h('span', {}, this.when(comment.createdAt))), comment.body !== null ? renderBlocks(comment.body, { t: this.deps.chatT, me: null, open: (url) => this.deps.openLink(url) }) : null),
          ),
        );
      }
    }
    comments.append(h('p', { class: 'muted small' }, t('commentsInBeacon')));
    body.append(comments);
    panel.append(head, body);
    patch(this.drawerSlot, [panel], '#task-detail');
  }

  /** A field the person is editing is marked, so a refresh keeps the text. */
  private dirty(field: HTMLInputElement | HTMLTextAreaElement): void {
    field.addEventListener('input', () => (field.dataset.dirty = 'true'));
  }

  private linkButton(label: string, id: string): HTMLButtonElement {
    const button = h('button', { class: 'btn-link', attrs: { type: 'button' } }, label);
    button.addEventListener('click', () => void this.openTask(id));
    return button;
  }

  private when(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(this.deps.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  // -- Quick add

  private renderQuickPreview(): void {
    const parsed = parseQuickAdd(this.quickInput.value, this.today());
    const t = this.t;
    const nodes: Child[] = [];
    if (parsed.priority !== null && parsed.priority !== 'normal') nodes.push(h('span', { class: `pill p-${parsed.priority}` }, priorityLabel(parsed.priority, t)));
    for (const tag of parsed.tags) nodes.push(tagEl(tag));
    if (parsed.dueAt !== null) {
      const due = dueInfo({ dueAt: parsed.dueAt, allDay: true }, this.today(), t, this.deps.locale);
      if (due !== null) nodes.push(h('span', { class: `pill due-${due.tone || 'later'}` }, due.label));
    }
    if (parsed.estimateMinutes !== null) nodes.push(h('span', { class: 'pill' }, duration(parsed.estimateMinutes)));
    this.quickPreview.replaceChildren(...(nodes.filter(Boolean) as Node[]));
  }

  private onQuickKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.quickInput.value = '';
      this.renderQuickPreview();
      this.quickInput.blur();
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const text = this.quickInput.value;
    if (text.trim() === '') return;
    this.quickInput.value = '';
    this.renderQuickPreview();
    void this.quickAdd(text, event.ctrlKey || event.metaKey).then((ok) => {
      if (!ok) this.quickInput.value = text;
      this.renderQuickPreview();
      this.quickInput.focus();
    });
  }
}

function emptyDetail(card: TaskCard): TaskDetail {
  return { ...card, description: null, descriptionTruncated: false, parent: null, members: [], checklists: [], links: [], createdBy: null, createdAt: '', permissions: { canEdit: false, canMove: false, canAssign: false, canTrackTime: false }, webUrl: null };
}

function priorityEl(priority: Priority, t: TasksText): HTMLElement | null {
  if (priority === 'normal') return null;
  return h('span', { class: `prio ${priority}` }, priorityLabel(priority, t));
}

const TAG_COLORS = ['#1f6f54', '#2e5f8a', '#6a4c93', '#a2553a', '#8a6a1f', '#7a3e5c', '#3d6b6b'];

function tagEl(tag: string): HTMLElement {
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return h('span', { class: 'tag', attrs: { style: `--tc:${TAG_COLORS[hash % TAG_COLORS.length]}` } }, tag);
}

function hue(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hue-${hash % 9}`;
}

function emptyState(title: string, hint: string): HTMLElement {
  return h('div', { class: 'empty' }, h('span', { class: 'e-ico', attrs: { 'aria-hidden': 'true' } }, chatIcon('tasks', 'lg')), h('b', {}, title), h('span', {}, hint));
}

function skeleton(count: number): HTMLElement {
  return h('div', { class: 'skel-rows', attrs: { 'aria-hidden': 'true' } }, ...Array.from({ length: count }, (_, i) => h('span', { class: 'skel-row', attrs: { style: `--w:${55 + ((i * 17) % 35)}%` } })));
}
