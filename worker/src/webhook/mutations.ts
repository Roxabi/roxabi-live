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
