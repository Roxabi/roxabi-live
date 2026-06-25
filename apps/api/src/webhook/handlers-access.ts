/**
 * GitHub App resource/access webhook handlers — repository, member, membership.
 *
 * Split out of handlers-app.ts (file-length gate). These handle events that
 * apply across tenants (repo rename/privacy cascades) or revoke cached
 * permissions (member/membership removal), as opposed to the install-lifecycle
 * handlers that remain in handlers-app.ts. Dispatched by webhookRoute in
 * handlers.ts after HMAC verification + tenant routing.
 */

import { archivedBit, isPrivateBit, repoFullName, resolveUserId } from "./handlers-app-helpers";
import { bumpDataVersion } from "./mutations";
import {
  cascadeRepoRename,
  invalidateCacheByRepo,
  invalidateCacheByUser,
  invalidateCacheByUserRepo,
  setRepoPrivacy,
  upsertRepo,
  upsertRepoAccess,
} from "./mutations-app";
import { getTenantByInstallationId } from "./tenant";

// ---------------------------------------------------------------------------
// H3 — handleRepository
// ---------------------------------------------------------------------------

/**
 * Process a GitHub `repository` webhook event.
 *
 * Actions handled:
 *   created     — register a brand-new repo in real time (#160 fallout): upsert
 *                 tenant_repo_access (visibility) + repos (dropdown/graph). Under
 *                 an "all repositories" installation GitHub does not fire
 *                 installation_repositories.added, so this is the only signal that
 *                 avoids the up-to-24h wait for the daily reconcile cron.
 *   renamed     — cascade rename across all repo-keyed tables (repos,
 *                 tenant_repo_access, issues, edges, user_repo_permission_cache).
 *   transferred — same cascade as renamed; the repo gets a new owner prefix while
 *                 the node_id remains stable (spec SC, H8).
 *   privatized  — flip is_private=1 in tenant_repo_access; invalidate cache.
 *   publicized  — flip is_private=0 in tenant_repo_access; invalidate cache.
 *
 * Only `created` is tenant-scoped (it writes a tenant_repo_access row, so it
 * resolves the tenant via installation.id). privacy changes and renames apply
 * across every tenant that registered the repo — no tenant lookup is performed.
 *
 * oldFullName derivation for renamed / transferred (in priority order):
 *   1. node_id anchor — query repos.repo_node_id (stable across renames); if the
 *      stored slug differs from payload.repository.full_name, that stored slug IS
 *      the old name. Most reliable path.
 *   2. renamed fallback — changes.repository.name.from; owner is unchanged on a
 *      pure rename so oldFullName = ${owner}/${changes.repository.name.from}.
 *   3. transferred fallback — changes.owner.from.{user|organization}.login; repo
 *      name is unchanged on a transfer so oldFullName = ${oldOwner}/${name}.
 *   If none resolves to a non-empty string distinct from fullName the cascade is
 *   skipped with a warning (cannot safely rewrite keys without the old prefix).
 */
export async function handleRepository(
  payload: Record<string, unknown>,
  db: D1Database,
): Promise<void> {
  const action = payload.action as string | undefined;
  if (
    action !== "created" &&
    action !== "renamed" &&
    action !== "transferred" &&
    action !== "privatized" &&
    action !== "publicized"
  ) {
    return;
  }

  const repoObj = (payload.repository as Record<string, unknown> | undefined) ?? {};
  const fullName = repoFullName(repoObj);
  if (!fullName) {
    console.warn(`[webhook/app] repository.${action}: missing repository.full_name`);
    return;
  }
  const nowIso = new Date().toISOString();

  // ── created ───────────────────────────────────────────────────────────────
  if (action === "created") {
    const installation = (payload.installation as Record<string, unknown> | undefined) ?? {};
    const installationId = installation.id as number | undefined;
    if (installationId == null) {
      console.warn(
        `[webhook/app] repository.created: missing installation.id for repo=${fullName}`,
      );
      return;
    }
    const tenant = await getTenantByInstallationId(db, installationId);
    if (!tenant) {
      console.warn(
        `[webhook/app] repository.created: no tenant for installation_id=${installationId} — skipping repo=${fullName}`,
      );
      return;
    }
    const nodeId = (repoObj.node_id as string | undefined) ?? null;
    await db.batch([
      upsertRepoAccess(db, tenant.id, fullName, isPrivateBit(repoObj)),
      upsertRepo(db, fullName, archivedBit(repoObj), nodeId),
      bumpDataVersion(db, nowIso),
    ]);
    console.info(`[webhook/app] repository.created: registered repo=${fullName}`);
    return;
  }

  // ── renamed / transferred ─────────────────────────────────────────────────
  if (action === "renamed" || action === "transferred") {
    const nodeId = (repoObj.node_id as string | undefined) ?? "";
    const changes = (payload.changes as Record<string, unknown> | undefined) ?? {};

    let oldFullName: string | null = null;

    // Priority 1: node_id anchor — look up the currently stored slug by node_id.
    if (nodeId) {
      const row = await db
        .prepare("SELECT repo FROM repos WHERE repo_node_id = ?")
        .bind(nodeId)
        .first<{ repo: string }>();
      if (row && row.repo !== fullName) {
        oldFullName = row.repo;
      }
    }

    // Priority 2: renamed fallback — changes.repository.name.from (owner unchanged).
    if (!oldFullName && action === "renamed") {
      const repoChanges = (changes.repository as Record<string, unknown> | undefined) ?? {};
      const nameChanges = (repoChanges.name as Record<string, unknown> | undefined) ?? {};
      const oldName = (nameChanges.from as string | undefined) ?? "";
      if (oldName) {
        const slashIdx = fullName.lastIndexOf("/");
        if (slashIdx >= 0) {
          const owner = fullName.slice(0, slashIdx);
          oldFullName = `${owner}/${oldName}`;
        }
      }
    }

    // Priority 3: transferred fallback — changes.owner.from.{user|organization}.login.
    if (!oldFullName && action === "transferred") {
      const ownerChanges = (changes.owner as Record<string, unknown> | undefined) ?? {};
      const fromBlock = (ownerChanges.from as Record<string, unknown> | undefined) ?? {};
      const userBlock = (fromBlock.user as Record<string, unknown> | undefined) ?? {};
      const orgBlock = (fromBlock.organization as Record<string, unknown> | undefined) ?? {};
      const oldOwner =
        (userBlock.login as string | undefined) ?? (orgBlock.login as string | undefined) ?? "";
      if (oldOwner) {
        const slashIdx = fullName.lastIndexOf("/");
        if (slashIdx >= 0) {
          // A transfer may also rename: prefer changes.repository.name.from; fall back to the
          // current name for a pure ownership transfer (name unchanged).
          const repoChanges = (changes.repository as Record<string, unknown> | undefined) ?? {};
          const nameChanges = (repoChanges.name as Record<string, unknown> | undefined) ?? {};
          const oldName = (nameChanges.from as string | undefined) ?? fullName.slice(slashIdx + 1);
          oldFullName = `${oldOwner}/${oldName}`;
        }
      }
    }

    if (!oldFullName || oldFullName === fullName) {
      console.warn(
        `[webhook/app] repository.${action}: could not derive oldFullName for repo=${fullName} — cascade skipped`,
      );
      return;
    }

    const renameStmts = cascadeRepoRename(db, oldFullName, fullName);
    await db.batch([...renameStmts, bumpDataVersion(db, nowIso)]);
    return;
  }

  // ── privatized / publicized ───────────────────────────────────────────────
  const isPrivate: 0 | 1 = action === "privatized" ? 1 : 0;
  await db.batch([
    setRepoPrivacy(db, fullName, isPrivate),
    invalidateCacheByRepo(db, fullName),
    bumpDataVersion(db, nowIso),
  ]);
}

