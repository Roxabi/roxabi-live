/**
 * Bootstrap corpus sync after a fresh install or DB wipe.
 *
 * Schedules runSync in the background (waitUntil) when the corpus is empty.
 * Idempotent: skips when issues exist, sync is halted, or a bootstrap ran recently.
 */

import type { Env } from "../types";
import { isHalted, runSync } from "./sync";

const BOOTSTRAP_KEY = "bootstrap_at";
const BOOTSTRAP_COOLDOWN_MS = 120_000;

export interface SyncStatus {
  issue_count: number;
  sync_running: boolean;
  initial_sync: boolean;
}

export async function getIssueCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM issues")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function isGlobalSyncRunning(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT value FROM sync_control WHERE key = 'sync_running' AND tenant_id = 0`,
    )
    .first<{ value: string }>();
  return row?.value === "1";
}

async function getBootstrapAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT value FROM sync_control WHERE key = ? AND tenant_id = 0`,
    )
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
 * Schedule a background full reconcile when the corpus is empty.
 * Returns true when runSync was queued via waitUntil.
 */
export async function maybeScheduleBootstrapSync(
  db: D1Database,
  env: Env,
  ctx: ExecutionContext,
): Promise<boolean> {
  if (await getIssueCount(db) > 0) return false;
  if (await isHalted(db)) return false;
  if (await isGlobalSyncRunning(db)) return false;

  const last = await getBootstrapAt(db);
  if (last && Date.now() - Date.parse(last) < BOOTSTRAP_COOLDOWN_MS) {
    return false;
  }

  const now = new Date().toISOString();
  await markBootstrapAt(db, now);
  ctx.waitUntil(runSync(env));
  return true;
}

/** Read model for GET /api/sync/status and the frontend initial-sync overlay. */
export async function getSyncStatus(
  db: D1Database,
  hasLinkedTenant: boolean,
): Promise<SyncStatus> {
  const issue_count = await getIssueCount(db);
  const sync_running = await isGlobalSyncRunning(db);
  const halted = await isHalted(db);
  const initial_sync =
    hasLinkedTenant && issue_count === 0 && !halted;
  return { issue_count, sync_running, initial_sync };
}