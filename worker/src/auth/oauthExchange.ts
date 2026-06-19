/**
 * Legacy GET /auth/exchange — session cookie already set on /oauth/callback.
 * Serves dashboard when session is valid; otherwise expired.
 */

import type { Context } from "hono";
import { readSessionToken } from "./cookies";
import { serveDashboardShell } from "./dashboard-route";
import { validateSession } from "./session";
import type { AuthEnv } from "./types";

export async function authExchangeRoute(c: Context<AuthEnv>): Promise<Response> {
  const token = readSessionToken(c);
  if (token) {
    const session = await validateSession(c.env.DB, token);
    if (session) {
      return serveDashboardShell(c.env, c.req.raw, c.req.url);
    }
  }
  return c.json({ error: "expired" }, 400);
}
