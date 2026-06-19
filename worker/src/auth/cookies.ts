import type { Context } from "hono";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./types";

// ---------------------------------------------------------------------------
// Auth response cache policy — never cache session-gated redirects/HTML.
// Browsers may cache 302s without Cache-Control; private mode works because
// its cache is empty while a normal profile keeps stale /dashboard → /login hops.
// ---------------------------------------------------------------------------

export const AUTH_NO_CACHE: Record<string, string> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Cookie",
};

/** Safe relative redirect target (open-redirect guards). */
export function sanitizeAuthRedirect(raw: string | undefined): string {
  if (raw && /^\/(?![/\\])/.test(raw) && !/[\r\n\0]/.test(raw)) return raw;
  return "/dashboard";
}

/** 302 redirect that must not be stored by the browser or CDN. */
export function authRedirect(
  location: string,
  extra?: Record<string, string>,
): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, ...AUTH_NO_CACHE, ...extra },
  });
}

/** Apply auth no-cache headers to an existing response (e.g. ASSETS HTML). */
export function withAuthNoCache(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(AUTH_NO_CACHE)) {
    headers.set(key, value);
  }
  return new Response(res.body, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// Cookie helpers (pure, synchronous)
// ---------------------------------------------------------------------------

/**
 * Build a Set-Cookie header value for the session token.
 * __Host- prefix requires: Secure, Path=/, no Domain.
 */
export function sessionCookie(rawToken: string): string {
  // Lax (not Strict): OAuth return is a cross-site top-level navigation from GitHub.
  return `${SESSION_COOKIE}=${rawToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/**
 * Build a Set-Cookie header value that immediately expires the session cookie.
 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * 200 HTML shell that sets the session cookie then navigates client-side.
 * Avoids 302+Set-Cookie races where the browser follows Location before
 * committing __Host-session (ERR_TOO_MANY_REDIRECTS on /dashboard?install=1).
 * Navigation is deferred (no meta refresh) so Set-Cookie is committed first.
 */
export function sessionRedirectHtml(dest: string, rawToken: string): Response {
  const safeDest = sanitizeAuthRedirect(dest);
  // Server-side hop confirms the cookie before the final dashboard load.
  const continueUrl = `/auth/continue?to=${encodeURIComponent(safeDest)}`;
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
  function poll() {
    fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) {
        if (r.ok) return go();
        if (++tries >= max) {
          document.getElementById("msg").innerHTML =
            'Session lente — <a href="' + next + '">continuer</a>';
          return;
        }
        setTimeout(poll, 150);
      })
      .catch(function () {
        if (++tries >= max) {
          document.getElementById("msg").innerHTML =
            'Session lente — <a href="' + next + '">continuer</a>';
          return;
        }
        setTimeout(poll, 150);
      });
  }
  setTimeout(poll, 50);
})(${JSON.stringify(continueUrl)});
</script>
<noscript><p><a href="${encodeURI(continueUrl)}">Continuer</a></p></noscript>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": sessionCookie(rawToken),
      ...AUTH_NO_CACHE,
    },
  });
}

// ---------------------------------------------------------------------------
// Token reader
// ---------------------------------------------------------------------------

/**
 * Parse the __Host-session cookie value from the Cookie header.
 * Returns null if the cookie is absent or the header is missing.
 */
export function readSessionToken(c: Context): string | null {
  const cookieHeader = c.req.header("Cookie");
  if (!cookieHeader) return null;

  let last: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    if (name === SESSION_COOKIE) {
      last = trimmed.slice(eqIdx + 1).trim() || null;
    }
  }
  return last;
}
