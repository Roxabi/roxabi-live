/**
 * GET /dashboard — session-gated shell for the dep-graph app.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import {
  AUTH_NO_CACHE,
  authRedirect,
  clearSessionCookieHeaders,
  readSessionToken,
} from "./cookies";
import { validateSession } from "./session";
import type { AuthEnv } from "./types";

export const DASHBOARD_PATH = "/dashboard";

const DASHBOARD_LOGIN_STRIP = ["install", "code", "state", "intent"] as const;

/** Build /login?redirect=… — never embed install/intent flags in redirect=. */
export function dashboardLoginUrl(reqUrl: URL): string {
  const pathUrl = new URL(reqUrl.pathname + reqUrl.search, "https://_/");
  for (const key of DASHBOARD_LOGIN_STRIP) {
    pathUrl.searchParams.delete(key);
  }
  const pathname = pathUrl.pathname.replace(/\/$/, "") || "/dashboard";
  const redirectPath = `${pathname}${pathUrl.search}`;
  return `/login?redirect=${encodeURIComponent(redirectPath)}`;
}

/** Strip stale auth handoff params from the dashboard URL (refresh-safe). */
export function dashboardCleanUrl(reqUrl: URL): string | null {
  if (!reqUrl.searchParams.has("code") && !reqUrl.searchParams.has("state")) {
    return null;
  }
  const pathUrl = new URL(reqUrl.pathname + reqUrl.search, "https://_/");
  for (const key of DASHBOARD_LOGIN_STRIP) {
    pathUrl.searchParams.delete(key);
  }
  const pathname = pathUrl.pathname.replace(/\/$/, "") || "/dashboard";
  return `${pathname}${pathUrl.search}`;
}

export async function dashboardRoute(c: Context<AuthEnv>): Promise<Response> {
  const reqUrl = new URL(c.req.url);
  const loginDest = dashboardLoginUrl(reqUrl);

  const token = readSessionToken(c);
  if (!token) {
    return authRedirect(loginDest);
  }

  const session = await validateSession(c.env.DB, token);
  if (!session) {
    return authRedirect(loginDest, clearSessionCookieHeaders());
  }

  const clean = dashboardCleanUrl(reqUrl);
  if (clean) {
    return authRedirect(clean);
  }

  return serveDashboardShell(c.env, c.req.raw, c.req.url);
}

/** Serve dashboard/index.html with auth no-cache headers (optional Set-Cookie). */
export async function serveDashboardShell(
  env: Env,
  raw: Request,
  reqUrl: string,
  extraSetCookies: string[] = [],
): Promise<Response> {
  const assetUrl = new URL(reqUrl);
  // Request the canonical directory form, NOT "/dashboard/index.html".
  // Cloudflare Assets (default html_handling: "auto-trailing-slash") answers
  // "/dashboard/index.html" with a 307 → "/dashboard/". serveDashboardShell
  // propagates the asset status verbatim, so fetching the .html form turns this
  // into a redirect that bounces back through dashboardRoute → 307 → … →
  // ERR_TOO_MANY_REDIRECTS for any authenticated user. "/dashboard/" is the
  // canonical 200 form and never redirects.
  assetUrl.pathname = "/dashboard/";
  const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), raw));
  const headers = new Headers(assetRes.headers);
  for (const [key, value] of Object.entries(AUTH_NO_CACHE)) {
    headers.set(key, value);
  }
  for (const cookie of extraSetCookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(assetRes.body, { status: assetRes.status, headers });
}
