/**
 * Bundled per-repo sync (issues + refs + PRs in one subrequest) for the corpus
 * sync engine — the primary fetch path used by runSync. Split out of sync.ts
 * (file-length gate).
 */

import { MAX_PAGES } from "./constants";
import { batchChunked } from "./control";
import { ghGraphql } from "./graphql";
import {
  BRANCH_ISSUE_RE,
  type EdgeData,
  canonicalKey,
  collectEdges,
  extractFromLabels,
} from "./label-vocab";
import { pickRepoBundleQuery } from "./queries";
import { applyActiveBranches } from "./repo-branches";
import type { IssueNodeFull } from "./repo-issues";
import { type PRNode, UPSERT_PR_STATE_SQL, applyPrState } from "./repo-prs";
import { prepareIssueUpsert } from "./upsert";

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
  structureOnly = false,
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

    const response: { data: BundleData } & Record<string, unknown> = await ghGraphql<BundleData>(
      pickRepoBundleQuery(structureOnly),
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
    console.log(`[sync] bundle ${repo} p${pages + 1} cost=${rl.cost} remaining=${rl.remaining}`);
    pages++;

    // --- issues ---
    if (!issuesDone) {
      const issuesPage = data.repository.issues;
      const pageStmts: D1PreparedStatement[] = [];

      for (const node of issuesPage.nodes) {
        const key = canonicalKey(node.number, repo);
        const labels = node.labels.nodes.map((l: { name: string }) => l.name);
        const derived = extractFromLabels(labels);
        const assignees = (node.assignees?.nodes ?? []).map((a) => a.login);

        pageStmts.push(
          prepareIssueUpsert(db, structureOnly, sealedKeys, {
            key,
            repo,
            number: node.number,
            title: node.title,
            state: node.state,
            url: node.url,
            createdAt: node.createdAt,
            updatedAt: node.updatedAt,
            closedAt: node.closedAt ?? null,
            milestone: node.milestone?.title ?? null,
            isStub: 0,
            lane: derived.lane,
            priority: derived.priority,
            size: derived.size,
            assignees,
          }),
        );
        pageStmts.push(db.prepare("DELETE FROM labels WHERE issue_key=?").bind(key));
        for (const lbl of labels) {
          pageStmts.push(db.prepare("INSERT OR IGNORE INTO labels VALUES (?,?)").bind(key, lbl));
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
        if (m) matchedBranchNumbers.push(Number.parseInt(m[1], 10));
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
          db
            .prepare(UPSERT_PR_STATE_SQL)
            .bind(
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
    .prepare("INSERT OR REPLACE INTO sync_state(repo,last_cursor,last_synced_at) VALUES(?,NULL,?)")
    .bind(repo, nowIso)
    .run();

  // Apply branch + PR state (deferred so all pages are fetched first).
  // Returns the count of stale open PRs closed, surfaced into the run audit.
  await applyActiveBranches(db, repo, matchedBranchNumbers);
  return applyPrState(db, repo, prUpsertStmts, seenPrNumbers);
}
