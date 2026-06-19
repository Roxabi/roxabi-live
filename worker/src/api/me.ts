/**
 * /api/me — current user profile + installations.
 * /logout  — revoke session cookie.
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { readSessionToken, clearSessionCookie } from "../auth/cookies";
import { deleteSession } from "../auth/session";
import { zkAccountKeyEnabled } from "../auth/zk-flags";
import { parseInstallTargets } from "../auth/github-install";

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

  const userRow = await c.env.DB
    .prepare(`SELECT zk_opt_in, install_targets_json FROM users WHERE id = ?`)
    .bind(s.userId)
    .first<{ zk_opt_in: number; install_targets_json: string | null }>();

  const enrolledRow = await c.env.DB
    .prepare(
      `SELECT 1 AS ok FROM zk_key_backups WHERE user_id = ? LIMIT 1`,
    )
    .bind(s.userId)
    .first<{ ok: number }>();

  const rows = await c.env.DB
    .prepare(
      `SELECT ui.tenant_id AS tenant_id, t.account_login AS account_login, t.account_type AS account_type
       FROM user_installations ui JOIN tenants t ON t.id = ui.tenant_id WHERE ui.user_id = ?`,
    )
    .bind(s.userId)
    .all<{ tenant_id: number; account_login: string; account_type: string }>();

  const installations = rows.results;
  const installTargets =
    installations.length === 0
      ? parseInstallTargets(userRow?.install_targets_json)
      : [];

  return c.json({
    user: {
      github_id: s.githubId,
      github_login: s.githubLogin,
      zk_opt_in: userRow?.zk_opt_in === 1,
      zk_enrolled: enrolledRow != null,
      zk_account_key_enabled: zkAccountKeyEnabled(c.env),
    },
    active_tenant_id: s.tenantId,
    install_pending: s.tenantId == null,
    install_targets: installTargets,
    installations,
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
