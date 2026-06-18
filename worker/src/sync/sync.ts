/**
 * Corpus sync engine — TypeScript port of corpus/sync.py for Cloudflare Workers D1.
 *
 * Two-pass design:
 *   Pass 1: syncRepoIssues — upsert issues + labels per repo, collect EdgeData
 *   Pass 2: flushEdges — write all edges in chunked batches (no cross-page FK hazard)
 *
 * Auth-halt circuit breaker in sync_control (auth_failures >= 2 → halted=1).
 * Advisory distributed lock via sync_control.sync_running (stale after 900 s).
 */

import { ghGraphql, GraphQLError } from "./graphql";
import {
  ISSUES_QUERY,
  PRS_QUERY,
  REFS_QUERY,
  REPO_BUNDLE_QUERY,
  STUB_ISSUE_QUERY,
} from "./queries";
import type { Env } from "../types";
import { getInstallationToken, listInstallationRepos } from "../auth/installToken";
import { d1PayloadTitle, loadZkSealedIssueKeys } from "../auth/zk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_PAGES = 500;
/**
 * Repos synced per cron tick. Capped at 20 to stay under the Workers Free
 * 50-subrequest/invocation budget: a FULL reconcile (#80, since=null) costs
 * ~1 subrequest per issue page, and the largest repo (roxabi-factory, ~1k
 * issues) alone is ~11 pages — so a single run cannot reconcile all repos.
 */
export const WINDOW = 20;
/**
 * Rotation slots. Coverage ceiling = WINDOW * NUM_SLOTS = 40 repos; with the
 * daily cron each repo is full-reconciled every NUM_SLOTS days (= 2). 36 repos
 * today → fits in 2 slots, no wasted tick. Beyond 40 repos, raise this / WINDOW
 * (watch the subreq budget) or migrate to the dormant Queues fan-out (wrangler.toml).
 */
export const NUM_SLOTS = 2;

/** Verbatim port of sync.py UPSERT_ISSUE_SQL — full sync path (sets status=null). */
export const UPSERT_ISSUE_SQL = `
  INSERT INTO issues
      (key, repo, number, payload, state, url, created_at, updated_at,
       closed_at, milestone, is_stub, lane, priority, size, status,
       has_active_branch)
  VALUES
      (?, ?, ?, json_object('title', ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
      repo              = excluded.repo,
      number            = excluded.number,
      payload           = excluded.payload,
      state             = excluded.state,
      url               = excluded.url,
      created_at        = excluded.created_at,
      updated_at        = excluded.updated_at,
      closed_at         = excluded.closed_at,
      milestone         = excluded.milestone,
      is_stub           = excluded.is_stub,
      lane              = excluded.lane,
      priority          = excluded.priority,
      size              = excluded.size,
      status            = excluded.status,
      has_active_branch = excluded.has_active_branch
`;

// ---------------------------------------------------------------------------
// Regex constants (verbatim from sync.py)
// ---------------------------------------------------------------------------

const _BARE_INT = /^\d+$/;
const _SHORT_FORM = /^#(\d+)$/;
const _FULL_KEY = /^[\w.-]+\/[\w.-]+#\d+$/;
export const BRANCH_ISSUE_RE = /^(?:[a-z]+\/)?(\d+)-/;

// ---------------------------------------------------------------------------
// Vocab maps (verbatim from sync.py)
// ---------------------------------------------------------------------------

const _LANE_PREFIX = "graph:lane/";
const _SIZE_PREFIX = "size:";
const _LEGACY_SIZE_MAP: Record<string, string> = { M: "F-lite" };
const _LEGACY_SIZE_RAW = new Set(["XS", "S", "M", "L", "XL"]);
const _PRIORITY_EXACT: Record<string, string> = {
  P0: "P0",
  "priority:P0": "P0",
  "P1-high": "P1",
  "priority:high": "P1",
  "priority:P1": "P1",
  "P2-medium": "P2",
  "priority:medium": "P2",
  "priority:P2": "P2",
  "P3-low": "P3",
  "priority:low": "P3",
  "priority: low": "P3",
  "priority:P3": "P3",
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Derive lane/priority/size from a label list. First match wins per field. */
export function extractFromLabels(labels: string[]): {
  lane: string | null;
  priority: string | null;
  size: string | null;
} {
  let lane: string | null = null;
  let priority: string | null = null;
  let size: string | null = null;

  for (const lbl of labels) {
    if (lane === null && lbl.startsWith(_LANE_PREFIX)) {
      lane = lbl.slice(_LANE_PREFIX.length);
    }
    if (priority === null && lbl in _PRIORITY_EXACT) {
      priority = _PRIORITY_EXACT[lbl];
    }
    if (size === null && lbl.startsWith(_SIZE_PREFIX)) {
      const raw = lbl.slice(_SIZE_PREFIX.length);
      size = _LEGACY_SIZE_MAP[raw] ?? raw;
    }
  }
  // Legacy fallback for bare size labels (only if size: prefix not found)
  if (size === null) {
    for (const lbl of labels) {
      if (_LEGACY_SIZE_RAW.has(lbl)) {
        size = lbl;
        break;
      }
    }
  }

  return { lane, priority, size };
}

/**
 * Canonicalise an issue reference to 'owner/repo#N' form.
 *
 *   42 + 'Roxabi/lyra'          → 'Roxabi/lyra#42'
 *   '42' + 'Roxabi/lyra'        → 'Roxabi/lyra#42'
 *   '#9' + 'Roxabi/lyra'        → 'Roxabi/lyra#9'
 *   'Roxabi/voiceCLI#7' + _any_ → 'Roxabi/voiceCLI#7'
 */
export function canonicalKey(ref: number | string, repo: string): string {
  if (typeof ref === "number") return `${repo}#${ref}`;
  const s = String(ref);
  if (_FULL_KEY.test(s)) return s;
  const mShort = _SHORT_FORM.exec(s);
  if (mShort) return `${repo}#${mShort[1]}`;
  if (_BARE_INT.test(s)) return `${repo}#${s}`;
  throw new Error(`Cannot canonicalise issue ref: ${JSON.stringify(ref)}`);
}

// ---------------------------------------------------------------------------
// Edge collection
// ---------------------------------------------------------------------------

export interface EdgeData {
  parents: string[];
  children: string[];
  blockedBy: string[];
  blocking: string[];
}

type IssueNode = {
  number: number;
  subIssues?: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
  parent?: { number: number; repository: { nameWithOwner: string } } | null;
  blockedBy?: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
  blocking?: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
};

/** Collect edge references from a GraphQL issue node into collectedEdges map. */
export function collectEdges(
  node: IssueNode,
  repo: string,
  key: string,
  collectedEdges: Map<string, EdgeData>,
): void {
  const children = (node.subIssues?.nodes ?? []).map((t) =>
    canonicalKey(t.number, t.repository.nameWithOwner),
  );
  const parentNode = node.parent ?? null;
  const parents = parentNode
    ? [canonicalKey(parentNode.number, parentNode.repository.nameWithOwner)]
    : [];
  const blockedBy = (node.blockedBy?.nodes ?? []).map((t) =>
    canonicalKey(t.number, t.repository.nameWithOwner),
  );
  const blocking = (node.blocking?.nodes ?? []).map((t) =>
    canonicalKey(t.number, t.repository.nameWithOwner),
  );

  collectedEdges.set(key, { parents, children, blockedBy, blocking });
}

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

/**
 * Execute D1 statements in chunks of `size` (default 900).
 * NEVER calls db.batch([]) — guards against empty array.
 */
export async function batchChunked(
  db: D1Database,
  stmts: D1PreparedStatement[],
  size = 900,
): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) {
    const chunk = stmts.slice(i, i + size);
    if (chunk.length > 0) {
      await db.batch(chunk);
    }
  }
}

