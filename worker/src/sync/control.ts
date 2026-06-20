/**
 * Sync execution control for the corpus sync engine.
 *
 * Chunked D1 batch helper + sync_control sentinel helpers: lock acquire/release,
 * halt circuit-breaker, auth-failure counters, global seed. Split out of sync.ts
 * (file-length gate).
 */

/**
 * Execute D1 statements in chunks of `size` (default 900).
 * NEVER calls db.batch([]) — guards against empty array.
 */
export async function batchChunked(
  db: D1Database,
  stmts: D1PreparedStatement[],
  size = 900,
): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) {
    const chunk = stmts.slice(i, i + size);
    if (chunk.length > 0) {
      await db.batch(chunk);
    }
  }
}

// ---------------------------------------------------------------------------
// sync_control helpers
// ---------------------------------------------------------------------------

const GLOBAL_SYNC_CONTROL_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ["sync_running", "0"],
  ["halted", "0"],
  ["auth_failures", "0"],
  ["sync_started_at", ""],
  ["sync_slot", "0"],
  ["data_version", ""],
];

/**
 * Ensure tenant_id=0 sentinel rows exist. Required after a D1 data wipe while
 * d1_migrations remains applied (migration seeds are INSERT OR IGNORE one-shot).
 */
export async function ensureGlobalSyncControlSeeded(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  const stmts = GLOBAL_SYNC_CONTROL_SEEDS.map(([key, value]) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (0, ?, ?, ?)",
      )
      .bind(key, value, now),
  );
  await batchChunked(db, stmts);
}

export async function acquireSyncLock(db: D1Database, tenantId = 0): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE sync_control
       SET value = '1', updated_at = ?
       WHERE key = 'sync_running'
         AND tenant_id = ?
         AND (value = '0' OR (CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', updated_at) AS INTEGER)) > 900)`,
    )
    .bind(new Date().toISOString(), tenantId)
    .run();
  return result.meta.changes > 0;
}

export async function releaseSyncLock(db: D1Database, tenantId = 0): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_control SET value='0', updated_at=? WHERE key='sync_running' AND tenant_id = ?`,
    )
    .bind(new Date().toISOString(), tenantId)
    .run();
}

export async function isHalted(db: D1Database, tenantId = 0): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM sync_control WHERE key='halted' AND tenant_id = ?`)
    .bind(tenantId)
    .first<{ value: string }>();
  return row?.value === "1";
}

export async function getAuthFailures(db: D1Database, tenantId = 0): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM sync_control WHERE key='auth_failures' AND tenant_id = ?`)
    .bind(tenantId)
    .first<{ value: string }>();
  return Number.parseInt(row?.value ?? "0", 10);
}

export async function incrementAuthFailures(db: D1Database, tenantId = 0): Promise<number> {
  await db
    .prepare(
      `UPDATE sync_control SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT), updated_at=?
       WHERE key='auth_failures' AND tenant_id = ?`,
    )
    .bind(new Date().toISOString(), tenantId)
    .run();
  return getAuthFailures(db, tenantId);
}

export async function haltSync(db: D1Database, tenantId = 0): Promise<void> {
  await db
    .prepare(`UPDATE sync_control SET value='1', updated_at=? WHERE key='halted' AND tenant_id = ?`)
    .bind(new Date().toISOString(), tenantId)
    .run();
}

export async function resetAuthFailures(db: D1Database, tenantId = 0): Promise<void> {
  await db
    .prepare(
      `UPDATE sync_control SET value='0', updated_at=? WHERE key='auth_failures' AND tenant_id = ?`,
    )
    .bind(new Date().toISOString(), tenantId)
    .run();
}
