/**
 * A long list as one Tab stop (UX batch 3, UXA-10; WAI-ARIA roving tabindex): one item has `tabindex="0"`, the others
 * `-1`; ↑ / ↓ move between items, Home / End go to the ends. With `cells`, ← / → also move between the other controls
 * of the item's row (a checkbox, a play button, a status menu), which stay out of the Tab order, so a row is never more
 * than one stop and every control is still reachable from the keyboard.
 */
export interface RovingOptions {
  /** The items (one per row), in DOM order. */
  items: string;
  /** The row of an item (for `cells`); default the item itself. */
  row?: string;
  /** Other controls of a row, reached with ← / → (DOM order, the item among them). */
  cells?: string;
  /** The item to start on when none was focused yet (the open conversation, the current page). */
  preferred?: () => HTMLElement | null;
}

const visible = (element: HTMLElement) => element.closest('[hidden]') === null && !(element as HTMLButtonElement).disabled;

export class Roving {
  /** The last item that had focus (an element, recognised again after a re-render by its `data-roving` key). */
  private key: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: RovingOptions,
  ) {
    root.addEventListener('keydown', (event) => this.onKey(event));
    root.addEventListener('focusin', (event) => {
      const item = this.itemOf(event.target);
      if (item === null) return;
      this.key = keyOf(item);
      this.sync();
    });
  }

  items(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>(this.options.items)].filter(visible);
  }

  /** The item that takes Tab: the one focused last (same key after a re-render), else the preferred one, else the first. */
  current(): HTMLElement | null {
    const items = this.items();
    return items.find((item) => this.key !== null && keyOf(item) === this.key) ?? this.options.preferred?.() ?? items[0] ?? null;
  }

  /** Puts the tab stops right (call after every render of the list). */
  sync(): void {
    const items = this.items();
    const current = this.current();
    for (const item of items) item.tabIndex = item === current ? 0 : -1;
    if (this.options.cells !== undefined) {
      for (const row of this.root.querySelectorAll<HTMLElement>(this.options.row ?? this.options.items)) {
        for (const cell of row.querySelectorAll<HTMLElement>(this.options.cells)) if (!cell.matches(this.options.items)) cell.tabIndex = -1;
      }
    }
  }

  /** Moves focus to the tab stop (F6, a module shown again). Returns whether there was one. */
  focus(): boolean {
    const current = this.current();
    if (current === null) return false;
    this.sync();
    current.focus();
    return true;
  }

  private itemOf(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof HTMLElement)) return null;
    if (target.matches(this.options.items)) return target;
    if (this.options.cells === undefined) return null;
    const row = target.closest<HTMLElement>(this.options.row ?? this.options.items);
    return row !== null && this.root.contains(row) ? (row.matches(this.options.items) ? row : row.querySelector<HTMLElement>(this.options.items)) : null;
  }

  private onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const item = this.itemOf(event.target);
    if (item === null) return;
    const items = this.items();
    const index = items.indexOf(item);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = items[index + 1];
    else if (event.key === 'ArrowUp') next = items[index - 1];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items.at(-1);
    else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && this.options.cells !== undefined) {
      const row = (event.target as HTMLElement).closest<HTMLElement>(this.options.row ?? this.options.items);
      if (row === null) return;
      const cells = [...row.querySelectorAll<HTMLElement>(this.options.cells)].filter(visible);
      const at = cells.indexOf(event.target as HTMLElement);
      next = cells[at + (event.key === 'ArrowRight' ? 1 : -1)];
      if (at < 0) return;
    } else return;
    event.preventDefault();
    if (next === undefined) return;
    this.key = keyOf(this.itemOf(next) ?? next);
    this.sync();
    next.focus();
    next.scrollIntoView?.({ block: 'nearest' });
  }
}

/** What recognises an item after a re-render: its `data-roving` key, else its render key (`data-key`), else its id. */
function keyOf(element: HTMLElement): string {
  return element.dataset.roving ?? element.dataset.key ?? element.id;
}
