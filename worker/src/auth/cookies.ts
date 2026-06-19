import type { Context } from "hono";
import {
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "./types";

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
  let candidate = raw?.trim();
  if (!candidate) return "/dashboard";

  // Recover once-encoded paths from double-encoded login links (%252F → %2F → /).
  if (!/^\/(?![/\\])/.test(candidate) && /^%2[fF]/.test(candidate)) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (/^\/(?![/\\])/.test(decoded) && !/[\r\n\0]/.test(decoded)) {
        candidate = decoded;
      }
    } catch {
      /* keep candidate */
    }
  }

  if (/^\/(?![/\\])/.test(candidate) && !/[\r\n\0]/.test(candidate)) {
    return candidate;
  }
  return "/dashboard";
}

/** True when a relative path targets the dashboard shell. */
export function isDashboardDest(path: string): boolean {
  const url = new URL(path, "https://_/");
  return url.pathname === "/dashboard" || url.pathname === "/dashboard/";
}

/** Remove ?install=1 — only needed to trigger server-side re-OAuth, not for rendering. */
export function stripInstallParam(path: string): string {
  const url = new URL(path, "https://_/");
  if (!url.searchParams.has("install")) return path;
  url.searchParams.delete("install");
  const pathname = url.pathname.replace(/\/$/, "") || "/dashboard";
  return `${pathname}${url.search}`;
}

/** 302 redirect that must not be stored by the browser or CDN. */
export function authRedirect(
  location: string,
  extraSetCookies: string[] = [],
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({ Location: location, ...AUTH_NO_CACHE, ...extraHeaders });
  for (const cookie of extraSetCookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
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

function expireCookie(name: string): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/**
 * Build a Set-Cookie header value for the session token.
 */
export function sessionCookie(rawToken: string): string {
  return `${SESSION_COOKIE}=${rawToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/** Expire primary + legacy session cookies. */
export function clearSessionCookieHeaders(): string[] {
  return [expireCookie(SESSION_COOKIE), expireCookie(LEGACY_SESSION_COOKIE)];
}

/** @deprecated use clearSessionCookieHeaders — first legacy clear line for tests */
export function clearSessionCookie(): string {
  return clearSessionCookieHeaders()[0];
}

/** Set new session and expire legacy __Host-session. */
export function sessionCookieHeaders(rawToken: string): string[] {
  return [sessionCookie(rawToken), expireCookie(LEGACY_SESSION_COOKIE)];
}

// ---------------------------------------------------------------------------
// Token reader
// ---------------------------------------------------------------------------

/** Parse a named cookie from the Cookie header. */
export function readNamedCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  let last: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx).trim() === name) {
      last = trimmed.slice(eqIdx + 1).trim() || null;
    }
  }
  return last;
}

/**
 * Parse session cookie — prefers roxabi_session, falls back to legacy __Host-session.
 */
export function readSessionToken(c: Context): string | null {
  const header = c.req.header("Cookie");
  return (
    readNamedCookie(header, SESSION_COOKIE) ??
    readNamedCookie(header, LEGACY_SESSION_COOKIE)
  );
}