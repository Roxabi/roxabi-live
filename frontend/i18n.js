// i18n.js — FR/EN locale management for public pages

import en from "./i18n/locales/en.js";
import fr from "./i18n/locales/fr.js";

const STORAGE_KEY = "roxabi:locale";

/** @typedef {'fr'|'en'} Locale */

/** @type {Record<Locale, Record<string, string>>} */
const CATALOG = { fr, en };

/** @returns {Locale} */
export function normalizeLocale(value) {
  const v = String(value ?? "").toLowerCase();
  if (v === "en" || v.startsWith("en-")) return "en";
  if (v === "fr" || v.startsWith("fr-")) return "fr";
  return "fr";
}

/** @returns {Locale} */
export function detectLocale() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("lang");
  if (fromUrl) return normalizeLocale(fromUrl);

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return normalizeLocale(stored);

  const browser = navigator.language || "fr";
  return normalizeLocale(browser);
}

/** @param {Locale} locale */
export function setLocale(locale) {
  const next = normalizeLocale(locale);
  localStorage.setItem(STORAGE_KEY, next);
  document.documentElement.lang = next;
  return next;
}

/** @param {Locale} locale @param {string} key */
export function t(locale, key) {
  return CATALOG[normalizeLocale(locale)][key] ?? CATALOG.fr[key] ?? key;
}

/** @param {Locale} locale */
export function applyTranslations(locale) {
  const loc = setLocale(locale);
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (!key) continue;
    el.textContent = t(loc, key);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    const key = el.getAttribute("data-i18n-placeholder");
    if (!key) continue;
    el.setAttribute("placeholder", t(loc, key));
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const key = el.getAttribute("data-i18n-title");
    if (!key) continue;
    el.setAttribute("title", t(loc, key));
  }
  const metaDesc = document.querySelector('meta[name="description"]');
  const descKey = document.documentElement.getAttribute("data-i18n-desc");
  if (metaDesc && descKey) metaDesc.setAttribute("content", t(loc, descKey));
  const titleKey = document.documentElement.getAttribute("data-i18n-title");
  if (titleKey) document.title = t(loc, titleKey);
  document.dispatchEvent(new CustomEvent("roxabi:locale", { detail: { locale: loc } }));
  return loc;
}

/** @param {string} [selectId] */
export function wireLocaleSwitcher(selectId = "locale-switcher") {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const current = detectLocale();
  sel.value = current;
  sel.addEventListener("change", () => {
    applyTranslations(/** @type {Locale} */ (sel.value));
    syncLocaleInUrl(/** @type {Locale} */ (sel.value));
  });
}

/** @param {Locale} locale */
function syncLocaleInUrl(locale) {
  const url = new URL(location.href);
  url.searchParams.set("lang", locale);
  history.replaceState(null, "", url);
}

/** Initialize i18n on page load. */
export function initI18n() {
  const locale = detectLocale();
  applyTranslations(locale);
  wireLocaleSwitcher();
  return locale;
}
