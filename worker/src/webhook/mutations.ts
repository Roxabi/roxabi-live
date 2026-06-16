/**
 * D1 mutation helpers for the webhook layer.
 *
 * Verbatim port of src/roxabi_live/corpus/mutations.py to the Cloudflare
 * Workers / D1 runtime.
 *
 * Design contract (mirrors the Python original):
 * - NEVER call .run() inside a helper — the caller owns the transaction
 *   boundary via db.batch([...stmts]).
 * - Single-statement helpers return D1PreparedStatement.
 * - Multi-statement helpers (upsertEdges, replaceLabels) return
 *   D1PreparedStatement[] so the caller can fold them into one batch.
 * - SQL constants are exported so callers can inspect or test them.
 */

// ---------------------------------------------------------------------------
// SQL constants (verbatim from corpus/sync.py — SSoT for both paths)
// ---------------------------------------------------------------------------

/** Webhook upsert — preserves status (Project v2) and has_active_branch. */
export const UPSERT_ISSUE_FROM_WEBHOOK_SQL = `
  INSERT INTO issues
      (key, repo, number, payload, state, url, created_at, updated_at, closed_at,
       milestone, is_stub, lane, priority, size, status, has_active_branch)
  VALUES
      (?, ?, ?, json_object('title', ?), ?, ?, ?, ?, ?,
       ?, 0, ?, ?, ?, NULL, 0)
  ON CONFLICT(key) DO UPDATE SET
      repo       = excluded.repo,
      number     = excluded.number,
      payload    = excluded.payload,
      state      = excluded.state,
      url        = excluded.url,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      closed_at  = excluded.closed_at,
      milestone  = excluded.milestone,
      is_stub    = excluded.is_stub,
      lane       = excluded.lane,
      priority   = excluded.priority,
      size       = excluded.size
`;

/** PR state upsert — shared with sync path (byte-identical SQL on both paths). */
export const UPSERT_PR_STATE_SQL = `
  INSERT INTO pr_state
      (repo, number, state, has_reviewed_label, closing_issue_keys, updated_at)
  VALUES
      (?, ?, ?, ?, ?, ?)
  ON CONFLICT(repo, number) DO UPDATE SET
      state               = excluded.state,
      has_reviewed_label  = excluded.has_reviewed_label,
      closing_issue_keys  = excluded.closing_issue_keys,
      updated_at          = excluded.updated_at
`;

const DELETE_LABELS_SQL = "DELETE FROM labels WHERE issue_key = ?";
const INSERT_LABEL_SQL = "INSERT OR IGNORE INTO labels (issue_key, name) VALUES (?, ?)";
const DELETE_EDGES_BY_KIND_SQL =
  "DELETE FROM edges WHERE (src_key = ? OR dst_key = ?) AND kind = ?";
const INSERT_EDGE_SQL = "INSERT OR IGNORE INTO edges (src_key, dst_key, kind) VALUES (?, ?, ?)";
const DELETE_EDGE_SQL =
  "DELETE FROM edges WHERE src_key = ? AND dst_key = ? AND kind = ?";
const SET_ACTIVE_BRANCH_ON_SQL =
  "UPDATE issues SET has_active_branch=1 WHERE repo=? AND number=?";
const SET_ACTIVE_BRANCH_OFF_SQL =
  "UPDATE issues SET has_active_branch=0 WHERE repo=? AND number=?";
const RENAME_MILESTONE_SQL =
  "UPDATE issues SET milestone = ? WHERE repo = ? AND milestone = ?";

/** Upsert the data_version key in sync_control with the given ISO-8601 timestamp. */
export const BUMP_DATA_VERSION_SQL = `
  INSERT INTO sync_control (tenant_id, key, value, updated_at)
  VALUES (0, 'data_version', ?, ?)
  ON CONFLICT(tenant_id, key) DO UPDATE SET
      value      = excluded.value,
      updated_at = excluded.updated_at
`;

// ---------------------------------------------------------------------------
// WebhookIssue — partial issue shape expected by upsertIssue
// ---------------------------------------------------------------------------

