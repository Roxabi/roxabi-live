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
  REPOS_QUERY,
  STUB_ISSUE_QUERY,
} from "./queries";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_PAGES = 500;

/** Verbatim port of sync.py UPSERT_ISSUE_SQL — full sync path (sets status=null). */
export const UPSERT_ISSUE_SQL = `
  INSERT INTO issues
      (key, repo, number, title, state, url, created_at, updated_at,
       closed_at, milestone, is_stub, lane, priority, size, status,
       has_active_branch)
  VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
      repo              = excluded.repo,
      number            = excluded.number,
      title             = excluded.title,
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

export async function acquireSyncLock(db: D1Database): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sync_control
       SET value = '1', updated_at = ?
       WHERE key = 'sync_running'
         AND (value = '0' OR (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', updated_at) AS INTEGER)) > 900)`,
    )
    .bind(new Date().toISOString())
    .run();
  return result.meta.changes > 0;
}

export async function releaseSyncLock(db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE sync_control SET value='0', updated_at=? WHERE key='sync_running'`)
    .bind(new Date().toISOString())
    .run();
}

export async function isHalted(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM sync_control WHERE key='halted'`)
    .first<{ value: string }>();
  return row?.value === "1";
}

export async function getAuthFailures(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM sync_control WHERE key='auth_failures'`)
    .first<{ value: string }>();
  return parseInt(row?.value ?? "0", 10);
}

export async function incrementAuthFailures(db: D1Database): Promise<number> {
  await db
    .prepare(
      `UPDATE sync_control SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT), updated_at=?
       WHERE key='auth_failures'`,
    )
    .bind(new Date().toISOString())
    .run();
  return getAuthFailures(db);
}

export async function haltSync(db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE sync_control SET value='1', updated_at=? WHERE key='halted'`)
    .bind(new Date().toISOString())
    .run();
}

