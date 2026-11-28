/**
 * One status strip per module (UX batch 4, UXA-7, owner approval 2026-11-27): offline, `429`, load errors and short
 * notices of Chat, Tasks and Time share one look and one behaviour.
 *
 * - **No layout shift.** The strip's slot keeps its height whether a message shows or not (`.status-strip`, one line),
 *   so a message never pushes the list down (CLS ≈ 0).
 * - **One message at a time**, the most severe first ({@link pickMessage}): `danger` (a load error), then `warn`
 *   (offline, a refused write), then `info` (a pause after a `429`, reconnecting).
 * - **Polite.** A new message is announced once, by text only (never the names of its buttons); a countdown updates
 *   its text every second without announcing it again.
 * - **Retry / dismiss.** An optional action button and a close button; a dismissed message stays hidden until the
 *   message changes.
 * - Transient states have no mascot art (mascots are for empty and celebration moments).
 * - **Tall windows only reserve the band** (0.14.1, owner approval 2026-11-28; strips made with `overlay: true`): from
 *   {@link TALL_MIN_HEIGHT} px of inner height up the slot keeps its 36 px; below it the slot takes no room and a message
 *   overlays the bottom of its pane (above the chat's composer, never over it). Nothing reflows when a message comes or
 *   goes in either mode, and a resize across the threshold waits while a message shows (no jump under the reader).
 */
import { type Child, h, patch } from './dom';
import { icon } from './icons';

export type StripTone = 'info' | 'warn' | 'danger';

/** Inner window height (px) from which an overlay-capable strip keeps its band reserved (0.14.1). */
export const TALL_MIN_HEIGHT = 720;
export const TALL_QUERY = `(min-height: ${TALL_MIN_HEIGHT}px)`;

/** `reserved`: the 36 px band is always there; `overlay`: no band, a message overlays the pane's bottom. */
export type StripMode = 'reserved' | 'overlay';

/** The part of `MediaQueryList` the strip uses (tests pass a fake one). */
export interface TallQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
}

export interface StripAction {
  id: string;
  label: string;
  onClick(): void;
  /** Shown but not usable yet (Retry before a `Retry-After` ends). */
  disabled?: boolean;
}

export interface StripMessage {
  /** Identity of the message: what "dismissed" and "announced" remember. Same key, same message. */
  key: string;
  /** The text, or a countdown's text from the milliseconds left (`until`). */
  text: string | ((remainingMs: number) => string);
  tone: StripTone;
  /** A countdown's end (the clock's milliseconds): the text is redrawn every second until then. */
  until?: number;
  /** The countdown reached zero (once). */
  onElapsed?: () => void;
  action?: StripAction;
  /** Default true. */
  dismissible?: boolean;
  /** An id for the text (kept from the cards it replaces, e.g. Time's `offline`). */
  textId?: string;
}

const RANK: Record<StripTone, number> = { danger: 3, warn: 2, info: 1 };

/** The one message to show: the most severe, the first listed among equals. */
export function pickMessage(candidates: readonly (StripMessage | null | undefined | false)[]): StripMessage | null {
  let best: StripMessage | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === false) continue;
    if (best === null || RANK[candidate.tone] > RANK[best.tone]) best = candidate;
  }
  return best;
}

/** `m:ss` of what is left (rounded up, never below 0:00): "0:25", "1:05". */
export function formatCountdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The modules' clock (`SyncClock` of chat and tasks fits): tests drive countdowns with a fake one. */
export interface StripClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: StripClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface StatusStripOptions {
  /** Id of the message box (`<id>`), its text (`<id>-text`) and close button (`<id>-dismiss`). */
  id: string;
  /** Accessible name of the close button. */
  dismissLabel: string;
  /** Polite announcement (the shell's live region). */
  announce?(text: string): void;
  /** The close button was pressed (after the strip hid the message). */
  onDismiss?(message: StripMessage): void;
  /** Focus was in the message when it went: where it goes instead. */
  focusAway?(): void;
  clock?: StripClock;
  /** Reserve the band only in tall windows, overlay below ({@link TALL_MIN_HEIGHT}). Default false: always reserved. */
  overlay?: boolean;
  /** The tall-window query (default `matchMedia(TALL_QUERY)`; none: always reserved). */
  tall?: TallQuery | null;
  /** The mode changed (applied, never while a message shows). */
  onMode?(mode: StripMode): void;
}

export class StatusStrip {
  /** The slot: always in the layout, one line high. */
  readonly root: HTMLElement;
  /** The message box (hidden when there is nothing to say). */
  readonly box: HTMLElement;
  private message: StripMessage | null = null;
  private dismissed: string | null = null;
  private announced: string | null = null;
  private ticker: unknown = null;
  private textNode: HTMLElement | null = null;
  private readonly clock: StripClock;
  private readonly tall: TallQuery | null;
  /** The mode in use; a change of window height while a message shows waits for it to go. */
  mode: StripMode = 'reserved';

