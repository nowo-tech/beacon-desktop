/** Colour theme (0.5.0): follow the system (default) or force light / dark. Persisted in the local settings. */
export type ThemePreference = 'system' | 'light' | 'dark';

export const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export function isTheme(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** The theme forced on the window, `null` when it follows the system. */
export function forcedTheme(preference: ThemePreference): 'light' | 'dark' | null {
  return preference === 'system' ? null : preference;
}

/**
 * Applies the preference to the document: `data-theme` on <html> picks the token set in styles.css (absent = the
 * `prefers-color-scheme` media query decides), and `color-scheme` keeps native controls (scrollbars, <select>,
 * <progress>) in step.
 */
export function applyTheme(preference: ThemePreference, root: HTMLElement = document.documentElement): 'light' | 'dark' | null {
  const forced = forcedTheme(preference);
  if (forced === null) {
    root.removeAttribute('data-theme');
    root.style.colorScheme = '';
  } else {
    root.setAttribute('data-theme', forced);
    root.style.colorScheme = forced;
  }
  return forced;
}