// ---------------------------------------------------------------------------
// sync_control helpers
// ---------------------------------------------------------------------------

export async function acquireSyncLock(db: D1Database, tenantId: number = 0): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sync_control
       SET value = '1', updated_at = ?
       WHERE key = 'sync_running'
         AND tenant_id = ?
         AND (value = '0' OR (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', updated_at) AS INTEGER)) > 900)`,
    )
    .bind(new Date().toISOString(), tenantId)
    .run();
  return result.meta.changes > 0;
}

export async function releaseSyncLock(db: D1Database, tenantId: number = 0): Promise<void> {
  await db
    .prepare(`UPDATE sync_control SET value='0', updated_at=? WHERE key='sync_running' AND tenant_id = ?`)
    .bind(new Date().toISOString(), tenantId)
    .run();
}

export async function isHalted(db: D1Database, tenantId: number = 0): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM sync_control WHERE key='halted' AND tenant_id = ?`)
    .bind(tenantId)
    .first<{ value: string }>();
  return row?.value === "1";
}

export async function getAuthFailures(db: D1Database, tenantId: number = 0): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM sync_control WHERE key='auth_failures' AND tenant_id = ?`)
    .bind(tenantId)
    .first<{ value: string }>();
  return parseInt(row?.value ?? "0", 10);
}

export async function incrementAuthFailures(db: D1Database, tenantId: number = 0): Promise<number> {
  await db
    .prepare(
      `UPDATE sync_control SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT), updated_at=?
       WHERE key='auth_failures' AND tenant_id = ?`,
    )
    .bind(new Date().toISOString(), tenantId)
    .run();
  return getAuthFailures(db, tenantId);
}

export async function haltSync(db: D1Database, tenantId: number = 0): Promise<void> {
  await db
    .prepare(`UPDATE sync_control SET value='1', updated_at=? WHERE key='halted' AND tenant_id = ?`)
    .bind(new Date().toISOString(), tenantId)
    .run();
}

