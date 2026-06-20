// landing.js — public homepage (session-aware CTAs + i18n)

import { detectLocale, initI18n, t } from "./i18n.js";

const DASHBOARD_PATH = "/dashboard";

/** @param {string} id @param {string} href @param {string} labelKey */
function setCta(id, href, labelKey) {
  const el = document.getElementById(id);
  if (!el) return;
  el.href = href;
  el.textContent = t(detectLocale(), labelKey);
}

async function wireSessionAwareCtas() {
  let signedIn = false;
  try {
    const resp = await fetch("/api/me");
    signedIn = resp.ok;
  } catch {
    // offline — keep public CTAs
  }

  if (signedIn) {
    for (const id of ["nav-sign-in", "nav-sign-up", "hero-sign-up", "cta-sign-up"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.href = DASHBOARD_PATH;
      el.textContent = t(detectLocale(), "nav.openDashboard");
      if (id === "nav-sign-in") el.classList.remove("btn-ghost");
      if (id === "nav-sign-in") el.classList.add("btn-primary");
      if (id === "nav-sign-up") el.hidden = true;
    }
    return;
  }

  setCta("nav-sign-in", "/sign-in/", "nav.signIn");
  setCta("nav-sign-up", "/sign-up/", "nav.signUp");
  setCta("hero-sign-up", "/sign-up/", "hero.ctaPrimary");
  setCta("cta-sign-up", "/sign-up/", "cta.button");
}

initI18n();
wireSessionAwareCtas();

document.addEventListener("roxabi:locale", () => {
  wireSessionAwareCtas();
});
