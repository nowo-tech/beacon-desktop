/**
 * The main window's own minimise / maximise / close buttons (UX batch 7, UXA-45, owner approval 2026-11-27). Drawn
 * only when the window has no system frame (Windows and Linux, `ChromeMode` `custom`); macOS keeps its traffic lights
 * (overlay title bar) and the `BEACON_DESKTOP_SYSTEM_TITLEBAR=1` fallback keeps the system's bar.
 *
 * - Order and placement follow the platform: right edge, minimise · maximise / restore · close. Windows 11 caption
 *   buttons (46 px wide, full bar height, close turns red on hover); Linux the Adwaita / Breeze round buttons.
 * - Real `<button>`s in a labelled group: in the Tab order after the title bar's tools, named for screen readers
 *   ("Restore" once maximised), `title` tooltips. They are not part of the drag region (`data-tauri-drag-region`
 *   ignores buttons).
 * - Close hides the window to the tray, exactly as the system button did (Rust prevents the close).
 */
import type { HostOs, WindowChromeHost } from '../platform';
import type { ChatText } from '../chat/i18n';

const SVG = 'http://www.w3.org/2000/svg';

type Glyph = 'minimize' | 'maximize' | 'restore' | 'close';

/** 10 × 10 glyphs, 1 px strokes (Segoe Fluent / Adwaita weights), `currentColor`. */
const GLYPHS: Record<Glyph, string> = {
  minimize: 'M0 5.5h10',
  maximize: 'M.5.5h9v9h-9z',
  restore: 'M2.5 2.5h7v7h-7zM.5 7.5v-7h7',
  close: 'M.5.5l9 9M9.5.5l-9 9',
};

function glyph(name: Glyph): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'wc-glyph');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', GLYPHS[name]);
  svg.append(path);
  return svg;
}

export interface WindowControls {
  readonly root: HTMLElement;
  /** Shows "Restore" (maximised) or "Maximise". */
  setMaximized(maximized: boolean): void;
}

export function windowControls(host: WindowChromeHost, os: HostOs, t: ChatText): WindowControls {
  const root = document.createElement('div');
  root.className = 'win-controls';
  root.id = 'win-controls';
  root.dataset.os = os === 'linux' ? 'linux' : 'windows';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', t('windowControls'));
  const button = (id: string, name: Glyph, label: string, onClick: () => Promise<void>) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.id = id;
    element.className = `wc-btn wc-${name === 'restore' ? 'maximize' : name}`;
    element.setAttribute('aria-label', label);
    element.title = label;
    element.append(glyph(name));
    element.addEventListener('click', () => void onClick().catch(() => undefined));
    return element;
  };
  const minimize = button('wc-minimize', 'minimize', t('windowMinimize'), () => host.minimize());
  const maximize = button('wc-maximize', 'maximize', t('windowMaximize'), () => host.toggleMaximize());
  const close = button('wc-close', 'close', t('windowClose'), () => host.close());
  close.title = t('windowCloseHint');
  root.append(minimize, maximize, close);
  let current: boolean | null = null;
  const setMaximized = (maximized: boolean) => {
    if (maximized === current) return;
    current = maximized;
    const label = maximized ? t('windowRestore') : t('windowMaximize');
    maximize.setAttribute('aria-label', label);
    maximize.title = label;
    maximize.replaceChildren(glyph(maximized ? 'restore' : 'maximize'));
    root.dataset.maximized = maximized ? 'true' : 'false';
  };
  setMaximized(false);
  host.onMaximizedChange(setMaximized);
  void host
    .isMaximized()
    .then(setMaximized)
    .catch(() => undefined);
  return { root, setMaximized };
}