// ---------------------------------------------------------------------------
// H4a — handleMember
// ---------------------------------------------------------------------------

/**
 * Process a GitHub `member` webhook event (repository-level collaborator changes).
 *
 * Actions handled:
 *   added   — cache-miss will re-verify on next request; no proactive action needed.
 *   removed — invalidate user_repo_permission_cache for (user_id, repo) if the
 *             user has a local account; otherwise silently no-op.
 *
 * Note on user_id resolution:
 *   GitHub member events carry `member.id` (the GitHub numeric user id).
 *   The local `users` table stores `github_id` (integer). We resolve via
 *   resolveUserId; if the user has never logged in, no local row exists and
 *   there is nothing to invalidate.
 */
export async function handleMember(
  payload: Record<string, unknown>,
  db: D1Database,
): Promise<void> {
  const action = payload.action as string | undefined;
  if (action !== "added" && action !== "removed") {
    return;
  }

  // `added`: the next permission check will miss cache and re-verify live.
  // No write needed — the live check will warm the cache correctly.
  if (action === "added") {
    return;
  }

  // `removed`: invalidate the specific (user, repo) pair.
  const memberObj = (payload.member as Record<string, unknown> | undefined) ?? {};
  const githubId = memberObj.id as number | undefined;
  if (githubId == null) {
    console.warn("[webhook/app] member.removed: missing member.id");
    return;
  }

  const repoObj = (payload.repository as Record<string, unknown> | undefined) ?? {};
  const repo = repoFullName(repoObj);
  if (!repo) {
    console.warn("[webhook/app] member.removed: missing repository.full_name");
    return;
  }

  const userId = await resolveUserId(db, githubId);
  if (userId === null) {
    // User has never logged in — no cache entry to invalidate.
    return;
  }

  const nowIso = new Date().toISOString();
  await db.batch([invalidateCacheByUserRepo(db, userId, repo), bumpDataVersion(db, nowIso)]);
}

// ---------------------------------------------------------------------------
// H4b — handleMembership
// ---------------------------------------------------------------------------

/**
 * Process a GitHub `membership` webhook event (org team membership changes).
 *
 * Actions handled:
 *   added   — no-op (cache miss will re-verify on next check).
 *   removed — invalidate ALL user_repo_permission_cache rows for this user.
 *             Removing someone from an org team can affect access to any
 *             number of repos — we cannot cheaply enumerate which ones, so
 *             a full-user cache wipe is the correct safe choice.
 */
export async function handleMembership(
  payload: Record<string, unknown>,
  db: D1Database,
): Promise<void> {
  const action = payload.action as string | undefined;
  if (action !== "added" && action !== "removed") {
    return;
  }

  // `added`: next check will re-verify live and warm the cache.
  if (action === "added") {
    return;
  }

  // `removed`: full-user cache wipe.
  const memberObj = (payload.member as Record<string, unknown> | undefined) ?? {};
  const githubId = memberObj.id as number | undefined;
  if (githubId == null) {
    console.warn("[webhook/app] membership.removed: missing member.id");
    return;
  }

  const userId = await resolveUserId(db, githubId);
  if (userId === null) {
    // User has never logged in — nothing to invalidate.
    return;
  }

  const nowIso = new Date().toISOString();
  await db.batch([invalidateCacheByUser(db, userId), bumpDataVersion(db, nowIso)]);
}
