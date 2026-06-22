/**
 * Repo window selection for runSync — cron slot rotation vs bootstrap unsynced pass.
 */

import { BOOTSTRAP_WINDOW, WINDOW } from "./constants";

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
    const windowedRepos = unsynced.slice(0, BOOTSTRAP_WINDOW);
    console.log(
      `[sync] bootstrap unsynced=${unsynced.length} syncing=${windowedRepos.length}/${allRepos.length}`,
    );
    return { windowedRepos, slot: 0, empty: windowedRepos.length === 0 };
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