  constructor(private readonly options: StatusStripOptions) {
    this.clock = options.clock ?? realClock;
    this.box = h('div', { class: 'ss-box', id: options.id, attrs: { hidden: true } });
    this.root = h('div', { class: 'status-strip', id: `${options.id}-strip` }, this.box);
    this.tall = options.overlay === true ? (options.tall !== undefined ? options.tall : (globalThis.matchMedia?.(TALL_QUERY) ?? null)) : null;
    this.applyMode();
    this.tall?.addEventListener('change', () => {
      if (this.current === null) this.applyMode();
    });
  }

  /** The mode the window height asks for now. */
  private wantedMode(): StripMode {
    return this.tall !== null && !this.tall.matches ? 'overlay' : 'reserved';
  }

  private applyMode(): void {
    const mode = this.wantedMode();
    const changed = this.root.dataset.mode !== undefined && mode !== this.mode;
    this.mode = mode;
    this.root.dataset.mode = mode;
    if (changed) this.options.onMode?.(mode);
  }

  /** The message shown now (`null`: none, or dismissed). */
  get current(): StripMessage | null {
    return this.message !== null && this.message.key !== this.dismissed ? this.message : null;
  }

  /** Shows `message` (or nothing). A dismissed message stays hidden until another one replaces it. */
  show(message: StripMessage | null): void {
    if (message === null || message.key !== this.dismissed) this.dismissed = null;
    this.message = message;
    this.draw();
  }

  /** Hides the message shown now (the close button). */
  dismiss(): void {
    const message = this.current;
    if (message === null) return;
    this.dismissed = message.key;
    this.draw();
    this.options.onDismiss?.(message);
  }

  /** Stops the countdown (the module goes away). */
  destroy(): void {
    this.stopTicker();
  }

  private textOf(message: StripMessage): string {
    return typeof message.text === 'function' ? message.text(Math.max(0, (message.until ?? 0) - this.clock.now())) : message.text;
  }

  private draw(): void {
    const message = this.current;
    this.stopTicker();
    if (message === null) {
      const had = this.box.contains(document.activeElement);
      this.box.replaceChildren();
      this.box.hidden = true;
      this.root.removeAttribute('data-tone');
      this.announced = null;
      this.textNode = null;
      // A window resized across the threshold while the message showed: the new mode now, with nothing on screen.
      if (this.mode !== this.wantedMode()) this.applyMode();
      if (had) this.options.focusAway?.();
      return;
    }
    const text = this.textOf(message);
    this.textNode = h('span', { class: 'ss-text', id: message.textId ?? `${this.options.id}-text`, attrs: { title: text } }, text);
    const nodes: Child[] = [h('span', { class: 'ss-ico', attrs: { 'aria-hidden': 'true' } }, icon(message.tone === 'info' ? 'clock' : 'alert')), this.textNode];
    if (message.action !== undefined) {
      const action = message.action;
      nodes.push(
        h('button', { class: 'ss-action', id: action.id, key: action.id, attrs: { type: 'button', disabled: action.disabled === true || undefined }, on: { click: () => action.onClick() } }, action.label),
      );
    }
    if (message.dismissible !== false) {
      nodes.push(
        h('button', { class: 'ss-close', id: `${this.options.id}-dismiss`, key: `${this.options.id}-dismiss`, attrs: { type: 'button', 'aria-label': this.options.dismissLabel, title: this.options.dismissLabel }, on: { click: () => this.dismiss() } }, icon('close')),
      );
    }
    this.box.className = `ss-box ${message.tone}`;
    this.root.dataset.tone = message.tone;
    patch(this.box, nodes);
    this.box.hidden = false;
    if (this.announced !== message.key) {
      this.announced = message.key;
      this.options.announce?.(text);
    }
    if (message.until !== undefined) this.startTicker(message);
  }

  private startTicker(message: StripMessage): void {
    const step = () => {
      this.ticker = null;
      if (this.current !== message) return;
      const remaining = (message.until ?? 0) - this.clock.now();
      if (this.textNode !== null) {
        const text = this.textOf(message);
        this.textNode.textContent = text;
        this.textNode.title = text;
      }
      if (remaining <= 0) message.onElapsed?.();
      else this.ticker = this.clock.setTimeout(step, remaining % 1000 || 1000);
    };
    if ((message.until ?? 0) - this.clock.now() <= 0) {
      message.onElapsed?.();
      return;
    }
    this.ticker = this.clock.setTimeout(step, ((message.until ?? 0) - this.clock.now()) % 1000 || 1000);
  }

  private stopTicker(): void {
    if (this.ticker !== null) this.clock.clearTimeout(this.ticker);
    this.ticker = null;
  }
}
