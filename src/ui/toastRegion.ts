/**
 * The one toast region with *Undo* (UX batch 4, UXA-8, owner approval 2026-11-27): completing a task, moving a card and
 * discarding a chat message can be taken back for a few seconds.
 *
 * - **One named region** (`role="region"`, "Notifications") always in the page, so assistive technology finds every
 *   toast in the same place; it is a `popover="manual"` (top layer, no light dismiss) where the webview has the Popover
 *   API, a fixed layer otherwise (Modern Web Guidance `persistent-toast-notifications`).
 * - **Never steals focus.** A toast is announced politely by its text, with "Undo with Ctrl+Z" (not the names of its
 *   buttons). `Ctrl/⌘+Z` outside a text field takes back the newest one, and the toast's buttons are in the Tab order.
 * - **Undo window** {@link UNDO_MS} (7 s), paused while the pointer or the focus is in the region. A toast that expires
 *   or is closed simply goes: the action stays done.
 * - **Groups.** A module drops its toasts when what they refer to is gone (an organization switch, a disconnect), so an
 *   undo can never act in another organization; each undo callback checks again that its context is still current.
 * - Respects reduced motion (no slide, no fade).
 */
import { h } from './dom';
import { icon } from './icons';

/** How long *Undo* is offered. */
export const UNDO_MS = 7000;
/** Toasts shown at once (the oldest goes first). */
export const MAX_TOASTS = 3;

export interface UndoOffer {
  /** Same key, same toast: a newer offer replaces the older one (two moves of one card are one toast). */
  key: string;
  /** Who offered it (`tasks`, `chat`): dropped together on a context switch. */
  group: string;
  text: string;
  /** Takes the action back. Not called after the toast expired, was closed or its group was dropped. */
  undo(): void;
  /**
   * Text the action put into a text field (a cancelled message back in the message box): `Ctrl/⌘+Z` in that field,
   * while it still holds exactly this text, is this toast's *Undo* (the field has no native undo for it).
   */
  fieldText?: string;
  /** The toast went without *Undo* (expired, closed, replaced or dropped). */
  onClose?(): void;
}

/** What a module needs of the region (the shell passes the {@link ToastRegion}). */
export interface UndoToasts {
  offer(offer: UndoOffer): void;
  dismissGroup(group: string): void;
}

export interface ToastRegionOptions {
  label: string;
  undoLabel: string;
  dismissLabel: string;
  /** Appended to the announcement of a toast: how to undo from the keyboard ("Undo with Ctrl+Z."). */
  undoHint: string;
  /** Polite announcement (the shell's live region), when the webview has no `ariaNotify`. */
  announce(text: string): void;
  durationMs?: number;
  /** Shortcut label of the Undo button's tooltip ("Ctrl+Z" / "⌘Z"). */
  shortcut?: string;
}

interface Shown {
  offer: UndoOffer;
  node: HTMLElement;
  /** Milliseconds left when paused, else the deadline's timer. */
  remaining: number;
  started: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

/** A dialog is open (the app's dialogs are modal): the page behind it is inert, so `Ctrl/⌘+Z` is the dialog's. */
function dialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

function popoverSupported(): boolean {
  return typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');
}

export class ToastRegion {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private shown: Shown[] = [];
  private paused = false;
  /** Where focus was before it entered the region (back there when the last toast goes). */
  private returnFocus: HTMLElement | null = null;
  private readonly duration: number;

  constructor(private readonly options: ToastRegionOptions) {
    this.duration = options.durationMs ?? UNDO_MS;
    this.list = h('ol', { class: 'ut-list' });
    this.root = h('div', { class: 'undo-toasts', id: 'undo-toasts', attrs: { role: 'region', 'aria-label': options.label, hidden: true } }, this.list);
    if (popoverSupported()) this.root.setAttribute('popover', 'manual');
    let hovered = false;
    const pause = () => this.pause();
    const resume = () => {
      // Still inside (focus moved between two toasts, or the pointer is over the region): keep waiting.
      if (hovered || this.root.contains(document.activeElement)) return;
      this.resume();
    };
    this.root.addEventListener('pointerenter', () => {
      hovered = true;
      pause();
    });
    this.root.addEventListener('pointerleave', () => {
      hovered = false;
      resume();
    });
    this.root.addEventListener('focusin', (event) => {
      const from = event.relatedTarget;
      if (from instanceof HTMLElement && !this.root.contains(from)) this.returnFocus = from;
      pause();
    });
    this.root.addEventListener('focusout', (event) => {
      if (!(event.relatedTarget instanceof Node && this.root.contains(event.relatedTarget))) setTimeout(resume, 0);
    });
    document.addEventListener('keydown', (event) => this.onKey(event));
  }

  /** The toasts shown now, newest last (tests, the shell). */
  get offers(): readonly UndoOffer[] {
    return this.shown.map((item) => item.offer);
  }

