/**
 * POST /api/install/refresh — link new GitHub App installs without full re-OAuth.
 *
 * Relies on installation.created webhook → user_installations (sender match).
 * Returns 202 while webhook is in flight; OAuth fallback URL when exhausted.
 */

import type { Context } from "hono";
import { readSessionToken } from "../auth/cookies";
import { setSessionTenant } from "../auth/session";
import type { AuthEnv } from "../auth/types";
import { buildMePayload } from "./me";

export const OAUTH_FALLBACK = "/login?intent=install&redirect=%2Fdashboard";

const INSTALLATIONS_SQL = `SELECT ui.tenant_id AS tenant_id, t.account_login AS account_login, t.account_type AS account_type
       FROM user_installations ui
       JOIN tenants t ON t.id = ui.tenant_id
       WHERE ui.user_id = ? AND t.deleted_at IS NULL AND t.suspended_at IS NULL
       ORDER BY ui.tenant_id`;

export async function installRefreshRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const rows = await c.env.DB.prepare(INSTALLATIONS_SQL)
    .bind(s.userId)
    .all<{ tenant_id: number; account_login: string; account_type: string }>();

  const installations = rows.results;
  if (installations.length === 0) {
    return c.json(
      {
        status: "pending",
        retry_after_ms: 2000,
        oauth_fallback: OAUTH_FALLBACK,
      },
      202,
    );
  }

  let activeTenantId = s.tenantId;
  const rawToken = readSessionToken(c);

  if (rawToken && activeTenantId == null && installations.length === 1) {
    const upgraded = await setSessionTenant(
      c.env.DB,
      rawToken,
      installations[0].tenant_id,
    );
    if (!upgraded) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await c.env.DB.prepare(
      `UPDATE users SET install_targets_json = NULL, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(s.userId)
      .run();
    activeTenantId = installations[0].tenant_id;
  }

  const payload = await buildMePayload(c.env, {
    ...s,
    tenantId: activeTenantId,
  });
  return c.json({ status: "linked", ...payload });
}
