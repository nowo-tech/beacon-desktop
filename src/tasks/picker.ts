/**
 * A menu button for the Tasks module (UX audit UXA-17, UXA-38, UXA-16): the board switcher, the task panel's status,
 * priority and assignee, the list's status pills and the narrow toolbar's overflow menu. It replaces native selects
 * that could not be styled with the shell's tokens.
 *
 * Pattern (Modern Web Guidance `menu`): a plain button with `aria-haspopup="menu"` and `aria-expanded`, the menu right
 * after it, `popover="manual"` where the webview has the Popover API (top layer; Esc and outside presses are handled
 * here so Esc never also closes the task panel), else a fixed `hidden` box. The webviews this app runs in (WebKitGTK, WKWebView, WebView2) do not all have `focusgroup` or anchor
 * positioning, so roles, arrow keys and placement come from script: `role="menu"`, `menuitemradio` /
 * `menuitemcheckbox` / `menuitem`, ↑ ↓ Home End and type-ahead, Esc returns focus to the button, Tab leaves. A keyboard
 * open (Enter, Space, ↓, ↑) moves focus into the menu (to the checked item); a pointer open keeps it on the button.
 */
import { chatIcon } from '../chat/icons';
import { type Child, h } from '../ui/dom';

export type MenuItem =
  | { kind: 'radio'; value: string; label: string; lead?: Child; hint?: string; group?: string }
  | { kind: 'check'; value: string; label: string; checked: boolean; lead?: Child }
  | { kind: 'command'; value: string; label: string; lead?: Child };

export interface MenuButtonSpec {
  /** The button's id; the menu is `<id>-menu`. */
  id: string;
  /** Focus key across re-renders (`data-key`). */
  key: string;
  className: string;
  /**
   * The menu's name. The button's name is `<label>: <what it shows>` (the label as visually hidden text, so the name
   * always contains the visible text, WCAG 2.5.3); an icon-only (`bare`) button is named `label`.
   */
  label: string;
  title?: string;
  /** What the button shows (a chevron is added unless `bare`). */
  content: Child[];
  bare?: boolean;
  items: MenuItem[];
  /** The checked radio item. */
  value?: string;
  disabled?: boolean;
  /** Menu alignment against the button. */
  align?: 'start' | 'end';
  onPick(value: string): void;
}

interface OpenMenu {
  close(restore: boolean): void;
  /** The button's id and the item that had focus (to open the same menu again after a re-render). */
  id: string;
  focused: string | null;
  connected(): boolean;
}

/** How each button opens its menu (`reopenMenus` uses it on the re-rendered button). */
const openers = new WeakMap<HTMLElement, (enter: string | null) => void>();

/** One menu open at a time across the module. */
let current: OpenMenu | null = null;

const ITEM_SELECTOR = '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]';

function supportsPopover(menu: HTMLElement): boolean {
  return typeof menu.showPopover === 'function';
}

