// theme.js — appearance preference (auto / light / dark)

const STORAGE_KEY = 'roxabi:theme-pref';
const LEGACY_KEY = 'v6:theme';

/** @typedef {'auto'|'light'|'dark'} ThemePref */

/** @returns {ThemePref} */
export function getThemePref() {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'auto' || v === 'light' || v === 'dark') return v;
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy === 'light' || legacy === 'dark') return legacy;
  return 'auto';
}

/** @param {ThemePref} pref */
export function setThemePref(pref) {
  localStorage.setItem(STORAGE_KEY, pref);
}

/** @returns {'light'|'dark'} */
export function resolveTheme(pref = getThemePref()) {
  if (pref === 'light' || pref === 'dark') return pref;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** @param {ThemePref} [pref] */
export function applyThemePref(pref = getThemePref()) {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = resolved === 'dark' ? '🌙' : '☀️';
  return resolved;
}

let mediaListener;

/** Wire system theme changes when preference is auto. */
export function wireThemeMediaListener() {
  if (mediaListener) return;
  const mq = matchMedia('(prefers-color-scheme: light)');
  mediaListener = () => {
    if (getThemePref() === 'auto') applyThemePref('auto');
  };
  mq.addEventListener('change', mediaListener);
}

/** Cycle light ↔ dark (header quick toggle); stores explicit light/dark. */
export function toggleThemeQuick() {
  const resolved = resolveTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  setThemePref(next);
  applyThemePref(next);
}