/**
 * Repo window selection for runSync — cron slot rotation vs bootstrap unsynced pass.
 */

import { BOOTSTRAP_WINDOW, WINDOW } from "./constants";
import { ensureGlobalSyncControlSeeded } from "./control";

const BOOTSTRAP_CURSOR_KEY = "bootstrap_cursor";

export interface RunSyncOptions {
  /** Bootstrap: sync only repos missing sync_state (up to WINDOW), skip slot rotation. */
  prioritizeUnsynced?: boolean;
}

/** Union of repos granted across all active tenant installations. */
export async function listAccessibleRepos(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare("SELECT DISTINCT repo FROM tenant_repo_access ORDER BY repo")
    .all<{ repo: string }>();
  return (rows.results ?? []).map((r) => r.repo);
}

export async function listUnsyncedRepos(db: D1Database, allRepos: string[]): Promise<string[]> {
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

export async function selectWindowedRepos(
  db: D1Database,
  allRepos: string[],
  opts?: RunSyncOptions,
): Promise<{ windowedRepos: string[]; slot: number; empty: boolean }> {
  if (opts?.prioritizeUnsynced) {
    const unsynced = await listUnsyncedRepos(db, allRepos);
    if (unsynced.length === 0) {
      return { windowedRepos: [], slot: 0, empty: true };
    }
    // Round-robin: BOOTSTRAP_WINDOW=1 used to always retry unsynced[0] (e.g. a deleted
    // repo that GraphQL rejects), so the other unsynced repos were never attempted.
    await ensureGlobalSyncControlSeeded(db);
    const cursorRow = await db
      .prepare("SELECT value FROM sync_control WHERE key = ? AND tenant_id = 0")
      .bind(BOOTSTRAP_CURSOR_KEY)
      .first<{ value: string }>();
    const cursor = Number.parseInt(cursorRow?.value ?? "0", 10) % unsynced.length;
    const windowedRepos = unsynced.slice(cursor, cursor + BOOTSTRAP_WINDOW);
    const nextCursor = (cursor + BOOTSTRAP_WINDOW) % unsynced.length;
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO sync_control (tenant_id, key, value, updated_at)
         VALUES (0, ?, ?, ?)
         ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(BOOTSTRAP_CURSOR_KEY, String(nextCursor), now)
      .run();
    console.log(
      `[sync] bootstrap unsynced=${unsynced.length} cursor=${cursor} syncing=${windowedRepos.join(",")}`,
    );
    return { windowedRepos, slot: 0, empty: false };
  }

  const slotRow = await db
    .prepare(`SELECT value FROM sync_control WHERE key='sync_slot' AND tenant_id = 0`)
    .first<{ value: string }>();
  const slot = Number.parseInt(slotRow?.value ?? "0", 10);
  const windowStart = slot * WINDOW;
  const windowEnd = windowStart + WINDOW;
  const windowedRepos =
    allRepos.length <= WINDOW ? allRepos : allRepos.slice(windowStart, windowEnd);
  console.log(
    `[sync] slot=${slot} window=[${windowStart},${windowEnd}) repos=${windowedRepos.length}/${allRepos.length}`,
  );
  return { windowedRepos, slot, empty: false };
}
