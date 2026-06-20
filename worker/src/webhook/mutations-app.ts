/**
 * App-lifecycle D1 mutation helpers for the webhook layer.
 *
 * Split out of mutations.ts (file-length gate): mutations.ts keeps the
 * issue/edge/PR/milestone "corpus" helpers; this module owns the GitHub App
 * install-lifecycle writes (tenant lifecycle, repo access, repo registry +
 * cascade rename, permission-cache invalidation, session/install-token cleanup).
 *
 * Same design contract as mutations.ts:
 * - NEVER call .run() inside a helper — the caller owns the transaction
 *   boundary via db.batch([...stmts]).
 * - Single-statement helpers return D1PreparedStatement.
 * - Multi-statement helpers return D1PreparedStatement[].
 */
// ---------------------------------------------------------------------------
// Tenant lifecycle helpers
// ---------------------------------------------------------------------------

const UPSERT_TENANT_SQL = `
  INSERT INTO tenants (installation_id, account_login, account_type, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(installation_id) DO UPDATE SET
    account_login = excluded.account_login,
    account_type  = excluded.account_type,
    updated_at    = excluded.updated_at,
    suspended_at  = NULL,
    deleted_at    = NULL
`;

const SOFT_DELETE_TENANT_SQL = "UPDATE tenants SET deleted_at=?, updated_at=? WHERE id=?";

const SET_TENANT_SUSPENDED_SQL = "UPDATE tenants SET suspended_at=?, updated_at=? WHERE id=?";

/**
 * Prepare an upsert for a tenant row.
 *
 * On conflict (re-install after soft-delete or suspend), clears both
 * deleted_at and suspended_at; created_at is preserved via the INSERT
 * value being excluded from the UPDATE SET.
 */
export function upsertTenant(
  db: D1Database,
  t: {
    installation_id: number;
    account_login: string;
    account_type: string;
    nowIso: string;
  },
): D1PreparedStatement {
  return db
    .prepare(UPSERT_TENANT_SQL)
    .bind(t.installation_id, t.account_login, t.account_type, t.nowIso, t.nowIso);
}

/**
 * Prepare a soft-delete for a tenant (sets deleted_at; row is retained).
 */
export function softDeleteTenant(
  db: D1Database,
  tenantId: number,
  nowIso: string,
): D1PreparedStatement {
  return db.prepare(SOFT_DELETE_TENANT_SQL).bind(nowIso, nowIso, tenantId);
}

/**
 * Prepare a statement to set or clear the suspended_at timestamp for a tenant.
 * Pass null for suspendedAtOrNull to unsuspend.
 */
export function setTenantSuspended(
  db: D1Database,
  tenantId: number,
  suspendedAtOrNull: string | null,
  nowIso: string,
): D1PreparedStatement {
  return db.prepare(SET_TENANT_SUSPENDED_SQL).bind(suspendedAtOrNull, nowIso, tenantId);
}

// ---------------------------------------------------------------------------
// Repository access helpers
// ---------------------------------------------------------------------------

const UPSERT_REPO_ACCESS_SQL = `
  INSERT INTO tenant_repo_access (tenant_id, repo, is_private)
  VALUES (?, ?, ?)
  ON CONFLICT(tenant_id, repo) DO UPDATE SET
    is_private = excluded.is_private
`;

const DELETE_REPO_ACCESS_SQL = "DELETE FROM tenant_repo_access WHERE tenant_id=? AND repo=?";

const DELETE_ALL_REPO_ACCESS_FOR_TENANT_SQL = "DELETE FROM tenant_repo_access WHERE tenant_id=?";

const SET_REPO_PRIVACY_SQL = "UPDATE tenant_repo_access SET is_private=? WHERE repo=?";

/**
 * Prepare an upsert for a single repo in tenant_repo_access.
 */
export function upsertRepoAccess(
  db: D1Database,
  tenantId: number,
  repo: string,
  isPrivate: 0 | 1,
): D1PreparedStatement {
  return db.prepare(UPSERT_REPO_ACCESS_SQL).bind(tenantId, repo, isPrivate);
}

/**
 * Prepare a delete for a single repo from tenant_repo_access.
 * Issues/edges for that repo are retained (globally shared).
 */
export function deleteRepoAccess(
  db: D1Database,
  tenantId: number,
  repo: string,
): D1PreparedStatement {
  return db.prepare(DELETE_REPO_ACCESS_SQL).bind(tenantId, repo);
}

/**
 * Prepare a delete of all repo-access rows for a tenant.
 * Used on app uninstall (H2). Issues/edges are retained.
 */
export function deleteAllRepoAccessForTenant(
  db: D1Database,
  tenantId: number,
): D1PreparedStatement {
  return db.prepare(DELETE_ALL_REPO_ACCESS_FOR_TENANT_SQL).bind(tenantId);
}

/**
 * Prepare a repo-wide privacy flip in tenant_repo_access.
 * Affects all tenants that have this repo registered (repo is the key).
 */
export function setRepoPrivacy(
  db: D1Database,
  repo: string,
  isPrivate: 0 | 1,
): D1PreparedStatement {
  return db.prepare(SET_REPO_PRIVACY_SQL).bind(isPrivate, repo);
}

const UPSERT_REPO_SQL = `
  INSERT INTO repos (repo, archived, repo_node_id)
  VALUES (?, ?, ?)
  ON CONFLICT(repo) DO UPDATE SET
    archived = excluded.archived,
    repo_node_id = COALESCE(excluded.repo_node_id, repos.repo_node_id)
`;

