/**
 * GET /dashboard — session-gated shell for the dep-graph app.
 * Unauthenticated requests redirect to /login before any dashboard HTML is served.
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import {
  AUTH_NO_CACHE,
  authRedirect,
  clearSessionCookieHeaders,
  readSessionToken,
} from "./cookies";
import { validateSession } from "./session";

export const DASHBOARD_PATH = "/dashboard";

/** Query params that must not round-trip through /login?redirect= (auth handoff / loops). */
const DASHBOARD_LOGIN_STRIP = ["install", "code", "state"] as const;

/** Build /login?redirect=… — never embed install=1 (use /login?install=1 instead). */
export function dashboardLoginUrl(reqUrl: URL): string {
  const pathUrl = new URL(reqUrl.pathname + reqUrl.search, "https://_/");
  for (const key of DASHBOARD_LOGIN_STRIP) {
    pathUrl.searchParams.delete(key);
  }
  const pathname = pathUrl.pathname.replace(/\/$/, "") || "/dashboard";
  const redirectPath = `${pathname}${pathUrl.search}`;
  return `/login?redirect=${encodeURIComponent(redirectPath)}`;
}

export async function dashboardRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const reqUrl = new URL(c.req.url);

  // OAuth callback or one-shot exchange must not hit the session gate (redirect loop).
  const handoffCode = reqUrl.searchParams.get("code");
  if (handoffCode) {
    const handoffState = reqUrl.searchParams.get("state");
    if (handoffState) {
      const callback = new URL("/oauth/callback", reqUrl.origin);
      callback.search = reqUrl.search;
      return authRedirect(`${callback.pathname}${callback.search}`);
    }
    return authRedirect(
      `/auth/exchange?code=${encodeURIComponent(handoffCode)}`,
    );
  }

  const loginDest = dashboardLoginUrl(reqUrl);

  const token = readSessionToken(c);
  if (!token) {
    return authRedirect(loginDest);
  }

  const session = await validateSession(c.env.DB, token);
  if (!session) {
    // Drop stale cookie so /login → OAuth → callback does not loop with a dead token.
    return authRedirect(loginDest, clearSessionCookieHeaders());
  }

  return serveDashboardShell(c);
}

/** Serve dashboard/index.html with auth no-cache headers (optional Set-Cookie). */
export async function serveDashboardShell(
  c: Context<AuthEnv>,
  extraSetCookies: string[] = [],
): Promise<Response> {
  const assetUrl = new URL(c.req.url);
  assetUrl.pathname = "/dashboard/index.html";
  const assetRes = await c.env.ASSETS.fetch(
    new Request(assetUrl.toString(), c.req.raw),
  );
  const headers = new Headers(assetRes.headers);
  for (const [key, value] of Object.entries(AUTH_NO_CACHE)) {
    headers.set(key, value);
  }
  for (const cookie of extraSetCookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(assetRes.body, { status: assetRes.status, headers });
}