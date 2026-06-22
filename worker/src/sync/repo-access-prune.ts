/**
 * Drop repos the GitHub API can no longer resolve (deleted / transferred away).
 */

export function isInaccessibleRepoError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Could not resolve to a Repository/i.test(msg) ||
    /Repository.*(not found|does not exist)/i.test(msg) ||
    /"type":"NOT_FOUND"/i.test(msg)
  );
}

/** Remove a repo from access + registry so bootstrap progress stops counting it. */
export async function pruneInaccessibleRepo(db: D1Database, repo: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM tenant_repo_access WHERE repo = ?").bind(repo),
    db.prepare("DELETE FROM repos WHERE repo = ?").bind(repo),
    db.prepare("DELETE FROM sync_state WHERE repo = ?").bind(repo),
  ]);
  console.log(`[sync] pruned inaccessible repo ${repo}`);
}

/** @returns true when the repo was pruned (counts as handled, not skipped). */
export async function handleRepoSyncFailure(
  db: D1Database,
  repo: string,
  err: unknown,
): Promise<boolean> {
  if (!isInaccessibleRepoError(err)) {
    console.error(`[sync] skipping ${repo}:`, err);
    return false;
  }
  await pruneInaccessibleRepo(db, repo);
  console.warn(`[sync] pruned inaccessible repo ${repo}`);
  return true;
}