  /** Shows a toast with *Undo* (announced, never focused). */
  offer(offer: UndoOffer): void {
    const existing = this.shown.find((item) => item.offer.key === offer.key);
    if (existing !== undefined) this.remove(existing, false);
    while (this.shown.length >= MAX_TOASTS) this.remove(this.shown[0], false);
    const id = `ut-${this.shown.length}-${Date.now().toString(36)}`;
    const undo = h(
      'button',
      {
        class: 'ut-undo',
        attrs: { type: 'button', 'aria-describedby': `${id}-text`, 'aria-keyshortcuts': 'Control+Z Meta+Z', title: this.options.shortcut !== undefined ? `${this.options.undoLabel} (${this.options.shortcut})` : undefined },
      },
      this.options.undoLabel,
    );
    const close = h('button', { class: 'ut-close', attrs: { type: 'button', 'aria-label': this.options.dismissLabel, title: this.options.dismissLabel } }, icon('close'));
    const node = h('li', { class: 'ut', attrs: { 'data-key': offer.key } }, h('span', { class: 'ut-text', id: `${id}-text` }, offer.text), undo, close);
    const item: Shown = { offer, node, remaining: this.duration, started: Date.now(), timer: null };
    undo.addEventListener('click', () => this.undo(item));
    close.addEventListener('click', () => this.remove(item, true));
    this.shown.push(item);
    this.list.append(node);
    this.open();
    if (!this.paused) this.arm(item);
    this.notify(`${offer.text}. ${this.options.undoHint}`);
  }

  /** Drops a group's toasts without undoing (its context is gone). */
  dismissGroup(group: string): void {
    for (const item of this.shown.filter((entry) => entry.offer.group === group)) this.remove(item, false);
  }

  /** Drops one toast without undoing. */
  dismiss(key: string): void {
    const item = this.shown.find((entry) => entry.offer.key === key);
    if (item !== undefined) this.remove(item, false);
  }

  /** Takes back the newest toast's action (`Ctrl/⌘+Z`). */
  undoLatest(): boolean {
    const item = this.shown.at(-1);
    if (item === undefined) return false;
    this.undo(item);
    return true;
  }

  private onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    const latest = this.shown.at(-1);
    if (latest === undefined || dialogOpen()) return;
    if (editable(event.target)) {
      const field = event.target;
      const value = field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement ? field.value : null;
      if (latest.offer.fieldText === undefined || value !== latest.offer.fieldText) return;
    }
    event.preventDefault();
    this.undoLatest();
  }

  private undo(item: Shown): void {
    if (!this.shown.includes(item)) return;
    this.remove(item, true, true);
    item.offer.undo();
  }

  private arm(item: Shown): void {
    item.started = Date.now();
    item.timer = setTimeout(() => this.remove(item, false), item.remaining);
  }

  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    const now = Date.now();
    for (const item of this.shown) {
      if (item.timer !== null) clearTimeout(item.timer);
      item.timer = null;
      item.remaining = Math.max(1000, item.remaining - (now - item.started));
    }
  }

  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const item of this.shown) this.arm(item);
  }

  /** Removes a toast; `user`: closed or undone by the person (focus moves to the next toast or back). */
  private remove(item: Shown, user: boolean, undone = false): void {
    const index = this.shown.indexOf(item);
    if (index < 0) return;
    if (item.timer !== null) clearTimeout(item.timer);
    if (!undone) item.offer.onClose?.();
    const hadFocus = item.node.contains(document.activeElement);
    this.shown.splice(index, 1);
    item.node.remove();
    if (this.shown.length === 0) {
      this.close();
      this.paused = false;
    }
    if (hadFocus || (user && this.root.contains(document.activeElement))) {
      const next = this.shown[Math.min(index, this.shown.length - 1)];
      const target = next?.node.querySelector<HTMLElement>('.ut-undo') ?? (this.returnFocus?.isConnected === true ? this.returnFocus : null);
      target?.focus({ preventScroll: true });
      if (this.shown.length === 0) this.returnFocus = null;
    }
  }

  private open(): void {
    this.root.hidden = false;
    if (this.root.hasAttribute('popover')) {
      try {
        if (!this.root.matches(':popover-open')) this.root.showPopover();
      } catch {
        // Not connected yet, or no top layer: the fixed layer shows it.
      }
    }
  }

  private close(): void {
    if (this.root.hasAttribute('popover')) {
      try {
        if (this.root.matches(':popover-open')) this.root.hidePopover();
      } catch {
        // Already hidden.
      }
    }
    this.root.hidden = true;
  }

  private notify(text: string): void {
    const doc = document as Document & { ariaNotify?: (text: string, options?: { priority?: 'normal' | 'high' }) => void };
    if (typeof doc.ariaNotify === 'function') doc.ariaNotify(text, { priority: 'normal' });
    else this.options.announce(text);
  }
}
