/**
 * PR-state sync for the corpus sync engine. Split out of sync.ts (file-length
 * gate). applyPrState + UPSERT_PR_STATE_SQL are shared with syncRepoBundle.
 */

import { MAX_PAGES } from "./constants";
import { batchChunked } from "./control";
import { ghGraphql } from "./graphql";
import { PRS_QUERY } from "./queries";

export interface PRNode {
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
  }
  const res = await db
    .prepare(`UPDATE pr_state SET state='closed' WHERE repo=? AND state='open'`)
    .bind(repo)
    .run();
  return res.meta.changes ?? 0;
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
        (ref: { number: number; repository: { nameWithOwner: string } }) =>
          `${ref.repository.nameWithOwner}#${ref.number}`,
      );

      seenPrNumbers.push(pr.number);
      upsertStmts.push(
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

    pageCount++;
    const pageInfo: { hasNextPage: boolean; endCursor: string | null } =
      data.repository.pullRequests.pageInfo;
    if (!pageInfo.hasNextPage || pageCount >= MAX_PAGES) break;
    cursor = pageInfo.endCursor;
    if (!cursor) break;
  }

  await applyPrState(db, repo, upsertStmts, seenPrNumbers);
}