export async function resetAuthFailures(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_control SET value='0', updated_at=? WHERE key='auth_failures'`,
    )
    .bind(new Date().toISOString())
    .run();
}

// ---------------------------------------------------------------------------
// Repo allowlist
// ---------------------------------------------------------------------------

export async function getRepoAllowlist(db: D1Database): Promise<string[]> {
  const result = await db.prepare(`SELECT repo FROM repo_allowlist`).all<{ repo: string }>();
  return (result.results ?? []).map((r) => r.repo);
}

// ---------------------------------------------------------------------------
// Org repo enumeration
// ---------------------------------------------------------------------------

interface RepoNode {
  name: string;
  owner: { login: string };
  isArchived: boolean;
  isPrivate: boolean;
}
interface ReposData {
  organization: {
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: RepoNode[];
    };
  };
  rateLimit: { cost: number; remaining: number; resetAt: string };
}

export async function enumerateOrgRepos(
  org: string,
  token: string,
): Promise<Array<{ owner: string; name: string }>> {
  const repos: Array<{ owner: string; name: string }> = [];
  let cursor: string | null = null;

  while (true) {
    const response: { data: ReposData } & Record<string, unknown> = await ghGraphql<ReposData>(REPOS_QUERY, { org, cursor }, token);
    const data: ReposData = response.data;
    const rl = data.rateLimit;
    console.log(`[sync] repos cost=${rl.cost} remaining=${rl.remaining}`);

    for (const node of data.organization.repositories.nodes) {
      repos.push({ owner: node.owner.login, name: node.name });
    }

    const pageInfo: { hasNextPage: boolean; endCursor: string | null } = data.organization.repositories.pageInfo;
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    if (!cursor) break;
  }

  return repos;
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
): Promise<void> {
  const repo = `${owner}/${name}`;
  let cursor: string | null = null;
  let pages = 0;

  // Read watermark from previous sync (null on first run → full fetch)
  const syncStateRow = await db
    .prepare("SELECT last_synced_at FROM sync_state WHERE repo=?")
    .bind(repo)
    .first<{ last_synced_at: string | null }>();
  const since: string | null = syncStateRow?.last_synced_at ?? null;

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
          node.title,
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
): Promise<void> {
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
  } else {
    await db
      .prepare(`UPDATE pr_state SET state='closed' WHERE repo=? AND state='open'`)
      .bind(repo)
      .run();
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
): Promise<void> {
  const repo = `${owner}/${name}`;

  // Read watermark (null on first run → full fetch)
  const syncStateRow = await db
    .prepare("SELECT last_synced_at FROM sync_state WHERE repo=?")
    .bind(repo)
    .first<{ last_synced_at: string | null }>();
  const since: string | null = syncStateRow?.last_synced_at ?? null;

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
            node.title,
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

  // Apply branch + PR state (deferred so all pages are fetched first)
  await applyActiveBranches(db, repo, matchedBranchNumbers);
  await applyPrState(db, repo, prUpsertStmts, seenPrNumbers);
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
export async function closedHopPass(db: D1Database, token: string): Promise<number> {
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
        node.title,
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

  try {
    const startedAt = new Date().toISOString();
    await db
      .prepare(
        `UPDATE sync_control SET value=?, updated_at=? WHERE key='sync_started_at'`,
      )
      .bind(startedAt, startedAt)
      .run();

    const allowlist = await getRepoAllowlist(db);
    if (allowlist.length === 0) {
      console.warn("[sync] repo_allowlist empty — nothing to sync");
      return;
    }

    const orgRepos = await enumerateOrgRepos(env.GITHUB_ORG, env.GITHUB_TOKEN);
    const active = orgRepos.filter((r) => allowlist.includes(`${r.owner}/${r.name}`));

    // Prune stale sync_state rows for repos removed from the allowlist (faithful
    // to sync.py run_sync: diff sync_state against the active allowlist∩org set).
    const activeKeys = new Set(active.map((r) => `${r.owner}/${r.name}`));
    const syncStateRows = await db
      .prepare("SELECT repo FROM sync_state")
      .all<{ repo: string }>();
    const staleRepos = (syncStateRows.results ?? [])
      .map((r) => r.repo)
      .filter((repo) => !activeKeys.has(repo));
    if (staleRepos.length > 0) {
      await batchChunked(
        db,
        staleRepos.map((repo) =>
          db.prepare("DELETE FROM sync_state WHERE repo=?").bind(repo),
        ),
      );
      console.log(`[sync] pruned ${staleRepos.length} stale sync_state row(s)`);
    }

    // Pass 1: bundled issues + refs + PRs per repo (1 subreq/repo instead of 3)
    const collectedEdges = new Map<string, EdgeData>();
    for (const { owner, name } of active) {
      try {
        await syncRepoBundle(db, env.GITHUB_TOKEN, owner, name, collectedEdges);
      } catch (err) {
        if (err instanceof GraphQLError && err.isAuth) throw err;
        console.error(`[sync] skipping ${owner}/${name}:`, err);
      }
    }

    // Pass 2: flush all edges (deferred to avoid cross-repo FK hazard)
    await flushEdges(db, collectedEdges);

    // Closed-hop pass
    const stubs = await closedHopPass(db, env.GITHUB_TOKEN);
    console.log(`[sync] completed — stubs=${stubs}`);

    await resetAuthFailures(db);
  } catch (err) {
    const isAuth = err instanceof GraphQLError && err.isAuth;
    if (isAuth) {
      const failures = await incrementAuthFailures(db);
      console.error(`[sync] auth failure ${failures}/2`);
      if (failures >= 2) {
        await haltSync(db);
        console.error("[sync] HALTED: 2 consecutive auth failures");
        const notifyUrl = (env as { NOTIFY_URL?: string }).NOTIFY_URL;
        if (notifyUrl) {
          await fetch(notifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event: "sync_halted", ts: new Date().toISOString() }),
          }).catch(() => {});
        }
      }
    } else {
      console.error("[sync] error:", err);
    }
  } finally {
    await releaseSyncLock(db);
  }
}
