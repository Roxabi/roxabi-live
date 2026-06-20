// auth-pages.js — shared logic for sign-in / sign-up public pages

import { detectLocale, t } from "./i18n.js";
import { initPublicPage } from "./public-shell.js";

const DASHBOARD_PATH = "/dashboard";
const GITHUB_ICON = `<svg class="auth-github-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>`;

/** @param {string | null | undefined} raw */
function safeAuthRedirect(raw) {
  const candidate = raw?.trim();
  if (
    candidate &&
    /^\/(?![/\\])/.test(candidate) &&
    !/[\r\n\0]/.test(candidate) &&
    !/["'<>]/.test(candidate)
  ) {
    return candidate;
  }
  return DASHBOARD_PATH;
}

function authRedirectDest() {
  return safeAuthRedirect(new URLSearchParams(location.search).get("redirect"));
}

async function redirectIfAuthenticated() {
  try {
    const resp = await fetch("/api/me");
    if (!resp.ok) return false;
    const me = await resp.json();
    if (!me?.user) return false;
    location.replace(authRedirectDest());
    return true;
  } catch {
    return false;
  }
}

/** @param {'signin'|'signup'} mode */
function oauthUrl(mode) {
  const redirect = new URLSearchParams(location.search).get("redirect") || DASHBOARD_PATH;
  const intent = mode === "signup" ? "signin" : "signin";
  const params = new URLSearchParams({ intent, redirect });
  return `/login?${params}`;
}

/** @param {'signin'|'signup'} mode */
function wireGithubButton(mode) {
  const btn = document.getElementById("auth-github-btn");
  if (!btn) return;
  btn.href = oauthUrl(mode);
  const label = btn.querySelector("span");
  if (label && !btn.querySelector(".auth-github-icon")) {
    label.insertAdjacentHTML("beforebegin", GITHUB_ICON);
  }
}

function wireAltLink(mode) {
  const altLink = document.getElementById("auth-alt-link");
  if (!altLink) return;
  const locale = detectLocale();
  const target = mode === "signin" ? "/sign-up/" : "/sign-in/";
  altLink.href = target + location.search;
  altLink.textContent =
    mode === "signin" ? t(locale, "signIn.createAccount") : t(locale, "signUp.signIn");
}

/** @param {'signin'|'signup'} mode */
export async function initAuthPage(mode) {
  if (await redirectIfAuthenticated()) return;
  await initPublicPage({ variant: "minimal" });
  wireGithubButton(mode);
  wireAltLink(mode);

  document.addEventListener("roxabi:locale", () => {
    wireGithubButton(mode);
    wireAltLink(mode);
  });
}