export interface WebhookIssue {
  key: string;
  repo: string;
  number: number;
  title: string;
  state: string;
  url: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  closed_at?: string | null;
  milestone?: string | null;
  lane?: string | null;
  priority?: string | null;
  size?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers — each returns D1PreparedStatement (or array); never calls .run()
// ---------------------------------------------------------------------------

/**
 * Prepare an upsert statement for an issue from a webhook payload.
 * Uses UPSERT_ISSUE_FROM_WEBHOOK_SQL — preserves status and has_active_branch.
 */
export function upsertIssueFromWebhook(db: D1Database, issue: WebhookIssue): D1PreparedStatement {
  return db.prepare(UPSERT_ISSUE_FROM_WEBHOOK_SQL).bind(
    issue.key,
    issue.repo,
    issue.number,
    issue.title,
    issue.state,
    issue.url,
    issue.created_at ?? null,
    issue.updated_at ?? null,
    issue.closed_at ?? null,
    issue.milestone ?? null,
    issue.lane ?? null,
    issue.priority ?? null,
    issue.size ?? null,
  );
}

/**
 * Prepare statements to wipe all labels for an issue key and rewrite them.
 * Returns [DELETE stmt, ...INSERT stmts].
 */
export function replaceLabels(
  db: D1Database,
  key: string,
  names: string[],
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [db.prepare(DELETE_LABELS_SQL).bind(key)];
  for (const name of names) {
    stmts.push(db.prepare(INSERT_LABEL_SQL).bind(key, name));
  }
  return stmts;
}

/**
 * Prepare a single INSERT OR IGNORE edge statement.
 */
export function addEdge(
  db: D1Database,
  src: string,
  dst: string,
  kind: string,
): D1PreparedStatement {
  return db.prepare(INSERT_EDGE_SQL).bind(src, dst, kind);
}

/**
 * Prepare a single DELETE edge statement.
 */
export function removeEdge(
  db: D1Database,
  src: string,
  dst: string,
  kind: string,
): D1PreparedStatement {
  return db.prepare(DELETE_EDGE_SQL).bind(src, dst, kind);
}

/**
 * Prepare a DELETE issue statement.
 */
export function deleteIssue(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare("DELETE FROM issues WHERE key = ?").bind(key);
}

/**
 * Prepare statements to wipe all edges touching issueKey (as src OR dst) of
 * the given kind, then rewrite from blockedBy + blocking.
 *
 * Canonical direction (mirrors corpus/mutations.py):
 *   blockedBy: every b → row (src=b, dst=issueKey)
 *   blocking:  every b → row (src=issueKey, dst=b)
 *
 * Returns [DELETE stmt, ...INSERT stmts].
 */
export function upsertEdges(
  db: D1Database,
  issueKey: string,
  blockedBy: string[],
  blocking: string[],
  kind: string = "parent",
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [
    db.prepare(DELETE_EDGES_BY_KIND_SQL).bind(issueKey, issueKey, kind),
  ];
  for (const blocker of blockedBy) {
    stmts.push(db.prepare(INSERT_EDGE_SQL).bind(blocker, issueKey, kind));
  }
  for (const blockee of blocking) {
    stmts.push(db.prepare(INSERT_EDGE_SQL).bind(issueKey, blockee, kind));
  }
  return stmts;
}

/**
 * Prepare a statement to set or clear has_active_branch for an issue.
 * value: 1 = active, 0 = clear.
 */
export function setActiveBranch(
  db: D1Database,
  repo: string,
  number: number,
  value: 0 | 1,
): D1PreparedStatement {
  const sql = value ? SET_ACTIVE_BRANCH_ON_SQL : SET_ACTIVE_BRANCH_OFF_SQL;
  return db.prepare(sql).bind(repo, number);
}

/**
 * Prepare a statement to upsert a pr_state row.
 */
export function upsertPrState(
  db: D1Database,
  repo: string,
  number: number,
  state: string,
  hasReviewedLabel: 0 | 1,
  closingIssueKeysJson: string,
  updatedAt: string,
): D1PreparedStatement {
  return db.prepare(UPSERT_PR_STATE_SQL).bind(
    repo,
    number,
    state,
    hasReviewedLabel,
    closingIssueKeysJson,
    updatedAt,
  );
}

/**
 * Prepare a statement that bumps the data_version key in sync_control.
 * The iso parameter must be an ISO-8601 string (used as both value and updated_at).
 * Returns a D1PreparedStatement — caller folds it into the batch; never calls .run() here.
 */
export function bumpDataVersion(db: D1Database, iso: string): D1PreparedStatement {
  return db.prepare(BUMP_DATA_VERSION_SQL).bind(iso, iso);
}

/**
 * Prepare a statement to rename a milestone across all issues in a repo.
 */
export function renameMilestone(
  db: D1Database,
  repo: string,
  oldTitle: string,
  newTitle: string,
): D1PreparedStatement {
  return db.prepare(RENAME_MILESTONE_SQL).bind(newTitle, repo, oldTitle);
}

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

const SOFT_DELETE_TENANT_SQL =
  "UPDATE tenants SET deleted_at=?, updated_at=? WHERE id=?";

const SET_TENANT_SUSPENDED_SQL =
  "UPDATE tenants SET suspended_at=?, updated_at=? WHERE id=?";

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
  return db
    .prepare(SET_TENANT_SUSPENDED_SQL)
    .bind(suspendedAtOrNull, nowIso, tenantId);
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

const DELETE_REPO_ACCESS_SQL =
  "DELETE FROM tenant_repo_access WHERE tenant_id=? AND repo=?";

const DELETE_ALL_REPO_ACCESS_FOR_TENANT_SQL =
  "DELETE FROM tenant_repo_access WHERE tenant_id=?";

const SET_REPO_PRIVACY_SQL =
  "UPDATE tenant_repo_access SET is_private=? WHERE repo=?";

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
  const oldPrefix = oldFullName + "#";
  const newPrefix = newFullName + "#";
  const oldPrefixLen = oldPrefix.length;
  return [
    db.prepare(`UPDATE repos SET repo=? WHERE repo=?`).bind(newFullName, oldFullName),
    db
      .prepare(`UPDATE tenant_repo_access SET repo=? WHERE repo=?`)
      .bind(newFullName, oldFullName),
    // issues: key = repo#number — recompute key from the intact number column
    db
      .prepare(`UPDATE issues SET repo=?, key=? || '#' || number WHERE repo=?`)
      .bind(newFullName, newFullName, oldFullName),
    // edges src_key: match rows whose src_key starts with oldPrefix, rewrite prefix
    db
      .prepare(
        `UPDATE edges SET src_key = ? || substr(src_key, ?) WHERE substr(src_key, 1, ?) = ?`,
      )
      .bind(newPrefix, oldPrefixLen + 1, oldPrefixLen, oldPrefix),
    // edges dst_key: same logic for dst_key
    db
      .prepare(
        `UPDATE edges SET dst_key = ? || substr(dst_key, ?) WHERE substr(dst_key, 1, ?) = ?`,
      )
      .bind(newPrefix, oldPrefixLen + 1, oldPrefixLen, oldPrefix),
  ];
}

