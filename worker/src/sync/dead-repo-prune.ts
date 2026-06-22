/**
 * Drop tenant_repo_access rows for repos GitHub no longer resolves (deleted).
 * Runs on /health so a single probe can unblock bootstrap without a full sync pass.
 */

import { getInstallationToken, listInstallationRepos } from "../auth/installToken";
import type { Env } from "../types";
import { isBootstrapComplete, listUnsyncedRepos } from "./bootstrap";
import { ensureGlobalSyncControlSeeded } from "./control";
import { pruneInaccessibleRepo } from "./repo-access-prune";
import { isRepoResolvable } from "./repo-probe";

const DEAD_REPO_PRUNE_KEY = "dead_repo_prune_at";
const DEAD_REPO_PRUNE_DEBOUNCE_MS = 15_000;

/** Probe unsynced repos via GraphQL; prune those the API cannot resolve. */
export async function maybePruneDeadAccessibleRepos(env: Env): Promise<number> {
  const db = env.DB;
  if (await isBootstrapComplete(db)) return 0;

  const unsynced = await listUnsyncedRepos(db);
  if (unsynced.length === 0) return 0;

  await ensureGlobalSyncControlSeeded(db);
  const row = await db
    .prepare("SELECT value FROM sync_control WHERE key = ? AND tenant_id = 0")
    .bind(DEAD_REPO_PRUNE_KEY)
    .first<{ value: string }>();
  if (row?.value && Date.now() - Date.parse(row.value) < DEAD_REPO_PRUNE_DEBOUNCE_MS) {
    return 0;
  }

  const tenant = await db
    .prepare(
      `SELECT id, installation_id FROM tenants
       WHERE installation_id IS NOT NULL AND deleted_at IS NULL AND suspended_at IS NULL
       ORDER BY id ASC LIMIT 1`,
    )
    .first<{ id: number; installation_id: number }>();
  if (!tenant) return 0;

  let token: string;
  try {
    token = await getInstallationToken(db, env, tenant.id, tenant.installation_id);
  } catch (err) {
    console.error("[sync] dead-repo prune: no installation token:", err);
    return 0;
  }

  const listed = await listInstallationRepos(token);
  const privateByRepo = new Map(listed.map((r) => [r.repo, r.isPrivate]));

  let pruned = 0;
  for (const repo of unsynced) {
    try {
      // Installation API is authoritative — D1 may still carry fail-closed is_private=1.
      const isPrivate = privateByRepo.get(repo) ?? true;
      if (await isRepoResolvable(token, repo, { isPrivate })) continue;
      await pruneInaccessibleRepo(db, repo);
      pruned++;
    } catch (err) {
      console.error(`[sync] dead-repo probe failed for ${repo}:`, err);
    }
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO sync_control (tenant_id, key, value, updated_at)
       VALUES (0, ?, ?, ?)
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(DEAD_REPO_PRUNE_KEY, now, now)
    .run();

  if (pruned > 0) {
    console.log(`[sync] dead-repo prune removed ${pruned} repo(s)`);
  }
  return pruned;
}