export async function resetAuthFailures(db: D1Database, tenantId: number = 0): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_control SET value='0', updated_at=? WHERE key='auth_failures' AND tenant_id = ?`,
    )
    .bind(new Date().toISOString(), tenantId)
    .run();
}

// ---------------------------------------------------------------------------
// syncRepoIssues
// ---------------------------------------------------------------------------

interface IssueNodeFull {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  milestone: { title: string } | null;
  labels: { nodes: Array<{ name: string }> };
  subIssues: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
  parent: { number: number; repository: { nameWithOwner: string } } | null;
  blockedBy: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
  blocking: { nodes: Array<{ number: number; repository: { nameWithOwner: string } }> };
}
interface IssuesData {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: IssueNodeFull[];
    };
  };
  rateLimit: { cost: number; remaining: number; resetAt: string };
}

/**
 * Paginate ISSUES_QUERY for one repo, upsert issues+labels, collect EdgeData.
 * Writes sync_state ONCE after the full loop (not per-page — prevents partial watermark).
 */
export async function syncRepoIssues(
  db: D1Database,
  token: string,
  owner: string,
  name: string,
  collectedEdges: Map<string, EdgeData>,
  fullSync = false,
  sealedKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  const repo = `${owner}/${name}`;
  let cursor: string | null = null;
  let pages = 0;

  // Read watermark from previous sync (null on first run → full fetch).
  // fullSync (#80) forces since=null to reconcile deps-only changes.
  let since: string | null = null;
  if (!fullSync) {
    const syncStateRow = await db
      .prepare("SELECT last_synced_at FROM sync_state WHERE repo=?")
      .bind(repo)
      .first<{ last_synced_at: string | null }>();
    since = syncStateRow?.last_synced_at ?? null;
  }

  while (true) {
    const response: { data: IssuesData } & Record<string, unknown> = await ghGraphql<IssuesData>(
      ISSUES_QUERY,
      { owner, name, cursor, since },
      token,
    );
    const data: IssuesData = response.data;
    const rl = data.rateLimit;
    console.log(
      `[sync] ${repo} p${pages + 1} cost=${rl.cost} remaining=${rl.remaining}`,
    );

    const issuesPage: IssuesData["repository"]["issues"] = data.repository.issues;
    const nodes = issuesPage.nodes;

    // Collect all D1 statements for this page into one batch
    const pageStmts: D1PreparedStatement[] = [];

    for (const node of nodes) {
      const key = canonicalKey(node.number, repo);
      const labels = node.labels.nodes.map((l: { name: string }) => l.name);
      const derived = extractFromLabels(labels);

      pageStmts.push(
        db.prepare(UPSERT_ISSUE_SQL).bind(
          key,
          repo,
          node.number,
          d1PayloadTitle(node.title, key, sealedKeys),
          node.state.toLowerCase(),
          node.url,
          node.createdAt,
          node.updatedAt,
          node.closedAt ?? null,
          node.milestone?.title ?? null,
          0, // is_stub
          derived.lane,
          derived.priority,
          derived.size,
          null, // status — managed by Project v2 board
          0, // has_active_branch — set by branch pass
        ),
      );

      // Label wipe + rewrite
      pageStmts.push(db.prepare("DELETE FROM labels WHERE issue_key=?").bind(key));
      for (const lbl of labels) {
        pageStmts.push(
          db.prepare("INSERT OR IGNORE INTO labels VALUES (?,?)").bind(key, lbl),
        );
      }

      // Collect edges (flush in pass 2)
      collectEdges(node, repo, key, collectedEdges);
    }

    await batchChunked(db, pageStmts);

    pages++;
    const pageInfo: { hasNextPage: boolean; endCursor: string | null } = issuesPage.pageInfo;

    if (!pageInfo.hasNextPage || pages >= MAX_PAGES) break;
    cursor = pageInfo.endCursor;
    if (!cursor) break;
  }

  // Write sync_state ONCE after full loop
  const nowIso = new Date().toISOString();
  await db
    .prepare(
      "INSERT OR REPLACE INTO sync_state(repo,last_cursor,last_synced_at) VALUES(?,NULL,?)",
    )
    .bind(repo, nowIso)
    .run();
}

// ---------------------------------------------------------------------------
// flushEdges (pass 2)
// ---------------------------------------------------------------------------

/**
 * Write all collected edges to D1 in chunked batches.
 * Always emits 2 DELETEs per issue key (parent + blocks) even with zero edges.
 */
export async function flushEdges(
  db: D1Database,
  collectedEdges: Map<string, EdgeData>,
): Promise<void> {
  const allStmts: D1PreparedStatement[] = [];

  for (const [issueKey, { parents, children, blockedBy, blocking }] of collectedEdges) {
    // Always wipe parent edges for this issue
    allStmts.push(
      db
        .prepare("DELETE FROM edges WHERE (src_key=? OR dst_key=?) AND kind='parent'")
        .bind(issueKey, issueKey),
    );
    // Only wipe blocks edges when there is blocks data (matches Python's guard)
    if (blockedBy.length > 0 || blocking.length > 0) {
      allStmts.push(
        db
          .prepare("DELETE FROM edges WHERE (src_key=? OR dst_key=?) AND kind='blocks'")
          .bind(issueKey, issueKey),
      );
    }

    for (const p of parents) {
      allStmts.push(
        db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,'parent')").bind(p, issueKey),
      );
    }
    for (const c of children) {
      allStmts.push(
        db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,'parent')").bind(issueKey, c),
      );
    }
    for (const b of blockedBy) {
      allStmts.push(
        db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,'blocks')").bind(b, issueKey),
      );
    }
    for (const bl of blocking) {
      allStmts.push(
        db.prepare("INSERT OR IGNORE INTO edges VALUES (?,?,'blocks')").bind(issueKey, bl),
      );
    }
  }

  await batchChunked(db, allStmts);
}

// ---------------------------------------------------------------------------
// syncBranches
// ---------------------------------------------------------------------------

interface RefsData {
  repository: {
    refs: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ name: string }>;
    };
  };
  rateLimit: { cost: number; remaining: number; resetAt: string };
}

/**
 * Pure D1 write: reset has_active_branch=0 for all issues in repo, then set=1
 * for each matched issue number.  Reset-then-set as ONE atomic db.batch (no
 * transient all-zero window).  Chunked at 90 to stay under D1 param limit.
 *
 * Extracted so both syncBranches (standalone REFS_QUERY fetch) and
 * syncRepoBundle (bundled fetch) can reuse the same write logic.
 */
export async function applyActiveBranches(
  db: D1Database,
  repo: string,
  matchedNumbers: number[],
): Promise<void> {
  if (matchedNumbers.length > 0) {
    const matched = [...new Set(matchedNumbers)];
    const stmts: D1PreparedStatement[] = [
      db.prepare("UPDATE issues SET has_active_branch=0 WHERE repo=?").bind(repo),
    ];
    for (let i = 0; i < matched.length; i += 90) {
      const chunk = matched.slice(i, i + 90);
      const ph = chunk.map(() => "?").join(",");
      stmts.push(
        db
          .prepare(`UPDATE issues SET has_active_branch=1 WHERE repo=? AND number IN (${ph})`)
          .bind(repo, ...chunk),
      );
    }
    await db.batch(stmts);
  } else {
    await db.prepare("UPDATE issues SET has_active_branch=0 WHERE repo=?").bind(repo).run();
  }
}

/**
 * Compute has_active_branch for all issues in repo.
 * Uses reset-then-set (not NOT IN) chunked at <=90 to stay under D1 param limit.
 */
export async function syncBranches(
  db: D1Database,
  token: string,
  owner: string,
  name: string,
): Promise<void> {
  const repo = `${owner}/${name}`;
  const matchedNumbers: number[] = [];
  let cursor: string | null = null;
  let pageCount = 0;

  while (true) {
    const response: { data: RefsData } & Record<string, unknown> = await ghGraphql<RefsData>(
      REFS_QUERY,
      { owner, name, cursor },
      token,
    );
    const data: RefsData = response.data;
    const rl = data.rateLimit;
    console.log(`[sync] branches ${repo} cost=${rl.cost} remaining=${rl.remaining}`);

    for (const node of data.repository.refs.nodes) {
      const m = BRANCH_ISSUE_RE.exec(node.name);
      if (m) matchedNumbers.push(parseInt(m[1], 10));
    }

    pageCount++;
    const pageInfo: { hasNextPage: boolean; endCursor: string | null } = data.repository.refs.pageInfo;
    if (!pageInfo.hasNextPage || pageCount >= MAX_PAGES) break;
    cursor = pageInfo.endCursor;
    if (!cursor) break;
  }

  await applyActiveBranches(db, repo, matchedNumbers);
}

// ---------------------------------------------------------------------------
// syncPRs
// ---------------------------------------------------------------------------

interface PRNode {
  number: number;
  state: string;
  closingIssuesReferences: {
    nodes: Array<{ number: number; repository: { nameWithOwner: string } }>;
  };
  labels: { nodes: Array<{ name: string }> };
}
interface PRsData {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: PRNode[];
    };
  };
  rateLimit: { cost: number; remaining: number; resetAt: string };
}

const UPSERT_PR_STATE_SQL = `
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

/**
 * Pure D1 write: flush PR upserts then close stale open PRs (diff in JS,
 * chunk <=90).  Extracted so both syncPRs (standalone PRS_QUERY fetch) and
 * syncRepoBundle (bundled fetch) can reuse the same write logic.
 */
export async function applyPrState(
  db: D1Database,
  repo: string,
  upsertStmts: D1PreparedStatement[],
  seenPrNumbers: number[],
): Promise<number> {
  await batchChunked(db, upsertStmts);

  if (seenPrNumbers.length > 0) {
    const openRows = await db
      .prepare(`SELECT number FROM pr_state WHERE repo=? AND state='open'`)
      .bind(repo)
      .all<{ number: number }>();
    const openNums = (openRows.results ?? []).map((r) => r.number);
    const stale = openNums.filter((n) => !seenPrNumbers.includes(n));

    for (let i = 0; i < stale.length; i += 90) {
      const chunk = stale.slice(i, i + 90);
      const ph = chunk.map(() => "?").join(",");
      await db
        .prepare(
          `UPDATE pr_state SET state='closed' WHERE repo=? AND state='open' AND number IN (${ph})`,
        )
        .bind(repo, ...chunk)
        .run();
    }
    return stale.length;
  } else {
    const res = await db
      .prepare(`UPDATE pr_state SET state='closed' WHERE repo=? AND state='open'`)
      .bind(repo)
      .run();
    return res.meta.changes ?? 0;
  }
}

