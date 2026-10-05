/**
 * T360: the viewer's theme — follow the system, or force light or dark.
 * A per-viewer convenience in localStorage (never state the daemon holds);
 * `styles.css` reads `data-theme` on `<html>`. Blocked storage means "system".
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'agile.theme';

export function readTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function saveTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}
