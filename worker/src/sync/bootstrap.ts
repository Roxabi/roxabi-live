/**
 * Bootstrap corpus sync after a fresh install or DB wipe.
 *
 * Schedules runSync in the background (waitUntil) when the corpus is empty.
 * With ZK_ACCOUNT_KEY on, requires a zk_key_backups row for the session user.
 * Idempotent: skips when issues exist, sync is halted, or a bootstrap ran recently.
 */

import type { Env } from "../types";
import { releaseSyncLock } from "./control";
import { ensureGlobalSyncControlSeeded, isHalted, runSync } from "./sync";

const BOOTSTRAP_KEY = "bootstrap_at";
/** Debounce rapid /api/sync/status polls from scheduling duplicate chains. */
const BOOTSTRAP_SCHEDULE_DEBOUNCE_MS = 10_000;
/** Must match acquireSyncLock stale-steal threshold in control.ts (900 s). */
const SYNC_LOCK_STALE_MS = 900_000;

export interface SyncStatus {
  issue_count: number;
  sync_running: boolean;
  /** @deprecated Use sync_in_progress — kept for older clients. */
  initial_sync: boolean;
  repos_total: number;
  repos_synced: number;
  sync_in_progress: boolean;
}

/** When ZK_ACCOUNT_KEY is on, bootstrap waits until the session user has a backup row. */
export interface BootstrapSyncContext {
  userId?: number;
  zkAccountKeyEnabled?: boolean;
}

export async function isUserZkEnrolled(db: D1Database, userId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM zk_key_backups WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ ok: number }>();
  return row != null;
}

async function isBootstrapAllowed(
  db: D1Database,
  syncCtx?: BootstrapSyncContext,
): Promise<boolean> {
  if (!syncCtx?.zkAccountKeyEnabled) return true;
  if (syncCtx.userId == null) return false;
  return isUserZkEnrolled(db, syncCtx.userId);
}

export async function getIssueCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function isGlobalSyncRunning(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT value, updated_at FROM sync_control WHERE key = 'sync_running' AND tenant_id = 0`,
    )
    .first<{ value: string; updated_at: string }>();
  if (row?.value !== "1") return false;
  const updatedAt = Date.parse(row.updated_at);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > SYNC_LOCK_STALE_MS) {
    await releaseSyncLock(db);
    return false;
  }
  return true;
}

/** Repos registered vs repos with a completed bundle sync (sync_state watermark). */
export async function getRepoSyncProgress(
  db: D1Database,
): Promise<{ repos_total: number; repos_synced: number }> {
  const totalRow = await db.prepare("SELECT COUNT(*) AS n FROM repos").first<{ n: number }>();
  const syncedRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM sync_state s
       INNER JOIN repos r ON r.repo = s.repo
       WHERE s.last_synced_at IS NOT NULL AND TRIM(s.last_synced_at) != ''`,
    )
    .first<{ n: number }>();
  return {
    repos_total: totalRow?.n ?? 0,
    repos_synced: syncedRow?.n ?? 0,
  };
}

export async function isBootstrapComplete(db: D1Database): Promise<boolean> {
  const { repos_total, repos_synced } = await getRepoSyncProgress(db);
  if (repos_total === 0) return false;
  return repos_synced >= repos_total;
}

/**
 * One bootstrap pass per waitUntil — runSync advances one WINDOW slot each call.
 * GET /api/sync/status polls reschedule the next pass until every repo has sync_state.
 * (Chaining multiple runSync calls in one waitUntil hit Worker CPU limits ~26/39 repos.)
 */
export async function runBootstrapSync(env: Env): Promise<void> {
  const db = env.DB;
  if (await isHalted(db)) return;
  if (await isBootstrapComplete(db)) return;
  await runSync(env);
}

async function getBootstrapAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM sync_control WHERE key = ? AND tenant_id = 0")
    .bind(BOOTSTRAP_KEY)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function markBootstrapAt(db: D1Database, iso: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_control (tenant_id, key, value, updated_at)
       VALUES (0, ?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(BOOTSTRAP_KEY, iso, iso)
    .run();
}

/**
 * Schedule a background bootstrap chain while repos remain unsynced.
 * Returns true when runBootstrapSync was queued via waitUntil.
 */
export async function maybeScheduleBootstrapSync(
  db: D1Database,
  env: Env,
  ctx: ExecutionContext,
  syncCtx?: BootstrapSyncContext,
): Promise<boolean> {
  await ensureGlobalSyncControlSeeded(db);

  if (!(await isBootstrapAllowed(db, syncCtx))) return false;
  if (await isHalted(db)) return false;
  if (await isGlobalSyncRunning(db)) return false;
  if (await isBootstrapComplete(db)) return false;

  const last = await getBootstrapAt(db);
  if (last && Date.now() - Date.parse(last) < BOOTSTRAP_SCHEDULE_DEBOUNCE_MS) {
    return false;
  }

  const now = new Date().toISOString();
  await markBootstrapAt(db, now);
  ctx.waitUntil(runBootstrapSync(env));
  return true;
}

/** Read model for GET /api/sync/status and the frontend sync-progress banner. */
export async function getSyncStatus(
  db: D1Database,
  hasLinkedTenant: boolean,
  syncCtx?: BootstrapSyncContext,
): Promise<SyncStatus> {
  const issue_count = await getIssueCount(db);
  const sync_running = await isGlobalSyncRunning(db);
  const halted = await isHalted(db);
  const bootstrapAllowed = await isBootstrapAllowed(db, syncCtx);
  const bootstrapComplete = await isBootstrapComplete(db);
  const { repos_total, repos_synced } = await getRepoSyncProgress(db);
  const sync_in_progress = hasLinkedTenant && bootstrapAllowed && !halted && !bootstrapComplete;
  const initial_sync = sync_in_progress && repos_synced === 0 && !sync_running;
  return {
    issue_count,
    sync_running,
    initial_sync,
    repos_total,
    repos_synced,
    sync_in_progress,
  };
}
