/**
 * The message composer (BD-3b, approved prototype): a form with a labelled textarea, a formatting toolbar (Markdown as
 * the web dock writes it), a hint, a character counter near the limit and a send button.
 *
 * - **Enter** sends, **Shift+Enter** adds a line, **Ctrl/Cmd+Enter** sends too. Neither sends while an IME is
 *   composing (`isComposing`, or `keyCode` 229 for WebKit's out-of-order event; Modern Web Guidance
 *   `ime-safe-enter-submit`). The send button is a real submit button: the keys are shortcuts, not the only path.
 * - **Ctrl/Cmd+B / I / E** and **Ctrl/Cmd+Shift+C** wrap the selection in bold, italic, code and a code block.
 * - **↑** in an empty composer moves to the last message (then E reacts, R replies); **Esc** is the caller's.
 * - The field grows with its text (`field-sizing: content`, with a height fallback where it is not supported) up to
 *   about eight lines.
 * - The counter appears 500 characters before the limit; over it the field is invalid and the button is off.
 * - The text is the person's draft: the caller keeps it in memory per conversation (never on disk).
 */
import { h } from '../ui/dom';
import type { ChatText } from './i18n';
import { type ChatIconName, chatIcon } from './icons';

export interface ComposerOptions {
  t: ChatText;
  /** Unique per composer (`composer`, `thread-composer`): the textarea's id. */
  id: string;
  placeholder: string;
  maxLength: number;
  /** The draft to start with. */
  draft: string;
  /** Sends the trimmed text; answers whether it was taken (the field is then cleared). */
  onSend(text: string): boolean;
  /** The draft changed (kept by the caller, in memory). */
  onDraft(text: string): void;
  /** ↑ in an empty field. */
  onArrowUp?(): void;
  /** Esc in the field (closing the thread, leaving): answers whether it was handled. */
  onEscape?(): boolean;
}

const WARN_BEFORE = 500;

type Format = { icon: ChatIconName; label: 'fmtBold' | 'fmtItalic' | 'fmtCode' | 'fmtCodeBlock' | 'fmtList' | 'fmtLink'; keys: string | null; apply(field: HTMLTextAreaElement): void };

/** Wraps the selection (or a placeholder word, selected) in `before` / `after`. */
export function wrapSelection(field: HTMLTextAreaElement, before: string, after: string, fallback: string): void {
  const start = field.selectionStart;
  const end = field.selectionEnd;
  const middle = field.value.slice(start, end) || fallback;
  field.setRangeText(`${before}${middle}${after}`, start, end, 'end');
  field.setSelectionRange(start + before.length, start + before.length + middle.length);
}

/** Starts a list item at the caret's line. */
export function insertListItem(field: HTMLTextAreaElement): void {
  const start = field.selectionStart;
  const lineStart = field.value.lastIndexOf('\n', start - 1) + 1;
  const prefix = start === lineStart ? '- ' : '\n- ';
  field.setRangeText(prefix, start, field.selectionEnd, 'end');
}

const FORMATS: Format[] = [
  { icon: 'bold', label: 'fmtBold', keys: 'B', apply: (field) => wrapSelection(field, '**', '**', 'text') },
  { icon: 'italic', label: 'fmtItalic', keys: 'I', apply: (field) => wrapSelection(field, '_', '_', 'text') },
  { icon: 'code', label: 'fmtCode', keys: 'E', apply: (field) => wrapSelection(field, '`', '`', 'code') },
  { icon: 'codeblock', label: 'fmtCodeBlock', keys: 'Shift+C', apply: (field) => wrapSelection(field, '```\n', '\n```', 'code') },
  { icon: 'list', label: 'fmtList', keys: null, apply: insertListItem },
  { icon: 'link', label: 'fmtLink', keys: null, apply: (field) => wrapSelection(field, '[', '](https://)', 'text') },
];

export class Composer {
  readonly root: HTMLElement;
  readonly field: HTMLTextAreaElement;
  private readonly form: HTMLFormElement;
  private readonly count: HTMLElement;
  private readonly send: HTMLButtonElement;
  private readonly fits = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

