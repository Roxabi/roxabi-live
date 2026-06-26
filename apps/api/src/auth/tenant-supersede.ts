/**
 * Supersede stale GitHub App installations for the same account.
 *
 * Re-installing the App on an org creates a new installation_id. Older rows stay
 * in D1 until explicitly retired — this module soft-deletes them and migrates
 * sessions to the current installation's tenant.
 */

import {
  deleteAllRepoAccessForTenant,
  deleteInstallTokensForTenant,
  softDeleteTenant,
} from "../webhook/mutations-app";

export async function listStaleTenantIds(
  db: D1Database,
  accountLogin: string,
  accountType: string,
  keepInstallationId: number,
): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT id FROM tenants
       WHERE account_login = ?
         AND account_type = ?
         AND installation_id != ?
         AND deleted_at IS NULL`,
    )
    .bind(accountLogin, accountType, keepInstallationId)
    .all<{ id: number }>();

  return (rows.results ?? []).map((r) => r.id);
}

/**
 * Retire older active tenants for the same GitHub account and point live
 * sessions at keepTenantId. Returns the superseded tenant ids.
 */
export async function supersedeStaleTenants(
  db: D1Database,
  params: {
    keepTenantId: number;
    accountLogin: string;
    accountType: string;
    installationId: number;
    nowIso: string;
  },
): Promise<number[]> {
  const staleIds = await listStaleTenantIds(
    db,
    params.accountLogin,
    params.accountType,
    params.installationId,
  );
  if (staleIds.length === 0) {
    return [];
  }

  const stmts: D1PreparedStatement[] = [];
  for (const staleId of staleIds) {
    stmts.push(softDeleteTenant(db, staleId, params.nowIso));
    stmts.push(deleteAllRepoAccessForTenant(db, staleId));
    stmts.push(deleteInstallTokensForTenant(db, staleId));
    stmts.push(db.prepare("DELETE FROM user_installations WHERE tenant_id = ?").bind(staleId));
    stmts.push(
      db
        .prepare(
          `UPDATE sessions SET tenant_id = ?
           WHERE tenant_id = ? AND revoked_at IS NULL`,
        )
        .bind(params.keepTenantId, staleId),
    );
  }

  await db.batch(stmts);
  console.log(
    `[tenant] superseded ${staleIds.length} stale tenant(s) for ${params.accountLogin} → tenant ${params.keepTenantId}`,
  );
  return staleIds;
}

/**
 * Pick the session tenant from OAuth upserts — prefer active tenants with repos,
 * then the newest installation.
 */
export async function pickSessionTenantId(
  db: D1Database,
  tenantIds: number[],
): Promise<number | null> {
  if (tenantIds.length === 0) {
    return null;
  }
  if (tenantIds.length === 1) {
    return tenantIds[0];
  }

  const placeholders = tenantIds.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT t.id AS id
       FROM tenants t
       LEFT JOIN (
         SELECT tenant_id, COUNT(*) AS repo_count
         FROM tenant_repo_access
         GROUP BY tenant_id
       ) rc ON rc.tenant_id = t.id
       WHERE t.id IN (${placeholders})
         AND t.deleted_at IS NULL
         AND t.suspended_at IS NULL
       ORDER BY COALESCE(rc.repo_count, 0) DESC, t.created_at DESC
       LIMIT 1`,
    )
    .bind(...tenantIds)
    .first<{ id: number }>();

  return row?.id ?? tenantIds[0];
}
