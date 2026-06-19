/**
 * GET /dashboard — session-gated shell for the dep-graph app.
 * Unauthenticated requests redirect to /login before any dashboard HTML is served.
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import { readSessionToken } from "./cookies";
import { validateSession } from "./session";

export const DASHBOARD_PATH = "/dashboard";
export const DASHBOARD_LOGIN = `/login?redirect=${encodeURIComponent(DASHBOARD_PATH)}`;

export async function dashboardRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const token = readSessionToken(c);
  if (!token) {
    return c.redirect(DASHBOARD_LOGIN, 302);
  }

  const session = await validateSession(c.env.DB, token);
  if (!session) {
    return c.redirect(DASHBOARD_LOGIN, 302);
  }

  const assetUrl = new URL(c.req.url);
  assetUrl.pathname = "/dashboard/index.html";
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
}