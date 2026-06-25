/**
 * theme — dark/light toggle for the cockpit. Mirrors the legacy data-theme
 * switch (frontend/settings.js): the brand :root is dark, and an [data-theme]
 * attribute on <html> flips the token set. Persisted in localStorage.
 */

export type Theme = "dark" | "light";

const KEY = "rl:theme";

export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Set <html data-theme> and persist. Called by the toggle. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // ignore quota / disabled storage
  }
}

/** Apply the stored theme on boot without writing storage (no FOUC for light). */
export function initTheme(): void {
  document.documentElement.setAttribute("data-theme", readTheme());
}
