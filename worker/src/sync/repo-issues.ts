/**
 * Per-repo issue sync (standalone ISSUES_QUERY pagination) for the corpus sync
 * engine. Split out of sync.ts (file-length gate).
 */

import { MAX_PAGES } from "./constants";
import { batchChunked } from "./control";
import { ghGraphql } from "./graphql";
import { type EdgeData, canonicalKey, collectEdges, extractFromLabels } from "./label-vocab";
import { pickIssuesQuery } from "./queries";
import { prepareIssueUpsert } from "./upsert";

export interface IssueNodeFull {
  number: number;
  title?: string;
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
  structureOnly = false,
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
      pickIssuesQuery(structureOnly),
      { owner, name, cursor, since },
      token,
    );
    const data: IssuesData = response.data;
    const rl = data.rateLimit;
    console.log(`[sync] ${repo} p${pages + 1} cost=${rl.cost} remaining=${rl.remaining}`);

    const issuesPage: IssuesData["repository"]["issues"] = data.repository.issues;
    const nodes = issuesPage.nodes;

    // Collect all D1 statements for this page into one batch
    const pageStmts: D1PreparedStatement[] = [];

    for (const node of nodes) {
      const key = canonicalKey(node.number, repo);
      const labels = node.labels.nodes.map((l: { name: string }) => l.name);
      const derived = extractFromLabels(labels);

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
        }),
      );

      // Label wipe + rewrite
      pageStmts.push(db.prepare("DELETE FROM labels WHERE issue_key=?").bind(key));
      for (const lbl of labels) {
        pageStmts.push(db.prepare("INSERT OR IGNORE INTO labels VALUES (?,?)").bind(key, lbl));
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
    .prepare("INSERT OR REPLACE INTO sync_state(repo,last_cursor,last_synced_at) VALUES(?,NULL,?)")
    .bind(repo, nowIso)
    .run();
}