/** The trigger and its menu, in one inline wrapper (the menu right after the button). */
export function menuButton(spec: MenuButtonSpec): HTMLElement {
  const trigger = h(
    'button',
    {
      class: `mb-trigger ${spec.className}`,
      id: spec.id,
      key: spec.key,
      attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': `${spec.id}-menu`, 'aria-label': spec.bare === true ? spec.label : undefined, title: spec.title, disabled: spec.disabled || undefined },
    },
    spec.bare === true ? null : h('span', { class: 'sr-only' }, `${spec.label}: `),
    ...spec.content,
    spec.bare === true ? null : h('span', { class: 'mb-chev', attrs: { 'aria-hidden': 'true' } }, chatIcon('chev', 'xs')),
  );
  const menu = h('div', { class: 'mb-menu', id: `${spec.id}-menu`, attrs: { role: 'menu', 'aria-label': spec.label, tabindex: '-1' } });
  const native = supportsPopover(menu);
  // `manual`: the top layer without the browser's own Esc and light dismiss, which closed the menu before the task
  // panel's Esc handler could tell (Esc closed both). This script closes it on Esc, a press outside, Tab, scroll.
  if (native) menu.setAttribute('popover', 'manual');
  else menu.hidden = true;
  let groupBox: HTMLElement | null = null;
  let groupName: string | undefined;
  for (const item of spec.items) {
    const button = renderItem(item, spec.value);
    button.addEventListener('click', () => pick(item));
    const group = item.kind === 'radio' ? item.group : undefined;
    if (group !== undefined && group !== '') {
      if (groupBox === null || group !== groupName) {
        groupName = group;
        groupBox = h('div', { class: 'mb-group', attrs: { role: 'group', 'aria-label': group } }, h('div', { class: 'mb-group-h', attrs: { 'aria-hidden': 'true' } }, group));
        menu.append(groupBox);
      }
      groupBox.append(button);
    } else {
      groupBox = null;
      groupName = undefined;
      menu.append(button);
    }
  }
  const wrap = h('span', { class: 'mb' }, trigger, menu);

  let shown = false;
  let cleanup: AbortController | null = null;
  let wasOpen = false;
  let typed = '';
  let typedAt = 0;

  const items = () => [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];

  const close = (restore: boolean) => {
    if (!shown) return;
    shown = false;
    cleanup?.abort();
    cleanup = null;
    if (current === state) current = null;
    trigger.setAttribute('aria-expanded', 'false');
    // `shown` is set first, so the toggle event this fires is ignored; hiding a closed popover does nothing.
    if (native) {
      try {
        menu.hidePopover();
      } catch {
        // Removed by a re-render: the browser already hid it.
      }
    } else menu.hidden = true;
    if (restore && trigger.isConnected) trigger.focus();
  };
  const state: OpenMenu = { close, id: spec.id, focused: null, connected: () => wrap.isConnected };

  const place = () => {
    const box = trigger.getBoundingClientRect();
    const own = menu.getBoundingClientRect();
    const width = globalThis.innerWidth || 800;
    const height = globalThis.innerHeight || 600;
    let top = box.bottom + 4;
    if (top + own.height > height - 8 && box.top - 4 - own.height >= 8) top = box.top - 4 - own.height;
    const start = spec.align === 'end' ? box.right - own.width : box.left;
    const left = Math.max(8, Math.min(start, width - own.width - 8));
    menu.style.minWidth = `${Math.round(box.width)}px`;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(Math.max(8, top))}px`;
  };

  const open = (enter: 'checked' | 'first' | 'last' | `value:${string}` | null) => {
    if (shown || trigger.disabled) return;
    current?.close(false);
    shown = true;
    current = state;
    state.focused = null;
    trigger.setAttribute('aria-expanded', 'true');
    if (native) menu.showPopover();
    else menu.hidden = false;
    place();
    cleanup = new AbortController();
    const signal = cleanup.signal;
    // A press outside or a resize closes it; a scroll (the panel, the board, a late scroll event from a focus move)
    // moves it with its button instead.
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!wrap.contains(event.target as Node | null)) close(false);
      },
      { capture: true, signal },
    );
    document.addEventListener(
      'scroll',
      (event) => {
        if (!menu.contains(event.target as Node | null)) place();
      },
      { capture: true, passive: true, signal },
    );
    globalThis.addEventListener('resize', () => close(false), { signal });
    if (enter !== null && enter.startsWith('value:')) (menu.querySelector<HTMLElement>(`[data-value="${CSS.escape(enter.slice(6))}"]`) ?? trigger).focus();
    else if (enter !== null) focusItem(enter as 'checked' | 'first' | 'last');
  };
  openers.set(trigger, (value) => open(value === null ? null : `value:${value}`));
  menu.addEventListener('focusin', (event) => {
    state.focused = (event.target as HTMLElement).dataset.value ?? null;
  });
  trigger.addEventListener('focus', () => {
    state.focused = null;
  });

  const focusItem = (which: 'checked' | 'first' | 'last') => {
    const list = items().filter((item) => !(item as HTMLButtonElement).disabled);
    const checked = list.find((item) => item.getAttribute('aria-checked') === 'true');
    const target = which === 'checked' ? (checked ?? list[0]) : which === 'first' ? list[0] : list.at(-1);
    target?.focus();
  };

  const pick = (item: MenuItem) => {
    close(true);
    if (item.kind === 'radio' && item.value === spec.value) return;
    spec.onPick(item.value);
  };

  trigger.addEventListener('pointerdown', () => {
    wasOpen = shown;
  });
  trigger.addEventListener('click', (event) => {
    // `detail` 0: Enter or Space. A pointer press on an open button: light dismiss (or the fallback) already closed
    // it on pointerdown; do not open it again.
    const pointer = event.detail !== 0;
    const toggleOff = shown || (pointer && wasOpen);
    wasOpen = false;
    if (toggleOff) {
      close(false);
      return;
    }
    open(pointer ? null : 'checked');
  });
  trigger.addEventListener('keydown', (event) => {
    // A pointer open leaves focus on the button: Esc there closes the menu only (not the task panel around it).
    if (event.key === 'Escape' && shown) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    if (!shown) open(null);
    focusItem(event.key === 'ArrowDown' ? 'checked' : 'last');
  });
  if (native) {
    menu.addEventListener('toggle', (event) => {
      if ((event as ToggleEvent).newState === 'closed' && shown) close(false);
    });
  }
  menu.addEventListener('keydown', (event) => {
    const list = items().filter((item) => !(item as HTMLButtonElement).disabled);
    const index = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (event.key === 'ArrowDown') next = (index + 1) % list.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Type-ahead over the labels (a short pause starts a new search).
      const now = Date.now();
      typed = now - typedAt > 700 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
      typedAt = now;
      const labels = list.map((item) => (item.dataset.label ?? '').toLowerCase());
      const from = typed.length === 1 ? index + 1 : Math.max(index, 0);
      for (let step = 0; step < list.length; step += 1) {
        const at = (from + step) % list.length;
        if (labels[at].startsWith(typed)) {
          next = at;
          break;
        }
      }
      event.stopPropagation();
      if (next < 0) return;
    }
    if (next < 0) return;
    event.preventDefault();
    event.stopPropagation();
    list[next].focus();
  });
  menu.addEventListener('focusout', (event) => {
    // Only a focus move to somewhere else closes it (WebKit does not focus buttons on click: no target, no close).
    const to = event.relatedTarget as Node | null;
    if (to !== null && !wrap.contains(to)) close(false);
  });
  return wrap;
}

function renderItem(item: MenuItem, value: string | undefined): HTMLButtonElement {
  const role = item.kind === 'radio' ? 'menuitemradio' : item.kind === 'check' ? 'menuitemcheckbox' : 'menuitem';
  const checked = item.kind === 'radio' ? item.value === value : item.kind === 'check' ? item.checked : null;
  return h(
    'button',
    { class: 'mb-item', attrs: { type: 'button', role, tabindex: '-1', 'aria-checked': checked === null ? undefined : checked ? 'true' : 'false', 'data-value': item.value, 'data-label': item.label } },
    item.kind === 'command' ? null : h('span', { class: 'mi-check', attrs: { 'aria-hidden': 'true' } }, chatIcon('check', 'xs')),
    item.lead !== undefined && item.lead !== null ? h('span', { class: 'mi-lead', attrs: { 'aria-hidden': 'true' } }, item.lead) : null,
    h('span', { class: 'mi-label' }, item.label),
    item.kind === 'radio' && item.hint !== undefined ? h('span', { class: 'mi-hint' }, item.hint) : null,
  );
}

/** Closes whichever menu is open (a context switch, the module hidden). */
/**
 * After a re-render (a poll, a save) replaced an open menu's button: open the new button's menu again, with focus back
 * on the item it was on, so a refresh never closes a menu under the person's pointer or keyboard.
 */
export function reopenMenus(): void {
  const open = current;
  if (open === null || open.connected()) return;
  const focused = open.focused;
  open.close(false);
  const trigger = document.getElementById(open.id);
  const opener = trigger === null ? undefined : openers.get(trigger);
  if (opener === undefined) return;
  opener(focused);
  if (focused === null && trigger !== null && document.activeElement === document.body) trigger.focus();
}

export function closeMenus(): void {
  current?.close(false);
}
