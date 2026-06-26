/**
 * displayName.ts — local-only display-name override (ported from settings.js).
 * Stored per GitHub login in localStorage; falls back to the login itself.
 */

const DISPLAY_NAME_PREFIX = "roxabi:display-name:";

export function getDisplayName(login: string): string {
  return localStorage.getItem(DISPLAY_NAME_PREFIX + login) || login;
}

export function setDisplayName(login: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === login) {
    localStorage.removeItem(DISPLAY_NAME_PREFIX + login);
    return login;
  }
  localStorage.setItem(DISPLAY_NAME_PREFIX + login, trimmed);
  return trimmed;
}

export function clearDisplayName(login: string): void {
  localStorage.removeItem(DISPLAY_NAME_PREFIX + login);
}
