import { h } from './dom';

/**
 * Accessible tabs (WAI-ARIA tabs pattern) built once and updated in place: a `tablist` of `<button role="tab">` with a
 * roving tabindex (only the selected tab is a Tab stop), selection follows focus, ←/→ (or ↑/↓ when vertical) move
 * (wrapping), Home / End jump to the first / last tab. Panels that are not selected are `hidden="until-found"` (still found by find-in-page where
 * the webview supports it; plain `hidden` elsewhere), and a find-in-page match selects its tab (`beforematch`).
 */
export interface TabSpec<T extends string> {
  id: T;
  label: string;
}

export interface Tabs<T extends string> {
  /** The tablist (horizontal scroller) followed by every panel. */
  readonly root: HTMLElement;
  readonly tablist: HTMLElement;
  readonly tabs: ReadonlyMap<T, HTMLButtonElement>;
  readonly panels: ReadonlyMap<T, HTMLElement>;
  selected(): T;
  /** Selects a tab (no event when it is already selected); `focus` also moves keyboard focus to it. */
  select(id: T, focus?: boolean): void;
  /** Updates the tab names and the tablist's accessible name in place (language change). */
  setLabels(label: string, labels: Record<T, string>): void;
  /**
   * Horizontal (←/→) or vertical (↑/↓) tablist, switched in place: the tabs, the selection and the focus are kept.
   */
  setOrientation(orientation: Orientation): void;
}

export type Orientation = 'horizontal' | 'vertical';

export interface TabsOptions<T extends string> {
  /** Prefix of the element ids: `${idPrefix}-tab-${id}` and `${idPrefix}-panel-${id}`. */
  idPrefix: string;
  label: string;
  tabs: readonly TabSpec<T>[];
  selected: T;
  orientation?: Orientation;
  onSelect(id: T): void;
}

export function createTabs<T extends string>(options: TabsOptions<T>): Tabs<T> {
  const { idPrefix } = options;
  const order = options.tabs.map((tab) => tab.id);
  let current: T = order.includes(options.selected) ? options.selected : order[0];
  const tablist = h('div', { class: 'tablist', id: `${idPrefix}-tablist`, attrs: { role: 'tablist', 'aria-label': options.label, 'aria-orientation': options.orientation ?? 'horizontal' } });
  const tabs = new Map<T, HTMLButtonElement>();
  const panels = new Map<T, HTMLElement>();
  for (const spec of options.tabs) {
    const tabId = `${idPrefix}-tab-${spec.id}`;
    const panelId = `${idPrefix}-panel-${spec.id}`;
    const tab = h('button', { class: 'tab', id: tabId, attrs: { type: 'button', role: 'tab', 'aria-controls': panelId, 'data-tab': spec.id } }, spec.label);
    tab.addEventListener('click', () => select(spec.id, true));
    tabs.set(spec.id, tab);
    tablist.append(tab);
    const panel = h('div', { class: 'tabpanel', id: panelId, attrs: { role: 'tabpanel', 'aria-labelledby': tabId, 'data-tab': spec.id } });
    // Find-in-page revealed a match in a hidden panel: its tab becomes the selected one.
    panel.addEventListener('beforematch', () => select(spec.id, false));
    panels.set(spec.id, panel);
  }
  tablist.addEventListener('keydown', (event) => {
    const index = order.indexOf(current);
    const vertical = tablist.getAttribute('aria-orientation') === 'vertical';
    const rtl = !vertical && getComputedStyle(tablist).direction === 'rtl';
    const forward = vertical ? 'ArrowDown' : rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = vertical ? 'ArrowUp' : rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: T | undefined;
    if (event.key === forward) next = order[(index + 1) % order.length];
    else if (event.key === backward) next = order[(index - 1 + order.length) % order.length];
    else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order[order.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    select(next, true);
  });

  function sync(): void {
    for (const [id, tab] of tabs) {
      const on = id === current;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      const panel = panels.get(id) as HTMLElement;
      if (on) panel.removeAttribute('hidden');
      else if (panel.getAttribute('hidden') !== 'until-found') panel.setAttribute('hidden', 'until-found');
    }
  }

  function select(id: T, focus = false): void {
    const changed = id !== current && tabs.has(id);
    if (changed) current = id;
    sync();
    const tab = tabs.get(current) as HTMLButtonElement;
    if (focus) tab.focus({ preventScroll: true });
    // Only the tablist scrolls (never the page) to show the whole selected tab.
    (tab.scrollIntoView as ((options: ScrollIntoViewOptions & { container?: 'all' | 'nearest' }) => void) | undefined)?.call(tab, { block: 'nearest', inline: 'nearest', container: 'nearest' });
    if (changed) options.onSelect(current);
  }

  sync();
  fadeFallback(tablist);
  return {
    root: h('div', { class: 'tabs', id: `${idPrefix}-tabs` }, tablist, ...panels.values()),
    tablist,
    tabs,
    panels,
    selected: () => current,
    select,
    setLabels(label, labels) {
      if (tablist.getAttribute('aria-label') !== label) tablist.setAttribute('aria-label', label);
      for (const [id, tab] of tabs) if (tab.textContent !== labels[id]) tab.textContent = labels[id];
    },
    setOrientation(orientation) {
      if (tablist.getAttribute('aria-orientation') === orientation) return;
      tablist.setAttribute('aria-orientation', orientation);
      // The selected tab back in view in the new direction (only the tablist scrolls).
      select(current, false);
    },
  };
}

/**
 * Where scroll-driven animations are missing (older WebKit webviews), marks the edges of the tablist that have more
 * tabs beyond them (`more-start` / `more-end`), so the CSS fades still show there.
 */
function fadeFallback(tablist: HTMLElement): void {
  if (typeof IntersectionObserver !== 'function' || globalThis.CSS?.supports?.('animation-timeline', 'scroll()') === true) return;
  const first = tablist.firstElementChild;
  const last = tablist.lastElementChild;
  if (first === null || last === null) return;
  // rootMargin: sub-pixel widths can otherwise leave an edge tab a fraction of a pixel short of fully visible.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const { target, intersectionRatio } of entries) tablist.classList.toggle(target === first ? 'more-start' : 'more-end', intersectionRatio < 1);
    },
    { root: tablist, threshold: 1, rootMargin: '1px' },
  );
  observer.observe(first);
  observer.observe(last);
}
