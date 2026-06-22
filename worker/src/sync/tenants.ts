/**
 * Phase 1 — per-tenant repo discovery for the corpus sync engine. Split out of
 * sync.ts (file-length gate).
 */

import { getInstallationToken, listInstallationRepos } from "../auth/installToken";
import type { Env } from "../types";
import { acquireSyncLock, batchChunked, incrementAuthFailures, releaseSyncLock } from "./control";
import { filterResolvableRepos } from "./repo-probe";

/**
 * Discover repos accessible to each installed tenant and build the global
 * dedup map used by Phase 2 fan-out.
 *
 * For each tenant with an installation_id:
 *   1. Seed sync_control rows (INSERT OR IGNORE) so acquireSyncLock can UPDATE.
 *   2. Attempt acquireSyncLock(db, tenantId) as a within-tick skip-guard.
 *   3. Under try/finally call getInstallationToken → listInstallationRepos.
 *   4. Upsert tenant_repo_access; delete stale rows.
 *   5. Accumulate Map<repo, Array<{tenantId, installationId}>> sorted by tenantId
 *      (lowest = owning; used for token fallback in Phase 2).
 */
export interface TenantDiscovery {
  repoMap: Map<string, Array<{ tenantId: number; installationId: number }>>;
  staleTenantReposRemoved: number;
  /** Repos the installation reports as archived — drives the repos.archived flag (#160 fallout). */
  archivedRepos: Set<string>;
}

export async function discoverTenants(db: D1Database, env: Env): Promise<TenantDiscovery> {
  const repoMap = new Map<string, Array<{ tenantId: number; installationId: number }>>();
  const archivedRepos = new Set<string>();
  let staleTenantReposRemoved = 0;

  const tenantRows = await db
    .prepare(
      `SELECT id, installation_id FROM tenants
       WHERE installation_id IS NOT NULL
         AND deleted_at IS NULL
         AND suspended_at IS NULL
       ORDER BY id ASC`,
    )
    .all<{ id: number; installation_id: number }>();

  for (const tenant of tenantRows.results ?? []) {
    const tenantId = tenant.id;
    const installationId = tenant.installation_id;

    // Seed sync_control rows so acquireSyncLock UPDATE has a row to match.
    const seedStmts: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (?, 'sync_running', '0', ?)`,
        )
        .bind(tenantId, new Date().toISOString()),
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (?, 'auth_failures', '0', ?)`,
        )
        .bind(tenantId, new Date().toISOString()),
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (?, 'halted', '0', ?)`,
        )
        .bind(tenantId, new Date().toISOString()),
    ];
    await batchChunked(db, seedStmts);

    const got = await acquireSyncLock(db, tenantId);
    if (!got) {
      console.log(`[sync] tenant ${tenantId} lock held — skipping discovery`);
      continue;
    }

    try {
      let repos: Array<{ repo: string; isPrivate: boolean; isArchived?: boolean }>;
      try {
        const token = await getInstallationToken(db, env, tenantId, installationId);
        const listed = await listInstallationRepos(token);
        const { kept } = await filterResolvableRepos(token, listed);
        repos = kept;
      } catch (err) {
        console.error(`[sync] tenant ${tenantId} discovery failed:`, err);
        await incrementAuthFailures(db, tenantId);
        continue;
      }

      // Upsert accessible repos into tenant_repo_access (sets is_private on every sync
      // so public repos converge to is_private=0; DEFAULT 1 = fail-closed for new rows).
      if (repos.length > 0) {
        const upsertStmts = repos.map((r) =>
          db
            .prepare(
              `INSERT INTO tenant_repo_access (tenant_id, repo, is_private) VALUES (?, ?, ?)
               ON CONFLICT(tenant_id, repo) DO UPDATE SET is_private = excluded.is_private`,
            )
            .bind(tenantId, r.repo, r.isPrivate ? 1 : 0),
        );
        await batchChunked(db, upsertStmts);
      }

      // Delete stale rows: repos no longer returned by the installation.
      const repoSet = new Set(repos.map((r) => r.repo));
      const existing = await db
        .prepare("SELECT repo FROM tenant_repo_access WHERE tenant_id = ?")
        .bind(tenantId)
        .all<{ repo: string }>();
      const stale = (existing.results ?? []).map((r) => r.repo).filter((r) => !repoSet.has(r));
      if (stale.length > 0) {
        const deleteStmts = stale.map((repo) =>
          db
            .prepare("DELETE FROM tenant_repo_access WHERE tenant_id = ? AND repo = ?")
            .bind(tenantId, repo),
        );
        await batchChunked(db, deleteStmts);
        staleTenantReposRemoved += stale.length;
        console.log(`[sync] tenant ${tenantId} removed ${stale.length} stale repo(s)`);
      }

      // Merge into global map (sorted ascending by tenantId — maintained by ORDER BY above).
      for (const { repo, isArchived } of repos) {
        const entry = repoMap.get(repo);
        if (entry) {
          entry.push({ tenantId, installationId });
        } else {
          repoMap.set(repo, [{ tenantId, installationId }]);
        }
        if (isArchived) archivedRepos.add(repo);
      }
      console.log(`[sync] tenant ${tenantId} discovered ${repos.length} repo(s)`);
    } finally {
      await releaseSyncLock(db, tenantId);
    }
  }

  return { repoMap, staleTenantReposRemoved, archivedRepos };
}
