/**
 * Debounced GitHub installation refresh — reconciles tenant_repo_access when
 * bootstrap progress is stuck on repos removed from the App installation.
 */

import type { Env } from "../types";
import { isBootstrapComplete } from "./bootstrap";
import { ensureGlobalSyncControlSeeded } from "./control";
import { discoverTenants } from "./tenants";

const DISCOVERY_REFRESH_KEY = "discovery_refresh_at";
const DISCOVERY_REFRESH_DEBOUNCE_MS = 60_000;

/** Re-list installation repos from GitHub; returns stale rows removed from access. */
export async function maybeRefreshTenantDiscovery(env: Env): Promise<number> {
  const db = env.DB;
  if (await isBootstrapComplete(db)) return 0;

  await ensureGlobalSyncControlSeeded(db);
  const row = await db
    .prepare("SELECT value FROM sync_control WHERE key = ? AND tenant_id = 0")
    .bind(DISCOVERY_REFRESH_KEY)
    .first<{ value: string }>();
  if (row?.value && Date.now() - Date.parse(row.value) < DISCOVERY_REFRESH_DEBOUNCE_MS) {
    return 0;
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO sync_control (tenant_id, key, value, updated_at)
       VALUES (0, ?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(DISCOVERY_REFRESH_KEY, now, now)
    .run();

  const { staleTenantReposRemoved } = await discoverTenants(db, env);
  if (staleTenantReposRemoved > 0) {
    console.log(`[sync] discovery refresh pruned ${staleTenantReposRemoved} stale repo(s)`);
  }
  return staleTenantReposRemoved;
}
