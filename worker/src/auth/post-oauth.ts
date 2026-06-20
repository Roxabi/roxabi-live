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
import { serveDashboardShell } from "./dashboard-route";

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
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Connexion…</title>
</head>
<body>
<p id="msg">Connexion en cours…</p>
<script>
(function (next) {
  var tries = 0;
  var max = 40;
  function go() { location.replace(next); }
  function showSlowLink() {
    var msg = document.getElementById("msg");
    msg.textContent = "";
    var a = document.createElement("a");
    a.href = next;
    a.textContent = "continuer";
    msg.appendChild(document.createTextNode("Session lente — "));
    msg.appendChild(a);
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
<noscript><p><a href="${htmlAttrEscape(safeDest)}">Continuer</a></p></noscript>
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
  c: Context<{ Bindings: Env }>,
  rawToken: string,
  redirectAfter: string,
  remember = false,
): Promise<Response> {
  const cookies = sessionCookieHeaders(rawToken, sessionTtlSeconds(remember));
  const dest = sanitizeAuthRedirect(redirectAfter);

  if (isDashboardDest(dest) && !destHasZkParams(dest)) {
    return serveDashboardShell(c.env, c.req.raw, c.req.url, cookies);
  }
  if (destHasZkParams(dest)) {
    return authNavigateHtml(dest, cookies);
  }
  return authRedirect(dest, cookies);
}