/**
 * Sync pr_state for open PRs.
 * Stale detection: diff seen PR numbers in JS, chunk UPDATE <=90.
 */
export async function syncPRs(
  db: D1Database,
  token: string,
  owner: string,
  name: string,
): Promise<void> {
  const repo = `${owner}/${name}`;
  let cursor: string | null = null;
  const nowIso = new Date().toISOString();
  const seenPrNumbers: number[] = [];
  const upsertStmts: D1PreparedStatement[] = [];
  let pageCount = 0;

  while (true) {
    const response: { data: PRsData } & Record<string, unknown> = await ghGraphql<PRsData>(
      PRS_QUERY,
      { owner, name, cursor },
      token,
    );
    const data: PRsData = response.data;
    const rl = data.rateLimit;
    console.log(`[sync] prs ${repo} cost=${rl.cost} remaining=${rl.remaining}`);

    for (const pr of data.repository.pullRequests.nodes) {
      const labelNames = pr.labels.nodes.map((l: { name: string }) => l.name);
      const hasReviewedLabel = labelNames.includes("reviewed") ? 1 : 0;
      const closingRefs = pr.closingIssuesReferences?.nodes ?? [];
      const closingIssueKeys = closingRefs.map(
        (ref: { number: number; repository: { nameWithOwner: string } }) => `${ref.repository.nameWithOwner}#${ref.number}`,
      );

      seenPrNumbers.push(pr.number);
      upsertStmts.push(
        db.prepare(UPSERT_PR_STATE_SQL).bind(
          repo,
          pr.number,
          pr.state.toLowerCase(),
          hasReviewedLabel,
          JSON.stringify(closingIssueKeys),
          nowIso,
        ),
      );
    }

    pageCount++;
    const pageInfo: { hasNextPage: boolean; endCursor: string | null } = data.repository.pullRequests.pageInfo;
    if (!pageInfo.hasNextPage || pageCount >= MAX_PAGES) break;
    cursor = pageInfo.endCursor;
    if (!cursor) break;
  }

  await applyPrState(db, repo, upsertStmts, seenPrNumbers);
}

// ---------------------------------------------------------------------------
// syncRepoBundle — bundled per-repo fetch (issues + refs + PRs in 1 subreq)
// ---------------------------------------------------------------------------

interface BundleData {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: IssueNodeFull[];
    };
    refs: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ name: string }>;
    };
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: PRNode[];
    };
  };
  rateLimit: { cost: number; remaining: number; resetAt: string };
}

/**
 * Bundled per-repo sync — replaces three separate calls (syncRepoIssues +
 * syncBranches + syncPRs) with a single REPO_BUNDLE_QUERY subrequest per loop
 * iteration.  Three connections (issues / refs / pullRequests) share one HTTP
 * round-trip; each has its own cursor and "done" flag.  The loop continues as
 * long as any connection still has pages.
 *
 * Invariants preserved:
 *   - sync_state written ONCE after the full loop (no partial watermark)
 *   - reset-then-set has_active_branch via applyActiveBranches (atomic batch)
 *   - PR stale-close via applyPrState
 *   - edges collected into collectedEdges (flushed by caller in pass 2)
 */
export async function syncRepoBundle(
  db: D1Database,
  token: string,
  owner: string,
  name: string,
  collectedEdges: Map<string, EdgeData>,
  fullSync = false,
  sealedKeys: ReadonlySet<string> = new Set(),
): Promise<number> {
  const repo = `${owner}/${name}`;

  // Watermark gates the incremental fetch. fullSync (#80) forces since=null so a
  // complete re-fetch reconciles edges even for deps-only changes — which never
  // bump issue.updatedAt and are therefore invisible to an incremental `since`
  // query (only the webhook path catches them otherwise).
  let since: string | null = null;
  if (!fullSync) {
    const syncStateRow = await db
      .prepare("SELECT last_synced_at FROM sync_state WHERE repo=?")
      .bind(repo)
      .first<{ last_synced_at: string | null }>();
    since = syncStateRow?.last_synced_at ?? null;
  }

  // Per-connection cursor state
  let issuesCursor: string | null = null;
  let refsCursor: string | null = null;
  let prsCursor: string | null = null;
  let issuesDone = false;
  let refsDone = false;
  let prsDone = false;

  // Accumulate branch matches + PR upserts across pages
  const matchedBranchNumbers: number[] = [];
  const prUpsertStmts: D1PreparedStatement[] = [];
  const seenPrNumbers: number[] = [];
  const nowIso = new Date().toISOString();

  let pages = 0;

  while (!(issuesDone && refsDone && prsDone)) {
    if (pages >= MAX_PAGES) break;

    const response: { data: BundleData } & Record<string, unknown> =
      await ghGraphql<BundleData>(
        REPO_BUNDLE_QUERY,
        {
          owner,
          name,
          issuesCursor: issuesDone ? null : issuesCursor,
          refsCursor: issuesDone && refsDone ? null : refsCursor,
          prsCursor: issuesDone && refsDone && prsDone ? null : prsCursor,
          since,
        },
        token,
      );
    const data: BundleData = response.data;
    const rl = data.rateLimit;
    console.log(
      `[sync] bundle ${repo} p${pages + 1} cost=${rl.cost} remaining=${rl.remaining}`,
    );
    pages++;

    // --- issues ---
    if (!issuesDone) {
      const issuesPage = data.repository.issues;
      const pageStmts: D1PreparedStatement[] = [];

      for (const node of issuesPage.nodes) {
        const key = canonicalKey(node.number, repo);
        const labels = node.labels.nodes.map((l: { name: string }) => l.name);
        const derived = extractFromLabels(labels);

        pageStmts.push(
          db.prepare(UPSERT_ISSUE_SQL).bind(
            key,
            repo,
            node.number,
            d1PayloadTitle(node.title, key, sealedKeys),
            node.state.toLowerCase(),
            node.url,
            node.createdAt,
            node.updatedAt,
            node.closedAt ?? null,
            node.milestone?.title ?? null,
            0, // is_stub
            derived.lane,
            derived.priority,
            derived.size,
            null, // status
            0, // has_active_branch — set by applyActiveBranches after loop
          ),
        );
        pageStmts.push(db.prepare("DELETE FROM labels WHERE issue_key=?").bind(key));
        for (const lbl of labels) {
          pageStmts.push(
            db.prepare("INSERT OR IGNORE INTO labels VALUES (?,?)").bind(key, lbl),
          );
        }
        collectEdges(node, repo, key, collectedEdges);
      }

      await batchChunked(db, pageStmts);

      if (!issuesPage.pageInfo.hasNextPage || !issuesPage.pageInfo.endCursor) {
        issuesDone = true;
      } else {
        issuesCursor = issuesPage.pageInfo.endCursor;
      }
    }

    // --- refs ---
    if (!refsDone) {
      const refsPage = data.repository.refs;
      for (const node of refsPage.nodes) {
        const m = BRANCH_ISSUE_RE.exec(node.name);
        if (m) matchedBranchNumbers.push(parseInt(m[1], 10));
      }
      if (!refsPage.pageInfo.hasNextPage || !refsPage.pageInfo.endCursor) {
        refsDone = true;
      } else {
        refsCursor = refsPage.pageInfo.endCursor;
      }
    }

    // --- pullRequests ---
    if (!prsDone) {
      const prsPage = data.repository.pullRequests;
      for (const pr of prsPage.nodes) {
        const labelNames = pr.labels.nodes.map((l: { name: string }) => l.name);
        const hasReviewedLabel = labelNames.includes("reviewed") ? 1 : 0;
        const closingRefs = pr.closingIssuesReferences?.nodes ?? [];
        const closingIssueKeys = closingRefs.map(
          (ref: { number: number; repository: { nameWithOwner: string } }) =>
            `${ref.repository.nameWithOwner}#${ref.number}`,
        );
        seenPrNumbers.push(pr.number);
        prUpsertStmts.push(
          db.prepare(UPSERT_PR_STATE_SQL).bind(
            repo,
            pr.number,
            pr.state.toLowerCase(),
            hasReviewedLabel,
            JSON.stringify(closingIssueKeys),
            nowIso,
          ),
        );
      }
      if (!prsPage.pageInfo.hasNextPage || !prsPage.pageInfo.endCursor) {
        prsDone = true;
      } else {
        prsCursor = prsPage.pageInfo.endCursor;
      }
    }
  }

  // Write sync_state ONCE after full loop
  await db
    .prepare(
      "INSERT OR REPLACE INTO sync_state(repo,last_cursor,last_synced_at) VALUES(?,NULL,?)",
    )
    .bind(repo, nowIso)
    .run();

  // Apply branch + PR state (deferred so all pages are fetched first).
  // Returns the count of stale open PRs closed, surfaced into the run audit.
  await applyActiveBranches(db, repo, matchedBranchNumbers);
  return applyPrState(db, repo, prUpsertStmts, seenPrNumbers);
}