/**
 * Prepare an upsert into the global `repos` table (the dropdown / graph source).
 *
 * Used by the `repository.created` webhook (#160 fallout) so a brand-new repo is
 * registered in real time rather than waiting up to 24h for the daily cron.
 * repo_node_id is preserved via COALESCE when the payload omits it (the daily
 * sync fills it lazily otherwise; the rename cascade relies on it as anchor).
 */
export function upsertRepo(
  db: D1Database,
  repo: string,
  archived: 0 | 1,
  nodeId: string | null,
): D1PreparedStatement {
  return db.prepare(UPSERT_REPO_SQL).bind(repo, archived, nodeId);
}

/**
 * Prepare a cascade rename across all repo-keyed tables.
 *
 * Prefix-safe edge rewrite strategy:
 *   Issue keys have the format `{repo}#{number}`. A naive REPLACE or LIKE
 *   would match `_` / `%` metacharacters in repo names (unlikely but valid
 *   in forks). Instead we bind the computed prefix strings as parameters and
 *   use substr() + length comparisons — zero metachar risk, no escaping needed.
 *
 *   The substr() offset is 1-based in SQLite:
 *     src_key[0 .. oldPrefixLen-1] == oldPrefix  →  replace with newPrefix
 *     new key = newPrefix || src_key[oldPrefixLen+1 ..]
 *
 * sync_control sentinel rows (tenant_id = 0, Deviation D-2) are intentionally
 * NOT touched: sync_control keys are not repo-scoped, so no cascade is needed.
 *
 * Returns D1PreparedStatement[] — the caller folds into db.batch([...stmts]).
 */
export function cascadeRepoRename(
  db: D1Database,
  oldFullName: string,
  newFullName: string,
): D1PreparedStatement[] {
  const oldPrefix = `${oldFullName}#`;
  const newPrefix = `${newFullName}#`;
  const oldPrefixLen = oldPrefix.length;
  return [
    db.prepare("UPDATE repos SET repo=? WHERE repo=?").bind(newFullName, oldFullName),
    db.prepare("UPDATE tenant_repo_access SET repo=? WHERE repo=?").bind(newFullName, oldFullName),
    // issues: key = repo#number — recompute key from the intact number column
    db
      .prepare(`UPDATE issues SET repo=?, key=? || '#' || number WHERE repo=?`)
      .bind(newFullName, newFullName, oldFullName),
    // edges src_key: match rows whose src_key starts with oldPrefix, rewrite prefix
    db
      .prepare("UPDATE edges SET src_key = ? || substr(src_key, ?) WHERE substr(src_key, 1, ?) = ?")
      .bind(newPrefix, oldPrefixLen + 1, oldPrefixLen, oldPrefix),
    // edges dst_key: same logic for dst_key
    db
      .prepare("UPDATE edges SET dst_key = ? || substr(dst_key, ?) WHERE substr(dst_key, 1, ?) = ?")
      .bind(newPrefix, oldPrefixLen + 1, oldPrefixLen, oldPrefix),
  ];
}

// ---------------------------------------------------------------------------
// Permission cache invalidation helpers
// ---------------------------------------------------------------------------

const INVALIDATE_CACHE_BY_REPO_SQL = "DELETE FROM user_repo_permission_cache WHERE repo=?";

const INVALIDATE_CACHE_BY_USER_REPO_SQL =
  "DELETE FROM user_repo_permission_cache WHERE user_id=? AND repo=?";

const INVALIDATE_CACHE_BY_USER_SQL = "DELETE FROM user_repo_permission_cache WHERE user_id=?";

/**
 * Prepare a delete of all permission-cache entries for a given repo.
 * Use when a repo's privacy status changes (privatize/publicize).
 */
export function invalidateCacheByRepo(db: D1Database, repo: string): D1PreparedStatement {
  return db.prepare(INVALIDATE_CACHE_BY_REPO_SQL).bind(repo);
}

/**
 * Prepare a delete of the permission-cache entry for a specific (user, repo) pair.
 * Use when a user loses access to a specific repo (member removed).
 */
export function invalidateCacheByUserRepo(
  db: D1Database,
  userId: number,
  repo: string,
): D1PreparedStatement {
  return db.prepare(INVALIDATE_CACHE_BY_USER_REPO_SQL).bind(userId, repo);
}

/**
 * Prepare a delete of all permission-cache entries for a given user.
 * Use when a user loses org membership (all repo access revoked).
 */
export function invalidateCacheByUser(db: D1Database, userId: number): D1PreparedStatement {
  return db.prepare(INVALIDATE_CACHE_BY_USER_SQL).bind(userId);
}

// ---------------------------------------------------------------------------
// Session / install-token cleanup helpers
// ---------------------------------------------------------------------------

const DELETE_SESSIONS_FOR_TENANT_SQL = "DELETE FROM sessions WHERE tenant_id=?";

const DELETE_INSTALL_TOKENS_FOR_TENANT_SQL = "DELETE FROM install_tokens WHERE tenant_id=?";

/**
 * Prepare a delete of all active sessions for a tenant.
 * Used on uninstall to force re-auth on next login.
 */
export function deleteSessionsForTenant(db: D1Database, tenantId: number): D1PreparedStatement {
  return db.prepare(DELETE_SESSIONS_FOR_TENANT_SQL).bind(tenantId);
}

/**
 * Prepare a delete of the cached install token for a tenant.
 * Used on uninstall to remove the encrypted token from the D1 cache.
 */
export function deleteInstallTokensForTenant(
  db: D1Database,
  tenantId: number,
): D1PreparedStatement {
  return db.prepare(DELETE_INSTALL_TOKENS_FOR_TENANT_SQL).bind(tenantId);
}
