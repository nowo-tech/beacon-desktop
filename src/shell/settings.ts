/**
 * The one Settings (UX batch 6, UXA-2): a modal dialog with a tab list (vertical when there is room) over every
 * section of the app. The Time module's own panels (General, Timer, Shortcuts, Schedule, Notifications, Meetings,
 * Updates) sit next to the shell's (Appearance, Chat, Tasks, Account), so Theme lives in one place and Sign out sits in
 * Account. The rail's gear, Ctrl/⌘+, (every module) and the tray's "Settings…" all open it.
 *
 * Tab ids keep the Time module's `settings-tab-<id>` / `settings-panel-<id>`; the tab last opened is remembered in the
 * same key as before (`SETTINGS_TAB_KEY`).
 */
import { type Child, h, patch } from '../ui/dom';
import { createTabs, type Tabs } from '../ui/tabs';
import { SETTINGS_TABS, type SettingsTab } from '../ui/app';
import { SETTINGS_TAB_KEY } from '../lib/settings';
import { chatIcon } from '../chat/icons';

export type ShellTab = 'appearance' | 'chat' | 'tasks' | 'account';
export type AnyTab = SettingsTab | ShellTab;

/** The tabs in order: what people look for first, then each module, then updates and the account. */
export const ONE_SETTINGS_TABS: readonly AnyTab[] = ['general', 'appearance', 'timer', 'shortcuts', 'schedule', 'notifications', 'meetings', 'chat', 'tasks', 'updates', 'account'];

/** From this dialog width (CSS px) the tab list stands as a column beside the options. */
const VERTICAL_MIN_PX = 640;

export interface SettingsSource {
  /** Tasks exist on this host (the Tasks tab). */
  hasTasks(): boolean;
  /** A tab's name. */
  label(tab: AnyTab): string;
  /** A tab's content: the Time module's panels and the shell's own rows. */
  content(tab: AnyTab): Child[];
  title(): string;
  sectionsLabel(): string;
  closeLabel(): string;
}

function isTab(value: unknown, tabs: readonly AnyTab[]): value is AnyTab {
  return typeof value === 'string' && (tabs as readonly string[]).includes(value);
}

export class SettingsDialog {
  readonly dialog: HTMLDialogElement;
  private tabs: Tabs<AnyTab> | null = null;
  private order: readonly AnyTab[] = [];
  private readonly body: HTMLElement;
  private readonly heading: HTMLElement;

  constructor(
    private readonly source: SettingsSource,
    private readonly storage: Storage | undefined,
  ) {
    this.heading = h('h1', { id: 'shell-settings-title' });
    const close = h('button', { class: 'x-btn', id: 'settings-close', attrs: { type: 'button' } }, chatIcon('x'));
    close.addEventListener('click', () => this.dialog.close());
    this.body = h('div', { class: 'dlg-b one-settings-b' });
    this.dialog = h(
      'dialog',
      { class: 'sh-dialog one-settings', id: 'shell-settings', attrs: { 'aria-labelledby': 'shell-settings-title', closedby: 'any' } },
      h('div', { class: 'dlg settings' }, h('div', { class: 'dlg-h' }, this.heading, close), this.body),
    );
    this.closeButton = close;
    globalThis.addEventListener?.('resize', () => {
      if (this.dialog.open) this.orient();
    });
  }

  private readonly closeButton: HTMLButtonElement;

  get open(): boolean {
    return this.dialog.open;
  }

  /** The tab shown (`null` before the first opening). */
  selected(): AnyTab | null {
    return this.tabs?.selected() ?? null;
  }

  private storedTab(): AnyTab {
    try {
      const value = this.storage?.getItem(SETTINGS_TAB_KEY);
      return isTab(value, this.order) ? value : this.order[0];
    } catch {
      return this.order[0];
    }
  }

  private remember(tab: AnyTab): void {
    try {
      this.storage?.setItem(SETTINGS_TAB_KEY, tab);
    } catch {
      // Storage blocked: the tab is simply not remembered.
    }
  }

  /** Builds the tab list again when the tabs change (Tasks appears or goes). */
  private build(): Tabs<AnyTab> {
    const order = ONE_SETTINGS_TABS.filter((tab) => tab !== 'tasks' || this.source.hasTasks());
    if (this.tabs !== null && order.join() === this.order.join()) return this.tabs;
    this.order = order;
    const tabs = createTabs<AnyTab>({
      idPrefix: 'settings',
      label: this.source.sectionsLabel(),
      tabs: order.map((id) => ({ id, label: this.source.label(id) })),
      selected: this.tabs?.selected() ?? this.storedTab(),
      orientation: 'vertical',
      onSelect: (id) => {
        this.remember(id);
        this.render();
      },
    });
    this.tabs = tabs;
    this.body.replaceChildren(tabs.root);
    return tabs;
  }

  /** Opens Settings (on `tab`, or the one last used) with the selected tab focused. */
  show(tab?: AnyTab): void {
    const tabs = this.build();
    if (tab !== undefined && this.order.includes(tab)) tabs.select(tab);
    if (!this.dialog.open) this.dialog.showModal();
    this.render();
    this.orient();
    tabs.select(tabs.selected(), true);
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** Vertical tab list beside the options when the dialog is wide enough, else the scrolling row above them. */
  private orient(): void {
    const width = this.dialog.getBoundingClientRect().width || globalThis.innerWidth || 0;
    const vertical = width === 0 || width >= VERTICAL_MIN_PX;
    this.tabs?.setOrientation(vertical ? 'vertical' : 'horizontal');
    this.body.dataset.orientation = vertical ? 'vertical' : 'horizontal';
  }

  /** Every panel follows the app (each render patches in place, so focus and the selected tab stay). */
  render(): void {
    const tabs = this.tabs;
    if (tabs === null || !this.dialog.open) return;
    this.heading.textContent = this.source.title();
    this.closeButton.setAttribute('aria-label', this.source.closeLabel());
    this.closeButton.title = this.source.closeLabel();
    tabs.setLabels(this.source.sectionsLabel(), Object.fromEntries(this.order.map((id) => [id, this.source.label(id)])) as Record<AnyTab, string>);
    for (const id of this.order) {
      const panel = tabs.panels.get(id);
      if (panel !== undefined) patch(panel, this.source.content(id));
    }
  }
}

/** The Time module's tabs, for the source's switch. */
export function isTimeTab(tab: AnyTab): tab is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(tab);
}
