/**
 * Per-run audit summary (R2 + Workers Logs) for the corpus sync engine. Split
 * out of sync.ts (file-length gate).
 */

import type { Env } from "../types";

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

export async function writeRunAudit(env: Env, db: D1Database, info: RunAuditInfo): Promise<void> {
  try {
    const [issues, edges, prs, wm, ctrl] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS c FROM issues").first<{ c: number }>(),
      db.prepare("SELECT COUNT(*) AS c FROM edges").first<{ c: number }>(),
      db.prepare("SELECT COUNT(*) AS c FROM pr_state").first<{ c: number }>(),
      db.prepare("SELECT MAX(last_synced_at) AS w FROM sync_state").first<{ w: string | null }>(),
      db
        .prepare(
          "SELECT key, value FROM sync_control WHERE key IN ('halted','auth_failures') AND tenant_id = 0",
        )
        .all<{ key: string; value: string }>(),
    ]);
    const ctrlMap = new Map((ctrl.results ?? []).map((r) => [r.key, r.value] as const));
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
