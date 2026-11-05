/**
 * Window layouts (0.5.0). The main window has two layouts, chosen by its width alone:
 *
 * - `compact` (the quick tracker): one column, at most 33rem wide and centred, from the minimum width up to the
 *   breakpoint, so a window a bit wider than the column never shows a stretched, empty UI;
 * - `full` (from `FULL_BREAKPOINT`): sections sidebar · task list · detail pane.
 *
 * "Compact view" / "Full view" (header, tray, Ctrl/⌘+Shift+L) resize the window to the size remembered for that layout
 * (or its preset), centred on the screen when it would not fit on one. Sizes are kept in physical pixels, as the OS
 * reports them, per device (local storage, never sent).
 */
export type LayoutMode = 'compact' | 'full';

/** Content width (CSS px) from which the full layout is used. */
export const FULL_BREAKPOINT = 900;

/** Logical sizes of each view when nothing is remembered yet; `MIN_SIZE` matches `minWidth` / `minHeight` in tauri.conf.json. */
export const PRESETS: Record<LayoutMode, Size> = {
  compact: { width: 400, height: 640 },
  full: { width: 1200, height: 780 },
};
export const MIN_SIZE: Size = { width: 380, height: 560 };

export const WINDOW_KEY = 'time-track-desktop.window';

export interface Size {
  width: number;
  height: number;
}

/** Physical pixels: outer position, inner size. */
export interface Rect extends Size {
  x: number;
  y: number;
}

/** Monitors as the OS reports them: work areas (without task bars / docks), the one the window is on, its scale. */
export interface Screens {
  areas: Rect[];
  current: Rect | null;
  scale: number;
}

export interface WindowMemory {
  /** View last used. */
  mode: LayoutMode;
  /** Last size and position of the window in each view. */
  bounds: Partial<Record<LayoutMode, Rect>>;
}

export function layoutFor(width: number): LayoutMode {
  return width >= FULL_BREAKPOINT ? 'full' : 'compact';
}

export function otherMode(mode: LayoutMode): LayoutMode {
  return mode === 'full' ? 'compact' : 'full';
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false;
  const rect = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
    && (rect.width as number) > 0
    && (rect.height as number) > 0;
}

export function loadWindowMemory(storage: Storage): WindowMemory {
  try {
    const raw = JSON.parse(storage.getItem(WINDOW_KEY) ?? '{}') as Partial<WindowMemory>;
    const bounds: WindowMemory['bounds'] = {};
    for (const mode of ['compact', 'full'] as const) {
      const rect = raw.bounds?.[mode];
      if (isRect(rect)) bounds[mode] = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    }
    return { mode: raw.mode === 'full' ? 'full' : 'compact', bounds };
  } catch {
    return { mode: 'compact', bounds: {} };
  }
}

export function saveWindowMemory(memory: WindowMemory, storage: Storage): void {
  try {
    storage.setItem(WINDOW_KEY, JSON.stringify(memory));
  } catch {
    // Storage full or unavailable: the window just opens at its preset next time.
  }
}

/** The rectangle fits entirely inside the area. */
export function inside(rect: Rect, area: Rect): boolean {
  return rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height;
}

/**
 * Where the window goes for `mode`: the remembered bounds, else the preset centred on the current screen. The size is
 * never larger than the screen's work area nor smaller than the minimum; when the result would not fit entirely on a
 * screen (a monitor was unplugged, the resolution changed), it is centred on the current screen instead.
 */
export function placeWindow(mode: LayoutMode, memory: WindowMemory, screens: Screens): Rect {
  const area = screens.current ?? screens.areas[0] ?? null;
  const scale = screens.scale > 0 ? screens.scale : 1;
  const preset = PRESETS[mode];
  const remembered = memory.bounds[mode];
  const wanted = remembered ?? { x: Number.NaN, y: Number.NaN, width: Math.round(preset.width * scale), height: Math.round(preset.height * scale) };
  if (area === null) return { ...wanted, x: Number.isNaN(wanted.x) ? 0 : wanted.x, y: Number.isNaN(wanted.y) ? 0 : wanted.y };
  const clamp = (value: number, min: number, max: number) => Math.max(Math.min(value, max), Math.min(min, max));
  const width = clamp(wanted.width, Math.round(MIN_SIZE.width * scale), area.width);
  const height = clamp(wanted.height, Math.round(MIN_SIZE.height * scale), area.height);
  const placed = { x: wanted.x, y: wanted.y, width, height };
  if (!Number.isNaN(placed.x) && screens.areas.concat(area).some((screen) => inside(placed, screen))) return placed;
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height };
}
