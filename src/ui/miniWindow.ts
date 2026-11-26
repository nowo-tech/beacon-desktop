/**
 * The mini timer (owner Q2, BD-3a): a small always-on-top window (`index.html?window=mini`, src-tauri/src/mini.rs)
 * with the running task, its organization, the elapsed time, Start / Stop and "Open Beacon Desktop". It holds no
 * session and no network: the main window sends what to show (`MiniView`, already translated) and gets the buttons
 * back as actions; every decision (required fields, offline queue) stays in the main window.
 *
 * Keyboard: Tab between the two buttons, Enter / Space press them, `Ctrl/⌘+Shift+S` start / stop, `Ctrl/⌘+Shift+M`
 * back to the app, `Esc` closes the mini timer. The time runs in a fixed-width tabular figure (no layout shift).
 */
import { applyTheme, type ThemePreference } from '../lib/theme';
import { h } from './dom';
import { chatIcon } from '../chat/icons';

/** What the main window shows in the mini timer. Labels come translated; times are ISO strings. */
export interface MiniView {
  theme: ThemePreference;
  lang: string;
  windowTitle: string;
  running: boolean;
  task: string | null;
  startedAt: string | null;
  /** "Tracking · Lumen Works" / "Not tracking". */
  status: string;
  /** The Start button resumes this task (`null`: nothing to resume, the button is disabled with `noTask`). */
  canStart: boolean;
  busy: boolean;
  labels: { stop: string; start: string; startTask: string; expand: string; close: string; noTask: string; elapsed: string };
}

/** The buttons of the mini timer (src-tauri/src/mini.rs accepts these only). `closed`: the window went away. */
export type MiniAction = 'start' | 'stop' | 'expand' | 'close' | 'closed';
export const MINI_ACTIONS: readonly MiniAction[] = ['start', 'stop', 'expand', 'close'];

export interface MiniClient {
  view(): Promise<MiniView | null>;
  onView(handler: (view: MiniView) => void): void;
  action(action: MiniAction): Promise<void>;
}

export function clockText(startedAt: string | null, now: number): string {
  const seconds = startedAt === null ? 0 : Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export class MiniTimer {
  readonly root: HTMLElement;
  private view: MiniView | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** The control that last had focus: restored after a render even if focus fell to the page meanwhile. */
  private focusId: string | null = null;

  constructor(
    mount: HTMLElement,
    private readonly client: MiniClient,
    private readonly now: () => number = () => Date.now(),
  ) {
    document.documentElement.classList.add('mini-window');
    this.root = h('main', { class: 'mini-timer', id: 'mini-timer' });
    mount.replaceChildren(this.root);
    this.root.addEventListener('focusin', (event) => {
      const id = (event.target as HTMLElement | null)?.id;
      if (id) this.focusId = id;
    });
    document.addEventListener('keydown', (event) => this.onKey(event));
  }

  show(view: MiniView | null): void {
    this.view = view;
    if (view !== null) {
      applyTheme(view.theme);
      document.documentElement.lang = view.lang;
      document.title = view.windowTitle;
    }
    this.render();
    this.syncTicker();
  }

  private send(action: MiniAction): void {
    void this.client.action(action).catch(() => undefined);
  }

  private render(): void {
    const view = this.view;
    if (view === null) {
      this.root.replaceChildren();
      return;
    }
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement.id : null;
    const time = clockText(view.running ? view.startedAt : null, this.now());
    // Busy: `aria-disabled`, never `disabled`, so keyboard focus stays on the button across Stop / Resume (ZCD-L5).
    const busy = view.busy ? 'true' : undefined;
    const main = view.running
      ? h('button', { class: 'mt-btn stop', id: 'mini-toggle', attrs: { type: 'button', 'aria-disabled': busy, 'aria-keyshortcuts': 'Control+Shift+S Meta+Shift+S' } }, chatIcon('stop', 'sm'), view.labels.stop)
      : h(
          'button',
          { class: 'mt-btn start', id: 'mini-toggle', attrs: { type: 'button', disabled: !view.canStart, 'aria-disabled': busy, 'aria-keyshortcuts': 'Control+Shift+S Meta+Shift+S', 'aria-label': view.canStart ? view.labels.startTask : view.labels.start, 'aria-describedby': view.canStart ? undefined : 'mini-hint' } },
          chatIcon('play', 'sm'),
          view.labels.start,
        );
    main.addEventListener('click', () => {
      if (this.view?.busy) return;
      this.send(view.running ? 'stop' : 'start');
    });
    const expand = h('button', { class: 'mt-icon', id: 'mini-expand', attrs: { type: 'button', 'aria-label': view.labels.expand, title: view.labels.expand, 'aria-keyshortcuts': 'Control+Shift+M Meta+Shift+M' } }, chatIcon('expand', 'sm'));
    expand.addEventListener('click', () => this.send('expand'));
    this.root.dataset.running = view.running ? 'true' : 'false';
    this.root.setAttribute('aria-busy', view.busy ? 'true' : 'false');
    this.root.replaceChildren(
      h('p', { class: 'mt-status', id: 'mini-status' }, view.running ? h('span', { class: 'tp-dot', attrs: { 'aria-hidden': 'true' } }) : null, h('span', { class: 'mt-status-t' }, view.status)),
      h('p', { class: 'mt-task', id: 'mini-task', attrs: { title: view.task ?? '' } }, view.task ?? ' '),
      h(
        'div',
        { class: 'mt-row' },
        h('span', { class: 'mt-time', id: 'mini-time', attrs: { role: 'timer', 'aria-label': `${view.labels.elapsed} ${time}` } }, time),
        main,
        expand,
      ),
      h('p', { class: 'mt-hint', id: 'mini-hint', attrs: { hidden: view.running || view.canStart } }, view.labels.noTask),
    );
    const target = focused ?? (document.activeElement === document.body || document.activeElement === null ? this.focusId : null);
    if (target) this.root.querySelector<HTMLElement>(`#${target}`)?.focus();
  }

  private syncTicker(): void {
    const running = this.view?.running === true && this.view.startedAt !== null;
    if (running && this.ticker === null) {
      this.ticker = setInterval(() => {
        const node = this.root.querySelector('#mini-time');
        const view = this.view;
        if (node === null || view === null || !view.running) return;
        const text = clockText(view.startedAt, this.now());
        node.textContent = text;
        // The accessible name changes once a minute, not every second (a `timer` role is not live by default).
        if (text.endsWith(':00')) node.setAttribute('aria-label', `${view.labels.elapsed} ${text}`);
      }, 1000);
    } else if (!running && this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private onKey(event: KeyboardEvent): void {
    const view = this.view;
    if (view === null) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.send('close');
    } else if (mod && event.shiftKey && key === 's') {
      event.preventDefault();
      if (view.busy) return;
      if (view.running) this.send('stop');
      else if (view.canStart) this.send('start');
    } else if (mod && event.shiftKey && key === 'm') {
      event.preventDefault();
      this.send('expand');
    }
  }
}

/** Entry of the mini timer window: draws the main window's view and reports the buttons. */
export async function startMiniWindow(root: HTMLElement, client: MiniClient): Promise<MiniTimer> {
  const mini = new MiniTimer(root, client);
  client.onView((view) => mini.show(view));
  mini.show(await client.view());
  return mini;
}
