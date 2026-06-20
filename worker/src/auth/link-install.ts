/**
 * Link install-pending sessions (tenant_id IS NULL) to a sole active installation.
 */

import { setSessionTenant } from "./session";
import type { SessionContext } from "./types";

export interface ActiveInstallation {
  tenant_id: number;
  account_login: string;
  account_type: string;
}

export const ACTIVE_INSTALLATIONS_SQL = `SELECT ui.tenant_id AS tenant_id, t.account_login AS account_login, t.account_type AS account_type
       FROM user_installations ui
       JOIN tenants t ON t.id = ui.tenant_id
       WHERE ui.user_id = ? AND t.deleted_at IS NULL AND t.suspended_at IS NULL
       ORDER BY ui.tenant_id`;

export async function listActiveInstallations(
  db: D1Database,
  userId: number,
): Promise<ActiveInstallation[]> {
  const rows = await db.prepare(ACTIVE_INSTALLATIONS_SQL).bind(userId).all<ActiveInstallation>();
  return rows.results ?? [];
}

/**
 * When the user has exactly one active installation, persist it on the session row.
 * @returns new tenant id, or null when auto-link was not performed.
 */
export async function tryLinkInstallPendingSession(
  db: D1Database,
  rawToken: string | null,
  session: SessionContext,
): Promise<number | null> {
  if (!rawToken || session.tenantId != null) {
    return session.tenantId;
  }

  const installations = await listActiveInstallations(db, session.userId);
  if (installations.length !== 1) {
    return null;
  }

  const tenantId = installations[0].tenant_id;
  const upgraded = await setSessionTenant(db, rawToken, tenantId);
  if (!upgraded) {
    return null;
  }

  await db
    .prepare(
      `UPDATE users SET install_targets_json = NULL, updated_at = datetime('now') WHERE id = ?`,
    )
    .bind(session.userId)
    .run();

  return tenantId;
}
