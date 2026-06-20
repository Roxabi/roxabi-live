// landing.js — public homepage (session-aware CTAs + i18n)

import { detectLocale, initI18n, t } from "./i18n.js";

const DASHBOARD_PATH = "/dashboard";

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
  const navSignIn = $("nav-sign-in");
  if (navSignIn) {
    navSignIn.classList.add("btn-ghost");
    navSignIn.classList.remove("btn-primary");
  }

  setHidden("nav-sign-up", false);
  setHidden("hero-sign-up", false);
  setHidden("landing-cta-band", false);

  setCta("nav-sign-in", "/sign-in/", "nav.signIn");
  setCta("nav-sign-up", "/sign-up/", "nav.signUp");
  setCta("hero-sign-up", "/sign-up/", "hero.ctaPrimary");
  setCta("cta-sign-up", "/sign-up/", "cta.button");
}

function applySignedInCtas() {
  const navSignIn = $("nav-sign-in");
  if (navSignIn) {
    navSignIn.href = DASHBOARD_PATH;
    navSignIn.textContent = t(detectLocale(), "nav.openDashboard");
    navSignIn.classList.remove("btn-ghost");
    navSignIn.classList.add("btn-primary");
  }

  setHidden("nav-sign-up", true);
  setHidden("hero-sign-up", true);
  setHidden("landing-cta-band", true);
}

async function wireSessionAwareCtas() {
  let signedIn = false;
  try {
    const resp = await fetch("/api/me");
    signedIn = resp.ok;
  } catch {
    // offline — keep public CTAs
  }

  if (signedIn) applySignedInCtas();
  else applySignedOutCtas();
}

initI18n();
wireSessionAwareCtas();

document.addEventListener("roxabi:locale", () => {
  wireSessionAwareCtas();
});
