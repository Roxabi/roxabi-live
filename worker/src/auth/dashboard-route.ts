/**
 * GET /dashboard — session-gated shell for the dep-graph app.
 * Unauthenticated requests redirect to /login before any dashboard HTML is served.
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import {
  authRedirect,
  clearSessionCookie,
  readSessionToken,
  withAuthNoCache,
} from "./cookies";
import { validateSession } from "./session";

export const DASHBOARD_PATH = "/dashboard";

/** Build /login?redirect=… preserving dashboard query (e.g. ?install=1). */
export function dashboardLoginUrl(reqUrl: URL): string {
  const redirectPath = reqUrl.pathname + reqUrl.search;
  return `/login?redirect=${encodeURIComponent(redirectPath)}`;
}

export async function dashboardRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const reqUrl = new URL(c.req.url);
  const loginDest = dashboardLoginUrl(reqUrl);

  const token = readSessionToken(c);
  if (!token) {
    return authRedirect(loginDest);
  }

  const session = await validateSession(c.env.DB, token);
  if (!session) {
    // Drop stale cookie so /login → OAuth → callback does not loop with a dead token.
    return authRedirect(loginDest, { "Set-Cookie": clearSessionCookie() });
  }

  const assetUrl = new URL(c.req.url);
  assetUrl.pathname = "/dashboard/index.html";
  const assetRes = await c.env.ASSETS.fetch(
    new Request(assetUrl.toString(), c.req.raw),
  );
  return withAuthNoCache(assetRes);
}