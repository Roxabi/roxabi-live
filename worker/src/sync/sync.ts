/**
 * Corpus sync engine — orchestrator (runSync) for Cloudflare Workers D1.
 *
 * The engine was split into cohesive sibling modules under the 300-SLOC gate:
 *   constants · label-vocab · upsert · control · repo-issues · repo-branches ·
 *   repo-prs · edges · bundle · audit · tenants.
 * This file owns the runSync orchestrator and re-exports the public surface so
 * existing importers (webhook handlers, admin, bootstrap, sync.test.ts) keep
 * importing from "./sync".
 *
 * Two-pass design:
 *   Pass 1: syncRepoBundle — upsert issues + labels per repo, collect EdgeData
 *   Pass 2: flushEdges — write all edges in chunked batches (no cross-page FK hazard)
 *
 * Auth-halt circuit breaker in sync_control (auth_failures >= 2 → halted=1).
 * Advisory distributed lock via sync_control.sync_running (stale after 900 s).
 */

import { getInstallationToken } from "../auth/installToken";
import { loadZkSealedIssueKeys } from "../auth/zk";
import { zkStructureOnlyEnabled } from "../auth/zk-flags";
import type { Env } from "../types";
import { type RunOutcome, writeRunAudit } from "./audit";
import { syncRepoBundle } from "./bundle";
import { NUM_SLOTS, WINDOW } from "./constants";
import {
  acquireSyncLock,
  batchChunked,
  ensureGlobalSyncControlSeeded,
  haltSync,
  incrementAuthFailures,
  isHalted,
  releaseSyncLock,
  resetAuthFailures,
} from "./control";
import { closedHopPass, edgesForRepo, flushEdges } from "./edges";
import type { EdgeData } from "./label-vocab";
import { discoverTenants } from "./tenants";

// ---------------------------------------------------------------------------
// Public facade — re-export the split-out symbols so existing importers
// (webhook handlers, admin, bootstrap, sync.test.ts) keep importing from
// "./sync" unchanged. Transitional; direct imports may replace these later.
// ---------------------------------------------------------------------------

export { BRANCH_ISSUE_RE, canonicalKey, collectEdges, extractFromLabels } from "./label-vocab";
export type { EdgeData } from "./label-vocab";
export { UPSERT_ISSUE_SQL, UPSERT_ISSUE_SQL_STRUCTURE } from "./upsert";
export {
  acquireSyncLock,
  batchChunked,
  ensureGlobalSyncControlSeeded,
  getAuthFailures,
  haltSync,
  incrementAuthFailures,
  isHalted,
  resetAuthFailures,
} from "./control";
export { edgesForRepo, flushEdges } from "./edges";
export { syncRepoIssues } from "./repo-issues";
export { syncBranches } from "./repo-branches";
export { syncRepoBundle } from "./bundle";
export { writeRunAudit } from "./audit";

export interface RunSyncOptions {
  /** Bootstrap: sync only repos missing sync_state (up to WINDOW), skip slot rotation. */
  prioritizeUnsynced?: boolean;
}

