/**
 * /api/me — current user profile + installations.
 * /logout  — revoke session cookie.
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/session";
import { readSessionToken, deleteSession, clearSessionCookie } from "../auth/session";

// ---------------------------------------------------------------------------
// GET /api/me
// ---------------------------------------------------------------------------

/**
 * Returns the authenticated user's GitHub identity and their GitHub App
 * installations (tenants) linked to their account.
 */
export async function meRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const rows = await c.env.DB
    .prepare(
      `SELECT ui.tenant_id AS tenant_id, t.installation_id AS installation_id, t.account_login AS account_login
       FROM user_installations ui JOIN tenants t ON t.id = ui.tenant_id WHERE ui.user_id = ?`,
    )
    .bind(s.userId)
    .all<{ tenant_id: number; installation_id: number; account_login: string }>();

  return c.json({
    user: {
      github_id: s.githubId,
      github_login: s.githubLogin,
    },
    installations: rows.results,
  });
}

// ---------------------------------------------------------------------------
// POST /logout
// ---------------------------------------------------------------------------

/**
 * Revokes the current session (deletes from D1) and clears the session cookie.
 * Gracefully handles the case where no cookie is present (returns 204 anyway).
 */
export async function logoutRoute(c: Context<AuthEnv>): Promise<Response> {
  const raw = readSessionToken(c);
  if (raw) {
    await deleteSession(c.env.DB, raw);
  }

  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}