// ---------------------------------------------------------------------------
// closedHopPass
// ---------------------------------------------------------------------------

interface StubIssueData {
  repository: {
    issue: {
      number: number;
      title: string;
      state: string;
      url: string;
      createdAt: string;
      updatedAt: string;
      closedAt: string | null;
    } | null;
  };
  rateLimit: { cost: number; remaining: number; resetAt: string };
}

/**
 * Find edge endpoints missing from issues, stub-fetch them.
 * Catches ANY GraphQLError → log as orphan + continue (matches Python behaviour).
 */
export async function closedHopPass(
  db: D1Database,
  resolveToken: (owner: string, name: string) => Promise<string>,
  sealedKeys: ReadonlySet<string> = new Set(),
): Promise<number> {
  const missingRows = await db
    .prepare(
      `SELECT DISTINCT k FROM (
         SELECT src_key AS k FROM edges
         UNION SELECT dst_key AS k FROM edges
       ) WHERE k NOT IN (SELECT key FROM issues)`,
    )
    .all<{ k: string }>();

  const keys = (missingRows.results ?? []).map((r) => r.k);
  let inserted = 0;
  const stubStmts: D1PreparedStatement[] = [];

  for (const key of keys) {
    const lastHash = key.lastIndexOf("#");
    if (lastHash < 0) continue;
    const ownerRepo = key.slice(0, lastHash);
    const numberStr = key.slice(lastHash + 1);
    if (!ownerRepo || !/^\d+$/.test(numberStr)) continue;

    const slashIdx = ownerRepo.indexOf("/");
    if (slashIdx < 0) continue;
    const owner = ownerRepo.slice(0, slashIdx);
    const name = ownerRepo.slice(slashIdx + 1);

    let token: string;
    try {
      token = await resolveToken(owner, name);
    } catch {
      console.log(`[sync] no token for closed-hop ${key}`);
      continue;
    }

    let response: { data: StubIssueData } & Record<string, unknown>;
    try {
      response = await ghGraphql<StubIssueData>(
        STUB_ISSUE_QUERY,
        { owner, name, number: parseInt(numberStr, 10) },
        token,
      );
    } catch (err) {
      // ANY GraphQLError = orphan (match Python — do NOT rethrow auth here)
      if (err instanceof GraphQLError) {
        console.log(`[sync] orphan reference: ${key}`);
        continue;
      }
      throw err;
    }

    const rl = response.data.rateLimit;
    console.log(`[sync] stub ${key} cost=${rl.cost} remaining=${rl.remaining}`);

    const node = response.data.repository.issue;
    if (node === null) {
      console.log(`[sync] orphan reference: ${key}`);
      continue;
    }

    stubStmts.push(
      db.prepare(UPSERT_ISSUE_SQL).bind(
        key,
        ownerRepo,
        node.number,
        d1PayloadTitle(node.title, key, sealedKeys),
        node.state.toLowerCase(),
        node.url,
        node.createdAt,
        node.updatedAt,
        node.closedAt ?? null,
        null, // milestone
        1, // is_stub
        null, // lane
        null, // priority
        null, // size
        null, // status
        0, // has_active_branch
      ),
    );
    inserted++;
  }

  await batchChunked(db, stubStmts);
  return inserted;
}

// ---------------------------------------------------------------------------
// runSync — main entry point
// ---------------------------------------------------------------------------

/**
 * Org-wide sync: check halt → acquire lock → enumerate repos → two-pass issue
 * sync → branch/PR sync → closed-hop pass → release lock.
 */
/** Outcome of a single runSync invocation, recorded in the R2 audit summary. */
export type RunOutcome = "success" | "empty" | "halted" | "auth_error" | "error";

/**
 * Write a compact per-run audit summary to the R2 `LOGS` bucket (#120).
 * Best-effort: no-op when LOGS is unbound, and never throws into runSync — a
 * failed audit must not fail the sync. Free-plan alternative to Logpush→R2.
 */
/** Correction counters surfaced by a single reconcile run (#80). */
export interface RunCorrections {
  /** Open PRs in D1 closed because GitHub no longer reports them open. */
  stalePrsClosed: number;
  /** Repos whose rows were pruned (no longer accessible via any installation). */
  staleReposPruned: number;
  /** tenant_repo_access rows deleted (repo dropped from an installation). */
  staleTenantReposRemoved: number;
}

