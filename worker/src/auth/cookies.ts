import type { Context } from "hono";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "./types";

// ---------------------------------------------------------------------------
// Cookie helpers (pure, synchronous)
// ---------------------------------------------------------------------------

/**
 * Build a Set-Cookie header value for the session token.
 * __Host- prefix requires: Secure, Path=/, no Domain.
 */
export function sessionCookie(rawToken: string): string {
  return `${SESSION_COOKIE}=${rawToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/**
 * Build a Set-Cookie header value that immediately expires the session cookie.
 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * 200 HTML shell that sets the session cookie then navigates client-side.
 * Avoids 302+Set-Cookie races where the browser follows Location before
 * committing __Host-session (ERR_TOO_MANY_REDIRECTS on /dashboard?install=1).
 */
export function sessionRedirectHtml(dest: string, rawToken: string): Response {
  const safeDest =
    dest.startsWith("/") && !dest.startsWith("//") && !/[\r\n\0]/.test(dest)
      ? dest
      : "/dashboard";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${encodeURI(safeDest)}">
<title>Signing in…</title>
</head>
<body>
<p>Signing in… <a href="${encodeURI(safeDest)}">Continue</a></p>
<script>location.replace(${JSON.stringify(safeDest)});</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": sessionCookie(rawToken),
      "Cache-Control": "no-store",
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

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    if (name === SESSION_COOKIE) {
      return trimmed.slice(eqIdx + 1).trim() || null;
    }
  }
  return null;
}