// ---------------------------------------------------------------------------
// Permission cache invalidation helpers
// ---------------------------------------------------------------------------

const INVALIDATE_CACHE_BY_REPO_SQL =
  "DELETE FROM user_repo_permission_cache WHERE repo=?";

const INVALIDATE_CACHE_BY_USER_REPO_SQL =
  "DELETE FROM user_repo_permission_cache WHERE user_id=? AND repo=?";

const INVALIDATE_CACHE_BY_USER_SQL =
  "DELETE FROM user_repo_permission_cache WHERE user_id=?";

/**
 * Prepare a delete of all permission-cache entries for a given repo.
 * Use when a repo's privacy status changes (privatize/publicize).
 */
export function invalidateCacheByRepo(
  db: D1Database,
  repo: string,
): D1PreparedStatement {
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
export function invalidateCacheByUser(
  db: D1Database,
  userId: number,
): D1PreparedStatement {
  return db.prepare(INVALIDATE_CACHE_BY_USER_SQL).bind(userId);
}

// ---------------------------------------------------------------------------
// Session / install-token cleanup helpers
// ---------------------------------------------------------------------------

const DELETE_SESSIONS_FOR_TENANT_SQL =
  "DELETE FROM sessions WHERE tenant_id=?";

const DELETE_INSTALL_TOKENS_FOR_TENANT_SQL =
  "DELETE FROM install_tokens WHERE tenant_id=?";

/**
 * Prepare a delete of all active sessions for a tenant.
 * Used on uninstall to force re-auth on next login.
 */
export function deleteSessionsForTenant(
  db: D1Database,
  tenantId: number,
): D1PreparedStatement {
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
