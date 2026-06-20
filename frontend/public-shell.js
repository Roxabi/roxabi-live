// public-shell.js — shared topbar + footer for marketing, legal, and auth pages

import { initI18n } from "./i18n.js";
import { wirePublicHeader } from "./public-header.js";

/** @typedef {'full'|'minimal'} ShellVariant */
/** @typedef {'legal'|'privacy'|'terms'|null} ActiveLegal */

const LOCALE_FLAGS = `
  <div class="locale-flags" role="group" aria-label="Language">
    <button type="button" class="locale-flag" data-locale="fr" aria-label="Français" title="Français">🇫🇷</button>
    <button type="button" class="locale-flag" data-locale="en" aria-label="English" title="English">🇬🇧</button>
  </div>`;

const USER_MENU = `
  <div id="user-menu-wrap" class="user-menu-wrap" hidden>
    <button id="user-menu-btn" class="user-avatar-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu">
      <img id="user-menu-avatar" class="user-avatar-img" alt="" width="28" height="28" />
    </button>
    <div id="user-menu-panel" class="user-menu-panel" role="menu" hidden>
      <a id="user-menu-dashboard" class="user-menu-item" href="/dashboard" role="menuitem" data-i18n="nav.myDashboard">Mon dashboard</a>
      <a id="user-menu-profile" class="user-menu-item" href="/dashboard?settings=open" role="menuitem" data-i18n="nav.myProfile">Mon profil</a>
    </div>
  </div>`;

const GUEST_ACTIONS = `
  <div id="nav-guest-actions" class="nav-guest-actions">
    <a id="nav-sign-in" class="btn btn-ghost" href="/sign-in/" data-i18n="nav.signIn">Se connecter</a>
    <a id="nav-sign-up" class="btn btn-primary" href="/sign-up/" data-i18n="nav.signUp">Créer un compte</a>
  </div>`;

/** @param {ShellVariant} variant */
export function topbarHTML(variant = "full") {
  const navLinks =
    variant === "full"
      ? `<div class="site-nav-links">
          <a href="/#features" data-i18n="nav.features">Fonctionnalités</a>
          <a href="/#how" data-i18n="nav.howItWorks">Comment ça marche</a>
          <a href="/#features" data-i18n="nav.security">Sécurité</a>
        </div>`
      : "";

  return `<header class="site-topbar">
  <div class="site-topbar-inner">
    <a class="site-brand" href="/">
      <span class="site-brand-mark">v6</span>
      <span class="site-brand-name">Roxabi Live</span>
    </a>
    <nav class="site-nav" aria-label="Navigation principale">
      ${navLinks}
      <div class="site-nav-actions">
        ${LOCALE_FLAGS}
        ${GUEST_ACTIONS}
        ${USER_MENU}
      </div>
    </nav>
  </div>
</header>`;
}

/** @param {ActiveLegal} active */
export function footerHTML(active = null) {
  const cur = (key) => (active === key ? ' aria-current="page"' : "");
  return `<footer class="site-footer">
  <nav class="site-footer-nav" aria-label="Liens légaux">
    <a href="/mentions-legales" data-i18n="footer.legal"${cur("legal")}>Mentions légales</a>
    <a href="/politique-confidentialite" data-i18n="footer.privacy"${cur("privacy")}>Politique de confidentialité</a>
    <a href="/conditions-utilisation" data-i18n="footer.terms"${cur("terms")}>Conditions d'utilisation</a>
  </nav>
  <p class="site-footer-copy" data-i18n="footer.copy">© 2026 Roxabi Live · Dep-Graph v6</p>
</footer>`;
}

/**
 * @param {{
 *   variant?: ShellVariant,
 *   activeLegal?: ActiveLegal,
 *   managePageSections?: boolean,
 * }} opts
 */
export async function initPublicPage(opts = {}) {
  const { variant = "full", activeLegal = null, managePageSections = false } = opts;

  const topMount = document.getElementById("public-topbar-mount");
  const footMount = document.getElementById("public-footer-mount");
  if (topMount) topMount.innerHTML = topbarHTML(variant);
  if (footMount) footMount.innerHTML = footerHTML(activeLegal);

  initI18n();
  await wirePublicHeader({ managePageSections });

  document.addEventListener("roxabi:locale", () => {
    wirePublicHeader({ managePageSections });
  });
}