async function listUnsyncedRepos(db: D1Database, allRepos: string[]): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT s.repo FROM sync_state s
       INNER JOIN repos r ON r.repo = s.repo
       WHERE s.last_synced_at IS NOT NULL AND TRIM(s.last_synced_at) != ''`,
    )
    .all<{ repo: string }>();
  const synced = new Set((rows.results ?? []).map((r) => r.repo));
  return allRepos.filter((r) => !synced.has(r));
}

/**
 * Org-wide sync: check halt → acquire lock → enumerate repos → two-pass issue
 * sync → branch/PR sync → closed-hop pass → release lock.
 */
export async function runSync(env: Env, opts?: RunSyncOptions): Promise<void> {
  const db = env.DB;

  await ensureGlobalSyncControlSeeded(db);

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
      console.warn(
        `[sync] ${allRepos.length} repos exceed window capacity ${WINDOW * NUM_SLOTS} — repos beyond index ${WINDOW * NUM_SLOTS} are not synced this cycle`,
      );

    // Upsert repos table from the union. archived is sourced from the installation
    // repo list (#160 fallout fix): listInstallationRepos now carries isArchived,
    // so archived repos converge to archived=1 and the repo dropdown re-separates them.
    const repoUpsertStmts = allRepos.map((repo) =>
      db
        .prepare(
          "INSERT INTO repos (repo, archived) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET archived=excluded.archived",
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
        db
          .prepare("SELECT DISTINCT substr(src_key, 1, instr(src_key,'#')-1) AS repo FROM edges")
          .all<{ repo: string }>(),
        db
          .prepare("SELECT DISTINCT substr(dst_key, 1, instr(dst_key,'#')-1) AS repo FROM edges")
          .all<{ repo: string }>(),
        db.prepare("SELECT DISTINCT repo FROM pr_state").all<{ repo: string }>(),
        db.prepare("SELECT repo FROM sync_state").all<{ repo: string }>(),
      ]);

    const staleIssueRepos = (issueRepos.results ?? [])
      .map((r) => r.repo)
      .filter((r) => !knownRepos.has(r));
    const staleEdgeRepos = [
      ...(edgeSrcRepos.results ?? []).map((r) => r.repo),
      ...(edgeDstRepos.results ?? []).map((r) => r.repo),
    ].filter((r) => !knownRepos.has(r));
    const stalePrStateRepos = (prStateRepos.results ?? [])
      .map((r) => r.repo)
      .filter((r) => !knownRepos.has(r));
    const staleSyncStateRepos = (syncStateRepos.results ?? [])
      .map((r) => r.repo)
      .filter((r) => !knownRepos.has(r));

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

    // Phase 2 — repo fan-out. Bootstrap prioritises unsynced repos so we do not
    // waste a pass re-fetching repos that already have sync_state (26/39 stall).
    let windowedRepos: string[];
    let slot = 0;
    if (opts?.prioritizeUnsynced) {
      const unsynced = await listUnsyncedRepos(db, allRepos);
      windowedRepos = unsynced.slice(0, WINDOW);
      console.log(
        `[sync] bootstrap unsynced=${unsynced.length} syncing=${windowedRepos.length}/${allRepos.length}`,
      );
      if (windowedRepos.length === 0) {
        outcome = "success";
        return;
      }
    } else {
      const slotRow = await db
        .prepare(`SELECT value FROM sync_control WHERE key='sync_slot' AND tenant_id = 0`)
        .first<{ value: string }>();
      slot = Number.parseInt(slotRow?.value ?? "0", 10);
      const windowStart = slot * WINDOW;
      const windowEnd = windowStart + WINDOW;
      // Windowing only engages past WINDOW repos; below that, sync everything hourly.
      windowedRepos = allRepos.length <= WINDOW ? allRepos : allRepos.slice(windowStart, windowEnd);
      console.log(
        `[sync] slot=${slot} window=[${windowStart},${windowEnd}) repos=${windowedRepos.length}/${allRepos.length}`,
      );
    }

    // Per-repo token resolver: try owning tenant first, fall back down list.
    const makeRepoResolver =
      (repoTenants: Array<{ tenantId: number; installationId: number }>) =>
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
    const structureOnly = zkStructureOnlyEnabled(env);
    const sealedKeys = await loadZkSealedIssueKeys(db);
    const collectedEdges = new Map<string, EdgeData>();
    let skippedCount = 0;
    for (const repo of windowedRepos) {
      const slash = repo.indexOf("/");
      const owner = repo.slice(0, slash);
      const name = repo.slice(slash + 1);
      // biome-ignore lint/style/noNonNullAssertion: windowedRepos is derived from repoTenantMap keys, so every repo is present.
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
          structureOnly,
        );
        // Flush this repo's edges immediately — sync_state advances per repo but
        // the window-level flush used to run only after all repos, so the UI saw
        // new issues without blocked-by links until the pass finished.
        await flushEdges(db, edgesForRepo(collectedEdges, repo));
      } catch (err) {
        console.error(`[sync] skipping ${repo}:`, err);
        skippedCount++;
      }
    }
    reposSynced = windowedRepos.length - skippedCount;
    reposSkipped = skippedCount;

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
      structureOnly,
    );
    console.log(`[sync] completed — stubs=${stubsCount}`);

    // Advance slot (cron rotation only — bootstrap uses prioritizeUnsynced).
    if (!opts?.prioritizeUnsynced) {
      const nextSlot = (slot + 1) % NUM_SLOTS;
      await db
        .prepare(
          `UPDATE sync_control SET value=?, updated_at=? WHERE key='sync_slot' AND tenant_id = 0`,
        )
        .bind(String(nextSlot), new Date().toISOString())
        .run();
    }

    const systemicFailure = windowedRepos.length > 0 && skippedCount === windowedRepos.length;
    if (systemicFailure) {
      const failures = await incrementAuthFailures(db, 0);
      console.error(
        `[sync] all ${windowedRepos.length} windowed repo(s) failed — systemic auth failure ${failures}/2`,
      );
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
