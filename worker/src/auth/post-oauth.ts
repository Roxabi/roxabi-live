/**
 * Post-OAuth response — Set-Cookie + serve dashboard (200) or navigate to dest.
 *
 * 200 + Set-Cookie avoids cookie loss on redirect chains (Opera/normal profile).
 * ZK handoff params need a client navigation so they land on /dashboard?zk_*.
 */

import type { Context } from "hono";
import type { Env } from "../types";

import {
  AUTH_NO_CACHE,
  authRedirect,
  isDashboardDest,
  sanitizeAuthRedirect,
  sessionCookieHeaders,
  sessionTtlSeconds,
} from "./cookies";

function destHasZkParams(path: string): boolean {
  const url = new URL(path, "https://_/");
  return url.searchParams.has("zk_handoff") || url.searchParams.has("zk_reauth");
}

function htmlAttrEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#x27;");
}

/** 200 HTML: poll /api/me until cookie is live, then location.replace(dest). */
export function authNavigateHtml(dest: string, extraSetCookies: string[] = []): Response {
  const safeDest = sanitizeAuthRedirect(dest);
  const html = `<!DOCTYPE html>
<html lang="fr" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Connexion · Roxabi Live</title>
<link rel="icon" href="/assets/logo/foundation-block-16.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700&amp;display=swap">
<style>
:root{color-scheme:dark;--bg:#0d1117;--bg-elevated:#13191f;--border:#21262d;--border-hi:#30363d;--text:#f0ede6;--text-muted:#8b93a1;--accent:#f0b429;--accent-dim:rgba(240,180,41,.14);--accent-glow:rgba(240,180,41,.35);--panel-shadow:0 8px 24px rgba(0,0,0,.5);--radius-lg:14px;--font-body:"Inter",system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 80% 50% at 50% -10%,var(--accent-glow),transparent 55%),radial-gradient(ellipse 40% 30% at 100% 0%,rgba(20,184,166,.08),transparent 50%);z-index:0}
.auth-nav-shell{position:relative;z-index:1;width:100%;max-width:380px}
.auth-nav-card{background:var(--bg-elevated);border:1px solid var(--border-hi);border-radius:var(--radius-lg);box-shadow:var(--panel-shadow);padding:32px 28px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:18px}
.auth-nav-brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;letter-spacing:-.02em}
.auth-nav-brand img{width:28px;height:28px}
.auth-nav-brand .accent{color:var(--accent)}
.auth-nav-spinner{width:40px;height:40px;border-radius:50%;border:3px solid var(--border);border-top-color:var(--accent);animation:auth-nav-spin .9s linear infinite}
@keyframes auth-nav-spin{to{transform:rotate(360deg)}}
.auth-nav-msg{font-weight:500;margin:0}
.auth-nav-hint{color:var(--text-muted);font-size:13px;margin:0;max-width:28ch}
.auth-nav-link{color:var(--accent);font-weight:600;text-decoration:none}
.auth-nav-link:hover{text-decoration:underline}
.auth-nav-foot{color:var(--text-muted);font-size:12px;margin:0}
</style>
</head>
<body>
<main class="auth-nav-shell" role="main">
  <div class="auth-nav-card" role="status" aria-live="polite" aria-busy="true">
    <div class="auth-nav-brand">
      <img src="/assets/logo/foundation-block-16.svg" alt="" width="28" height="28" />
      <span>Roxabi <span class="accent">Live</span></span>
    </div>
    <div class="auth-nav-spinner" aria-hidden="true"></div>
    <p class="auth-nav-msg" id="msg">Connexion en cours…</p>
    <p class="auth-nav-hint" id="hint">Préparation de votre session sécurisée</p>
  </div>
  <p class="auth-nav-foot">Ne fermez pas cet onglet</p>
</main>
<script>
(function (next) {
  var tries = 0;
  var max = 40;
  function go() { location.replace(next); }
  function showSlowLink() {
    var msg = document.getElementById("msg");
    var hint = document.getElementById("hint");
    var card = msg && msg.closest(".auth-nav-card");
    if (card) card.setAttribute("aria-busy", "false");
    if (msg) msg.textContent = "Session lente";
    if (hint) {
      hint.innerHTML = 'La connexion prend plus de temps que prévu. <a class="auth-nav-link" href="' + next.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '">Continuer vers le dashboard</a>';
    }
  }
  function poll() {
    fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (r.ok) return go();
        if (++tries >= max) return showSlowLink();
        setTimeout(poll, 150);
      })
      .catch(function () {
        if (++tries >= max) return showSlowLink();
        setTimeout(poll, 150);
      });
  }
  setTimeout(poll, 50);
})(${JSON.stringify(safeDest)});
</script>
<noscript>
  <p style="text-align:center;margin-top:16px"><a class="auth-nav-link" href="${htmlAttrEscape(safeDest)}">Continuer vers le dashboard</a></p>
</noscript>
</body>
</html>`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    ...AUTH_NO_CACHE,
  });
  for (const cookie of extraSetCookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(html, { status: 200, headers });
}

/** Finish OAuth: set session cookie and deliver the post-auth destination. */
export async function completeOAuthSession(
  _c: Context<{ Bindings: Env }>,
  rawToken: string,
  redirectAfter: string,
  remember = false,
): Promise<Response> {
  const cookies = sessionCookieHeaders(rawToken, sessionTtlSeconds(remember));
  const dest = sanitizeAuthRedirect(redirectAfter);

  // Always poll /api/me then navigate to dest — never serve the dashboard shell
  // at /oauth/callback?code=&state= (stale URL caused repeated ZK key-backup fetches).
  if (isDashboardDest(dest) || destHasZkParams(dest)) {
    return authNavigateHtml(dest, cookies);
  }
  return authRedirect(dest, cookies);
}
