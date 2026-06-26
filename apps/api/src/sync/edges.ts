/**
 * Edge flush (pass 2) + closed-hop stub backfill for the corpus sync engine.
 * Split out of sync.ts (file-length gate).
 */

import { batchChunked } from "./control";
import { GraphQLError, ghGraphql } from "./graphql";
import type { EdgeData } from "./label-vocab";
import { pickStubIssueQuery } from "./queries";
import { prepareIssueUpsert } from "./upsert";

/**
 * Write all collected edges to D1 in chunked batches.
 * Always emits 2 DELETEs per issue key (parent + blocks) even with zero edges.
 */
/** Subset of collectedEdges for issues belonging to one repo (owner/name). */
export function edgesForRepo(
  collectedEdges: Map<string, EdgeData>,
  repo: string,
): Map<string, EdgeData> {
  const prefix = `${repo}#`;
  const subset = new Map<string, EdgeData>();
  for (const [key, data] of collectedEdges) {
    if (key.startsWith(prefix)) subset.set(key, data);
  }
  return subset;
}

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
interface StubIssueData {
  repository: {
    issue: {
      number: number;
      title?: string;
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
  structureOnly = false,
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
        pickStubIssueQuery(structureOnly),
        { owner, name, number: Number.parseInt(numberStr, 10) },
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
      prepareIssueUpsert(db, structureOnly, sealedKeys, {
        key,
        repo: ownerRepo,
        number: node.number,
        title: node.title,
        state: node.state,
        url: node.url,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        closedAt: node.closedAt ?? null,
        milestone: null,
        isStub: 1,
        lane: null,
        priority: null,
        size: null,
      }),
    );
    inserted++;
  }

  await batchChunked(db, stubStmts);
  return inserted;
}
