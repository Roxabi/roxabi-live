/**
 * Branch sync (has_active_branch) for the corpus sync engine. Split out of
 * sync.ts (file-length gate). applyActiveBranches is shared with syncRepoBundle.
 */

import { MAX_PAGES } from "./constants";
import { ghGraphql } from "./graphql";
import { BRANCH_ISSUE_RE } from "./label-vocab";
import { REFS_QUERY } from "./queries";

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
      if (m) matchedNumbers.push(Number.parseInt(m[1], 10));
    }

    pageCount++;
    const pageInfo: { hasNextPage: boolean; endCursor: string | null } =
      data.repository.refs.pageInfo;
    if (!pageInfo.hasNextPage || pageCount >= MAX_PAGES) break;
    cursor = pageInfo.endCursor;
    if (!cursor) break;
  }

  await applyActiveBranches(db, repo, matchedNumbers);
}