  constructor(private readonly options: ComposerOptions) {
    const t = options.t;
    const hintId = `${options.id}-hint`;
    const countId = `${options.id}-count`;
    this.field = h('textarea', {
      id: options.id,
      class: 'c-field',
      attrs: { rows: '1', placeholder: options.placeholder, 'aria-describedby': `${hintId} ${countId}`, spellcheck: 'true', autocomplete: 'off', enterkeyhint: 'send' },
    });
    this.field.value = options.draft;
    const mod = modKey();
    const toolbar = h('div', { class: 'fmt', attrs: { role: 'toolbar', 'aria-label': t('fmtToolbar'), 'aria-controls': options.id } });
    FORMATS.forEach((format, index) => {
      const label = t(format.label);
      const shortcut = format.keys === null ? null : `${mod}+${format.keys}`;
      const button = h('button', { attrs: { type: 'button', 'aria-label': label, title: shortcut === null ? label : `${label} (${shortcut})`, tabindex: index === 0 ? '0' : '-1', 'aria-keyshortcuts': shortcut === null ? undefined : ariaKeys(format.keys as string) } }, chatIcon(format.icon, 'sm'));
      button.addEventListener('click', () => {
        format.apply(this.field);
        this.field.focus();
        this.update();
      });
      toolbar.append(button);
      if (index === 3) toolbar.append(h('span', { class: 'sep', attrs: { 'aria-hidden': 'true' } }));
    });
    toolbar.addEventListener('keydown', (event) => roveToolbar(event, toolbar));
    this.count = h('span', { class: 'count', id: countId });
    this.send = h('button', { class: 'send', attrs: { type: 'submit', 'aria-label': t('send'), title: t('send') } }, chatIcon('send', 'sm'));
    const label = h('label', { class: 'sr-only', attrs: { for: options.id } }, options.placeholder);
    const foot = h('div', { class: 'c-foot' }, h('span', { class: 'hint', id: hintId }, t('composerHint')), this.count, this.send);
    this.form = h('form', { class: 'composer', attrs: { 'aria-label': options.placeholder, novalidate: true } }, label, toolbar, this.field, foot);
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.field.addEventListener('input', () => this.update());
    // A long text scrolls under the formatting toolbar: a top shadow says there is more above (UXA-39). A textarea has
    // no pseudo-elements for a scroll-state query, so its own scroll position drives the class.
    this.field.addEventListener('scroll', () => this.markScrolled(), { passive: true });
    this.field.addEventListener('keydown', (event) => this.onKey(event));
    this.root = h('div', { class: 'composer-wrap' }, this.form);
    this.update(false);
  }

  /** The trimmed text, if it can be sent now. */
  private sendable(): string | null {
    const text = this.field.value.trim();
    return text === '' || [...text].length > this.options.maxLength ? null : text;
  }

  submit(): void {
    const text = this.sendable();
    if (text === null) return;
    if (!this.options.onSend(text)) return;
    this.field.value = '';
    this.update();
    this.field.focus();
  }

  /** Puts text back (a message that was refused: *Edit*). */
  setText(text: string): void {
    this.field.value = text;
    this.update();
    this.field.focus();
    this.field.setSelectionRange(text.length, text.length);
  }

  focus(): void {
    this.field.focus({ preventScroll: true });
  }

  private onKey(event: KeyboardEvent): void {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Enter' && (mod || !event.shiftKey)) {
      // Never while an IME is composing, with or without Ctrl / Cmd (audit ZDG-I5).
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      this.submit();
      return;
    }
    if (mod && !event.altKey) {
      const format = event.shiftKey ? (key === 'c' ? FORMATS[3] : null) : key === 'b' ? FORMATS[0] : key === 'i' ? FORMATS[1] : key === 'e' ? FORMATS[2] : null;
      if (format !== null) {
        event.preventDefault();
        format.apply(this.field);
        this.update();
      }
      return;
    }
    if (event.key === 'ArrowUp' && this.field.value === '' && this.options.onArrowUp !== undefined) {
      event.preventDefault();
      this.options.onArrowUp();
      return;
    }
    if (event.key === 'Escape' && this.options.onEscape?.() === true) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private update(draft = true): void {
    const length = [...this.field.value.trim()].length;
    const left = this.options.maxLength - length;
    const over = left < 0;
    this.count.textContent = left <= WARN_BEFORE ? (over ? this.options.t('charsOver', { count: -left }) : this.options.t('charsLeft', { count: left })) : '';
    this.count.classList.toggle('over', over);
    this.field.setAttribute('aria-invalid', over ? 'true' : 'false');
    this.send.disabled = this.sendable() === null;
    if (!this.fits) {
      this.field.style.height = 'auto';
      this.field.style.height = `${Math.min(this.field.scrollHeight, 180)}px`;
    }
    this.markScrolled();
    if (draft) this.options.onDraft(this.field.value);
  }

  private markScrolled(): void {
    this.form.classList.toggle('scrolled', this.field.scrollTop > 0);
  }
}

/** One tab stop for the toolbar; ← → Home End move between its buttons (WAI-ARIA toolbar pattern). */
function roveToolbar(event: KeyboardEvent, toolbar: HTMLElement): void {
  const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  let next: number;
  if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else return;
  event.preventDefault();
  for (const button of buttons) button.tabIndex = -1;
  buttons[next].tabIndex = 0;
  buttons[next].focus();
}

function ariaKeys(keys: string): string {
  return `Control+${keys} Meta+${keys}`;
}

function modKey(): string {
  return /mac/i.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl';
}

