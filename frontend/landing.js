// landing.js — public homepage (session-aware header + i18n)

import { detectLocale, initI18n, t } from "./i18n.js";
import { hideLandingUserMenu, wireLandingUserMenu } from "./landing-user-menu.js";

const DASHBOARD_PATH = "/dashboard";
const PROFILE_PATH = "/dashboard?settings=open";

/** @param {string} id */
function $(id) {
  return document.getElementById(id);
}

/** @param {string} id @param {boolean} hidden */
function setHidden(id, hidden) {
  const el = $(id);
  if (!el) return;
  if (hidden) el.setAttribute("hidden", "");
  else el.removeAttribute("hidden");
}

/** @param {string} id @param {string} href @param {string} labelKey */
function setCta(id, href, labelKey) {
  const el = $(id);
  if (!el) return;
  el.href = href;
  el.textContent = t(detectLocale(), labelKey);
}

function applySignedOutCtas() {
  hideLandingUserMenu();
  setHidden("nav-guest-actions", false);

  setCta("nav-sign-in", "/sign-in/", "nav.signIn");
  setCta("nav-sign-up", "/sign-up/", "nav.signUp");
  setCta("hero-sign-up", "/sign-up/", "hero.ctaPrimary");
  setCta("cta-sign-up", "/sign-up/", "cta.button");

  setHidden("hero-sign-up", false);
  setHidden("landing-cta-band", false);
}

function applySignedInCtas(me) {
  setHidden("nav-guest-actions", true);
  setHidden("hero-sign-up", true);
  setHidden("landing-cta-band", true);

  setCta("user-menu-dashboard", DASHBOARD_PATH, "nav.myDashboard");
  setCta("user-menu-profile", PROFILE_PATH, "nav.myProfile");
  wireLandingUserMenu(me);
}

async function wireSessionAwareCtas() {
  let me = null;
  try {
    const resp = await fetch("/api/me");
    if (resp.ok) me = await resp.json();
  } catch {
    // offline — keep public CTAs
  }

  if (me?.user) applySignedInCtas(me);
  else applySignedOutCtas();
}

initI18n();
wireSessionAwareCtas();

document.addEventListener("roxabi:locale", () => {
  wireSessionAwareCtas();
});