/** Input to writeRunAudit. New fields are optional → callers may omit them. */
export interface RunAuditInfo {
  outcome: RunOutcome;
  stubs: number;
  durationMs: number;
  /** Table COUNT(*) snapshot taken at the start of the run (enables net deltas). */
  before?: { issues: number; edges: number; prs: number };
  reposSynced?: number;
  reposSkipped?: number;
  corrections?: RunCorrections;
}

export async function writeRunAudit(
  env: Env,
  db: D1Database,
  info: RunAuditInfo,
): Promise<void> {
  try {
    const [issues, edges, prs, wm, ctrl] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS c FROM issues").first<{ c: number }>(),
      db.prepare("SELECT COUNT(*) AS c FROM edges").first<{ c: number }>(),
      db.prepare("SELECT COUNT(*) AS c FROM pr_state").first<{ c: number }>(),
      db
        .prepare("SELECT MAX(last_synced_at) AS w FROM sync_state")
        .first<{ w: string | null }>(),
      db
        .prepare(
          "SELECT key, value FROM sync_control WHERE key IN ('halted','auth_failures') AND tenant_id = 0",
        )
        .all<{ key: string; value: string }>(),
    ]);
    const ctrlMap = new Map(
      (ctrl.results ?? []).map((r) => [r.key, r.value] as const),
    );
    const ts = new Date().toISOString();

    const after = {
      issues: issues?.c ?? 0,
      edges: edges?.c ?? 0,
      prs: prs?.c ?? 0,
    };
    // No before-snapshot → report zero deltas (don't fabricate churn).
    const before = info.before ?? after;
    const corrections: RunCorrections = info.corrections ?? {
      stalePrsClosed: 0,
      staleReposPruned: 0,
      staleTenantReposRemoved: 0,
    };
    const reposSynced = info.reposSynced ?? 0;
    const reposSkipped = info.reposSkipped ?? 0;
    // Net delta per table — the meaningful "what changed this run" signal.
    // (flushEdges always wipes+rewrites, so raw insert/delete row counts are
    // churn noise; the after-before net is the real correction.)
    const deltas = {
      issues: after.issues - before.issues,
      edges: after.edges - before.edges,
      prs: after.prs - before.prs,
    };

    const summary = {
      ts,
      outcome: info.outcome,
      durationMs: info.durationMs,
      stubs: info.stubs,
      // after-run snapshot (kept top-level for backward compatibility)
      issues: after.issues,
      edges: after.edges,
      prs: after.prs,
      watermark: wm?.w ?? null,
      halted: ctrlMap.get("halted") === "1",
      authFailures: Number(ctrlMap.get("auth_failures") ?? 0),
      // #80 — durable trace of what this reconcile run corrected
      reposSynced,
      reposSkipped,
      deltas,
      corrections: {
        stubsCreated: info.stubs,
        stalePrsClosed: corrections.stalePrsClosed,
        staleReposPruned: corrections.staleReposPruned,
        staleTenantReposRemoved: corrections.staleTenantReposRemoved,
      },
    };

    // Human-readable one-liner for Workers Logs (~3-day retention on Free) —
    // logged even when R2 is unbound so the cadence is always observable.
    const d = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    console.log(
      `[sync] reconcile: repos=${reposSynced}/${reposSynced + reposSkipped} ` +
        `issuesΔ${d(deltas.issues)} edgesΔ${d(deltas.edges)} prsΔ${d(deltas.prs)} ` +
        `stubs=${info.stubs} prs-closed=${corrections.stalePrsClosed} ` +
        `pruned=${corrections.staleReposPruned} tenant-repos-removed=${corrections.staleTenantReposRemoved}`,
    );

    const bucket = env.LOGS;
    if (!bucket) return;
    const key = `runs/${ts.slice(0, 10)}/${ts}.json`;
    await bucket.put(key, JSON.stringify(summary), {
      httpMetadata: { contentType: "application/json" },
    });
    console.log(`[sync] audit written → ${key} (${info.outcome})`);
  } catch (err) {
    console.error("[sync] audit write failed (non-fatal):", err);
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — per-tenant discovery
// ---------------------------------------------------------------------------

/**
 * Discover repos accessible to each installed tenant and build the global
 * dedup map used by Phase 2 fan-out.
 *
 * For each tenant with an installation_id:
 *   1. Seed sync_control rows (INSERT OR IGNORE) so acquireSyncLock can UPDATE.
 *   2. Attempt acquireSyncLock(db, tenantId) as a within-tick skip-guard.
 *   3. Under try/finally call getInstallationToken → listInstallationRepos.
 *   4. Upsert tenant_repo_access; delete stale rows.
 *   5. Accumulate Map<repo, Array<{tenantId, installationId}>> sorted by tenantId
 *      (lowest = owning; used for token fallback in Phase 2).
 */
export interface TenantDiscovery {
  repoMap: Map<string, Array<{ tenantId: number; installationId: number }>>;
  staleTenantReposRemoved: number;
  /** Repos the installation reports as archived — drives the repos.archived flag (#160 fallout). */
  archivedRepos: Set<string>;
}

export async function discoverTenants(
  db: D1Database,
  env: Env,
): Promise<TenantDiscovery> {
  const repoMap = new Map<string, Array<{ tenantId: number; installationId: number }>>();
  const archivedRepos = new Set<string>();
  let staleTenantReposRemoved = 0;

  const tenantRows = await db
    .prepare(`SELECT id, installation_id FROM tenants WHERE installation_id IS NOT NULL ORDER BY id ASC`)
    .all<{ id: number; installation_id: number }>();

  for (const tenant of tenantRows.results ?? []) {
    const tenantId = tenant.id;
    const installationId = tenant.installation_id;

    // Seed sync_control rows so acquireSyncLock UPDATE has a row to match.
    const seedStmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (?, 'sync_running', '0', ?)`,
        )
        .bind(tenantId, new Date().toISOString()),
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (?, 'auth_failures', '0', ?)`,
        )
        .bind(tenantId, new Date().toISOString()),
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (?, 'halted', '0', ?)`,
        )
        .bind(tenantId, new Date().toISOString()),
    ];
    await batchChunked(db, seedStmts);

    const got = await acquireSyncLock(db, tenantId);
    if (!got) {
      console.log(`[sync] tenant ${tenantId} lock held — skipping discovery`);
      continue;
    }

    try {
      let repos: Array<{ repo: string; isPrivate: boolean; isArchived?: boolean }>;
      try {
        const token = await getInstallationToken(db, env, tenantId, installationId);
        repos = await listInstallationRepos(token);
      } catch (err) {
        console.error(`[sync] tenant ${tenantId} discovery failed:`, err);
        await incrementAuthFailures(db, tenantId);
        continue;
      }

      // Upsert accessible repos into tenant_repo_access (sets is_private on every sync
      // so public repos converge to is_private=0; DEFAULT 1 = fail-closed for new rows).
      if (repos.length > 0) {
        const upsertStmts = repos.map((r) =>
          db
            .prepare(
              `INSERT INTO tenant_repo_access (tenant_id, repo, is_private) VALUES (?, ?, ?)
               ON CONFLICT(tenant_id, repo) DO UPDATE SET is_private = excluded.is_private`,
            )
            .bind(tenantId, r.repo, r.isPrivate ? 1 : 0),
        );
        await batchChunked(db, upsertStmts);
      }

      // Delete stale rows: repos no longer returned by the installation.
      const repoSet = new Set(repos.map((r) => r.repo));
      const existing = await db
        .prepare(`SELECT repo FROM tenant_repo_access WHERE tenant_id = ?`)
        .bind(tenantId)
        .all<{ repo: string }>();
      const stale = (existing.results ?? []).map((r) => r.repo).filter((r) => !repoSet.has(r));
      if (stale.length > 0) {
        const deleteStmts = stale.map((repo) =>
          db
            .prepare(`DELETE FROM tenant_repo_access WHERE tenant_id = ? AND repo = ?`)
            .bind(tenantId, repo),
        );
        await batchChunked(db, deleteStmts);
        staleTenantReposRemoved += stale.length;
        console.log(`[sync] tenant ${tenantId} removed ${stale.length} stale repo(s)`);
      }

      // Merge into global map (sorted ascending by tenantId — maintained by ORDER BY above).
      for (const { repo, isArchived } of repos) {
        const entry = repoMap.get(repo);
        if (entry) {
          entry.push({ tenantId, installationId });
        } else {
          repoMap.set(repo, [{ tenantId, installationId }]);
        }
        if (isArchived) archivedRepos.add(repo);
      }
      console.log(`[sync] tenant ${tenantId} discovered ${repos.length} repo(s)`);
    } finally {
      await releaseSyncLock(db, tenantId);
    }
  }

  return { repoMap, staleTenantReposRemoved, archivedRepos };
}

export async function runSync(env: Env): Promise<void> {
  const db = env.DB;

  if (await isHalted(db)) {
    console.log("[sync] halted — skipping");
    return;
  }

  if (!(await acquireSyncLock(db))) {
    console.log("[sync] lock held by another invocation — skipping");
    return;
  }

  // Audit tracking (#120) — recorded to R2 in the finally block.
  const t0 = Date.now();
  let outcome: RunOutcome = "error";
  let stubsCount = 0;
  // #80 — reconcile observability: before-snapshot (for net deltas) + correction counters.
  let before = { issues: 0, edges: 0, prs: 0 };
  let staleReposPruned = 0;
  let stalePrsClosed = 0;
  let staleTenantReposRemoved = 0;
  let reposSynced = 0;
  let reposSkipped = 0;

  try {
    const startedAt = new Date().toISOString();
    await db
      .prepare(
        `UPDATE sync_control SET value=?, updated_at=? WHERE key='sync_started_at' AND tenant_id = 0`,
      )
      .bind(startedAt, startedAt)
      .run();

    // Capture table sizes before the run so the audit records true net deltas (#80).
    const [bIssues, bEdges, bPrs] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS c FROM issues").first<{ c: number }>(),
      db.prepare("SELECT COUNT(*) AS c FROM edges").first<{ c: number }>(),
      db.prepare("SELECT COUNT(*) AS c FROM pr_state").first<{ c: number }>(),
    ]);
    before = { issues: bIssues?.c ?? 0, edges: bEdges?.c ?? 0, prs: bPrs?.c ?? 0 };

    // Phase 1 — per-tenant discovery: build Map<repo, [{tenantId,installationId}]>.
    const {
      repoMap: repoTenantMap,
      staleTenantReposRemoved: tenantStale,
      archivedRepos,
    } = await discoverTenants(db, env);
    staleTenantReposRemoved = tenantStale;

    // Union of all repos accessible across all tenants.
    const allRepos = [...repoTenantMap.keys()].sort();

    if (allRepos.length === 0) {
      console.warn("[sync] no repos discovered across all installations — nothing to sync");
      outcome = "empty";
      return;
    }

    if (allRepos.length > WINDOW * NUM_SLOTS)
      console.warn(`[sync] ${allRepos.length} repos exceed window capacity ${WINDOW * NUM_SLOTS} — repos beyond index ${WINDOW * NUM_SLOTS} are not synced this cycle`);

    // Upsert repos table from the union. archived is sourced from the installation
    // repo list (#160 fallout fix): listInstallationRepos now carries isArchived,
    // so archived repos converge to archived=1 and the repo dropdown re-separates them.
    const repoUpsertStmts = allRepos.map((repo) =>
      db
        .prepare(
          `INSERT INTO repos (repo, archived) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET archived=excluded.archived`,
        )
        .bind(repo, archivedRepos.has(repo) ? 1 : 0),
    );
    await batchChunked(db, repoUpsertStmts);
    console.log(`[sync] upserted ${allRepos.length} repo(s) from tenant discovery`);

    // Prune: delete data for repos absent from the union.
    // SAFETY GUARD: skip prune if union is empty (already handled above, but be explicit).
    const knownRepos = new Set(allRepos);
    const CHUNK = 90;

    const [issueRepos, edgeSrcRepos, edgeDstRepos, prStateRepos, syncStateRepos] =
      await Promise.all([
        db.prepare("SELECT DISTINCT repo FROM issues").all<{ repo: string }>(),
        db.prepare("SELECT DISTINCT substr(src_key, 1, instr(src_key,'#')-1) AS repo FROM edges").all<{ repo: string }>(),
        db.prepare("SELECT DISTINCT substr(dst_key, 1, instr(dst_key,'#')-1) AS repo FROM edges").all<{ repo: string }>(),
        db.prepare("SELECT DISTINCT repo FROM pr_state").all<{ repo: string }>(),
        db.prepare("SELECT repo FROM sync_state").all<{ repo: string }>(),
      ]);

    const staleIssueRepos = (issueRepos.results ?? []).map((r) => r.repo).filter((r) => !knownRepos.has(r));
    const staleEdgeRepos = [
      ...(edgeSrcRepos.results ?? []).map((r) => r.repo),
      ...(edgeDstRepos.results ?? []).map((r) => r.repo),
    ].filter((r) => !knownRepos.has(r));
    const stalePrStateRepos = (prStateRepos.results ?? []).map((r) => r.repo).filter((r) => !knownRepos.has(r));
    const staleSyncStateRepos = (syncStateRepos.results ?? []).map((r) => r.repo).filter((r) => !knownRepos.has(r));

    const pruneStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < staleIssueRepos.length; i += CHUNK) {
      for (const repo of staleIssueRepos.slice(i, i + CHUNK)) {
        pruneStmts.push(db.prepare("DELETE FROM issues WHERE repo=?").bind(repo));
      }
    }
    const staleEdgeReposUniq = [...new Set(staleEdgeRepos)];
    for (let i = 0; i < staleEdgeReposUniq.length; i += CHUNK) {
      for (const repo of staleEdgeReposUniq.slice(i, i + CHUNK)) {
        pruneStmts.push(
          db
            .prepare(
              "DELETE FROM edges WHERE substr(src_key,1,instr(src_key,'#')-1)=? OR substr(dst_key,1,instr(dst_key,'#')-1)=?",
            )
            .bind(repo, repo),
        );
      }
    }
    for (let i = 0; i < stalePrStateRepos.length; i += CHUNK) {
      for (const repo of stalePrStateRepos.slice(i, i + CHUNK)) {
        pruneStmts.push(db.prepare("DELETE FROM pr_state WHERE repo=?").bind(repo));
      }
    }
    for (let i = 0; i < staleSyncStateRepos.length; i += CHUNK) {
      for (const repo of staleSyncStateRepos.slice(i, i + CHUNK)) {
        pruneStmts.push(db.prepare("DELETE FROM sync_state WHERE repo=?").bind(repo));
      }
    }

    if (pruneStmts.length > 0) {
      await batchChunked(db, pruneStmts);
      staleReposPruned = new Set([
        ...staleIssueRepos,
        ...staleEdgeReposUniq,
        ...stalePrStateRepos,
        ...staleSyncStateRepos,
      ]).size;
      console.log(`[sync] pruned data for ${staleReposPruned} stale repo(s)`);
    }

    // Phase 2 — deduped windowed fan-out.
    // Read current slot (tenant_id=0).
    const slotRow = await db
      .prepare(`SELECT value FROM sync_control WHERE key='sync_slot' AND tenant_id = 0`)
      .first<{ value: string }>();
    const slot = parseInt(slotRow?.value ?? "0", 10);
    const windowStart = slot * WINDOW;
    const windowEnd = windowStart + WINDOW;
    // Windowing only engages past WINDOW repos; below that, sync everything hourly.
    const windowedRepos = allRepos.length <= WINDOW ? allRepos : allRepos.slice(windowStart, windowEnd);

    console.log(
      `[sync] slot=${slot} window=[${windowStart},${windowEnd}) repos=${windowedRepos.length}/${allRepos.length}`,
    );

    // Per-repo token resolver: try owning tenant first, fall back down list.
    const makeRepoResolver = (repoTenants: Array<{ tenantId: number; installationId: number }>) =>
      async (): Promise<string> => {
        for (const { tenantId, installationId } of repoTenants) {
          try {
            return await getInstallationToken(db, env, tenantId, installationId);
          } catch (err) {
            console.error(`[sync] token fallback: tenant ${tenantId} failed:`, err);
            await incrementAuthFailures(db, tenantId);
          }
        }
        throw new Error("all tenants failed to provide a token");
      };

    // Pass 1: bundled issues + refs + PRs per repo in window.
    const sealedKeys = await loadZkSealedIssueKeys(db);
    const collectedEdges = new Map<string, EdgeData>();
    let skippedCount = 0;
    for (const repo of windowedRepos) {
      const slash = repo.indexOf("/");
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);
      const repoTenants = repoTenantMap.get(repo)!;
      const resolveToken = makeRepoResolver(repoTenants);
      try {
        const token = await resolveToken();
        // Daily cron = full reconcile (#80): fullSync forces a complete re-fetch
        // (since=null) so deps-only edge changes are healed regardless of updatedAt.
        stalePrsClosed += await syncRepoBundle(
          db,
          token,
          owner,
          name,
          collectedEdges,
          true,
          sealedKeys,
        );
      } catch (err) {
        console.error(`[sync] skipping ${repo}:`, err);
        skippedCount++;
      }
    }
    reposSynced = windowedRepos.length - skippedCount;
    reposSkipped = skippedCount;

    // Pass 2: flush all edges (deferred to avoid cross-repo FK hazard).
    await flushEdges(db, collectedEdges);

    // Closed-hop pass with per-(owner,name) resolver.
    stubsCount = await closedHopPass(
      db,
      async (owner: string, name: string) => {
        const repo = `${owner}/${name}`;
        const repoTenants = repoTenantMap.get(repo);
        if (!repoTenants || repoTenants.length === 0) {
          throw new Error(`no tenant for ${repo}`);
        }
        return makeRepoResolver(repoTenants)();
      },
      sealedKeys,
    );
    console.log(`[sync] completed — stubs=${stubsCount}`);

    // Advance slot.
    const nextSlot = (slot + 1) % NUM_SLOTS;
    await db
      .prepare(
        `UPDATE sync_control SET value=?, updated_at=? WHERE key='sync_slot' AND tenant_id = 0`,
      )
      .bind(String(nextSlot), new Date().toISOString())
      .run();

    const systemicFailure = windowedRepos.length > 0 && skippedCount === windowedRepos.length;
    if (systemicFailure) {
      const failures = await incrementAuthFailures(db, 0);
      console.error(`[sync] all ${windowedRepos.length} windowed repo(s) failed — systemic auth failure ${failures}/2`);
      outcome = failures >= 2 ? "halted" : "auth_error";
      if (failures >= 2) {
        await haltSync(db, 0);
        console.error("[sync] HALTED: systemic token failure across all repos");
        const notifyUrl = env.NOTIFY_URL;
        if (notifyUrl) {
          await fetch(notifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "sync_halted", ts: new Date().toISOString() }),
          }).catch(() => {});
        }
      }
    }

    if (!systemicFailure) {
      const tenantIds = new Set<number>();
      for (const list of repoTenantMap.values()) for (const e of list) tenantIds.add(e.tenantId);
      await resetAuthFailures(db, 0);
      for (const id of tenantIds) await resetAuthFailures(db, id);
      outcome = "success";
    }
  } catch (err) {
    outcome = "error";
    console.error("[sync] error:", err);
  } finally {
    await releaseSyncLock(db);
    await writeRunAudit(env, db, {
      outcome,
      stubs: stubsCount,
      durationMs: Date.now() - t0,
      before,
      reposSynced,
      reposSkipped,
      corrections: {
        stalePrsClosed,
        staleReposPruned,
        staleTenantReposRemoved,
      },
    });
  }
}
