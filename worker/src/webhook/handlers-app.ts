/**
 * GitHub App lifecycle webhook handlers — installation, installation_repositories,
 * repository, member, membership events.
 *
 * These handlers are dispatched by the existing webhookRoute in handlers.ts after
 * single-secret HMAC verification (GITHUB_WEBHOOK_SECRET via verifyHmac). The
 * dispatcher resolves payload.installation.id → tenants (tenant.ts) before
 * forwarding; unknown, suspended, or deleted tenants receive a 200-no-write.
 *
 * Design contract (same as handlers.ts / mutations.ts):
 *   - Handlers accept a typed-ish payload (Record<string,unknown>), db, and env.
 *   - All D1 writes use db.batch([...stmts]) for atomicity; never call .run()
 *     directly inside a handler unless it is a single isolated write before a
 *     follow-up read is needed (see handleInstallation created→repo-upsert gap).
 *   - Helpers in mutations.ts return D1PreparedStatement / D1PreparedStatement[].
 *     Handlers fold them into a single db.batch call.
 *   - Suspended / deleted tenants are NOT hard-deleted from `tenants`; the
 *     soft-delete / suspended_at pattern is used so the row stays for audit.
 *   - sync_control sentinel (tenant_id=0, Deviation D-2): ¬touched here.
 */

import type { Env } from "../types";
import {
  getTenantByInstallationId,
} from "./tenant";
import {
  bumpDataVersion,
  upsertTenant,
  softDeleteTenant,
  setTenantSuspended,
  upsertRepoAccess,
  deleteRepoAccess,
  deleteAllRepoAccessForTenant,
  setRepoPrivacy,
  upsertRepo,
  cascadeRepoRename,
  invalidateCacheByRepo,
  invalidateCacheByUserRepo,
  invalidateCacheByUser,
  deleteSessionsForTenant,
  deleteInstallTokensForTenant,
} from "./mutations";

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------

/**
 * Extract the full_name from a repository object in a webhook payload.
 * Returns an empty string when the field is absent or malformed so callers
 * can early-return on the empty-string check without additional type guards.
 */
function repoFullName(repoObj: unknown): string {
  if (!repoObj || typeof repoObj !== "object") {
    return "";
  }
  const fn = (repoObj as Record<string, unknown>)["full_name"];
  return typeof fn === "string" ? fn : "";
}

/**
 * Derive 0|1 from a boolean-ish `private` field found in GitHub repo objects.
 * Defaults to 1 (private) on ambiguous input — fail-closed for access control.
 */
function isPrivateBit(repoObj: unknown): 0 | 1 {
  if (!repoObj || typeof repoObj !== "object") {
    return 1;
  }
  const priv = (repoObj as Record<string, unknown>)["private"];
  return priv === false ? 0 : 1;
}

/**
 * Derive 0|1 from a boolean-ish `archived` field found in GitHub repo objects.
 * Defaults to 0 (live) on ambiguous input — archived only drives dropdown
 * grouping, so the safe default is "show as live" rather than fail-closed.
 */
function archivedBit(repoObj: unknown): 0 | 1 {
  if (!repoObj || typeof repoObj !== "object") {
    return 0;
  }
  const arch = (repoObj as Record<string, unknown>)["archived"];
  return arch === true ? 1 : 0;
}

/**
 * Resolve the local `users.id` for a given GitHub numeric user id.
 * Returns null when the user has no local account (never logged in) — callers
 * can skip cache invalidation safely in that case.
 */
async function resolveUserId(
  db: D1Database,
  githubId: number,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT id FROM users WHERE github_id = ?`)
    .bind(githubId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// H1 — handleInstallation
// ---------------------------------------------------------------------------

/**
 * Process a GitHub `installation` webhook event.
 *
 * Actions handled:
 *   created        — upsert tenant, seed repo access from payload.repositories[].
 *   deleted        — soft-delete tenant; purge sessions, install tokens, repo access.
 *   suspend        — set suspended_at.
 *   unsuspend      — clear suspended_at (pass null).
 *   new_permissions_accepted — no-op (no data model change needed).
 *
 * Note on `created` two-phase write:
 *   We need the tenant PK to upsert repo-access rows, but the PK is only
 *   readable after the tenant row exists.  Solution:
 *     1. Execute upsertTenant as a standalone .run() to create/update the row.
 *     2. Read the tenant back via getTenantByInstallationId.
 *     3. Batch repo-access upserts + bumpDataVersion atomically.
 *   This is a deliberate deviation from pure batch-only writes — documented here
 *   so a future reviewer does not "fix" it into a broken single-batch pattern.
 *
 * Note on `created` repos:
 *   We use payload.repositories[] (the "selected repos" list GitHub provides on
 *   install) rather than calling listInstallationRepos.  This avoids an extra
 *   API round-trip during installation and is sufficient for phase 1 — the
 *   installation_repositories event covers subsequent repo additions/removals.
 */
export async function handleInstallation(
  payload: Record<string, unknown>,
  db: D1Database,
  env: Env,
): Promise<void> {
  const action = payload["action"] as string | undefined;
  if (!action) {
    console.warn("[webhook/app] installation event missing action");
    return;
  }

  const installation = (payload["installation"] as Record<string, unknown> | undefined) ?? {};
  const installationId = installation["id"] as number | undefined;
  if (installationId == null) {
    console.warn(`[webhook/app] installation.${action}: missing installation.id`);
    return;
  }

  const account = (installation["account"] as Record<string, unknown> | undefined) ?? {};
  const accountLogin = (account["login"] as string | undefined) ?? "";
  const accountType = (account["type"] as string | undefined) ?? "Organization";
  const nowIso = new Date().toISOString();

  // ── created ───────────────────────────────────────────────────────────────
  if (action === "created") {
    // Phase 1: upsert tenant row (standalone run — we need the PK before batching).
    // Two-phase write: upsert the tenant standalone so we can read its PK below, then
    // batch the repo-access rows + bump atomically. If phase 2 fails, GitHub re-delivers
    // installation.created (ON CONFLICT re-runs idempotently) and the batch heals.
    await upsertTenant(db, {
      installation_id: installationId,
      account_login: accountLogin,
      account_type: accountType,
      nowIso,
    }).run();

    // Phase 2: read back the tenant PK.
    const tenant = await getTenantByInstallationId(db, installationId);
    if (!tenant) {
      console.error(
        `[webhook/app] installation.created: tenant not found after upsert for installation_id=${installationId}`,
      );
      return;
    }
    const tenantId = tenant.id;

    // Build repo-access upserts from payload.repositories (the install-time selection).
    const repositories = (payload["repositories"] as unknown[] | undefined) ?? [];
    const repoStmts = repositories.flatMap((r) => {
      const repo = repoFullName(r);
      if (!repo) {
        return [];
      }
      return [upsertRepoAccess(db, tenantId, repo, isPrivateBit(r))];
    });

    // Atomic: repo access + data-version bump.
    await db.batch([...repoStmts, bumpDataVersion(db, nowIso)]);
    return;
  }

  // ── deleted ───────────────────────────────────────────────────────────────
  if (action === "deleted") {
    const tenant = await getTenantByInstallationId(db, installationId);
    if (!tenant) {
      // Already gone — idempotent no-op.
      console.warn(
        `[webhook/app] installation.deleted: no tenant for installation_id=${installationId} — skipping`,
      );
      return;
    }
    const tenantId = tenant.id;

    // Soft-delete + purge access/sessions/tokens in one batch.
    await db.batch([
      softDeleteTenant(db, tenantId, nowIso),
      deleteAllRepoAccessForTenant(db, tenantId),
      deleteSessionsForTenant(db, tenantId),
      deleteInstallTokensForTenant(db, tenantId),
      bumpDataVersion(db, nowIso),
    ]);
    return;
  }

  // ── suspend ───────────────────────────────────────────────────────────────
  if (action === "suspend") {
    const tenant = await getTenantByInstallationId(db, installationId);
    if (!tenant) {
      console.warn(
        `[webhook/app] installation.suspend: no tenant for installation_id=${installationId} — skipping`,
      );
      return;
    }
    await db.batch([
      setTenantSuspended(db, tenant.id, nowIso, nowIso),
      bumpDataVersion(db, nowIso),
    ]);
    return;
  }

  // ── unsuspend ─────────────────────────────────────────────────────────────
  if (action === "unsuspend") {
    const tenant = await getTenantByInstallationId(db, installationId);
    if (!tenant) {
      console.warn(
        `[webhook/app] installation.unsuspend: no tenant for installation_id=${installationId} — skipping`,
      );
      return;
    }
    await db.batch([
      setTenantSuspended(db, tenant.id, null, nowIso),
      bumpDataVersion(db, nowIso),
    ]);
    return;
  }

  // new_permissions_accepted and any future actions — acknowledged, no writes.
  console.info(`[webhook/app] installation.${action}: no-op`);
}

// ---------------------------------------------------------------------------
// H2 — handleInstallationRepositories
// ---------------------------------------------------------------------------

/**
 * Process a GitHub `installation_repositories` webhook event.
 *
 * Actions handled:
 *   added   — upsert each repo in repositories_added[] into tenant_repo_access.
 *   removed — delete each repo in repositories_removed[] from tenant_repo_access.
 *
 * Tenant lookup uses installation.id (always present on App webhook payloads).
 * No-ops if the tenant is not found (deleted/unregistered installation).
 */
export async function handleInstallationRepositories(
  payload: Record<string, unknown>,
  db: D1Database,
  env: Env,
): Promise<void> {
  const action = payload["action"] as string | undefined;
  if (action !== "added" && action !== "removed") {
    console.info(`[webhook/app] installation_repositories.${action}: no-op`);
    return;
  }

  const installation = (payload["installation"] as Record<string, unknown> | undefined) ?? {};
  const installationId = installation["id"] as number | undefined;
  if (installationId == null) {
    console.warn(
      `[webhook/app] installation_repositories.${action}: missing installation.id`,
    );
    return;
  }

  const tenant = await getTenantByInstallationId(db, installationId);
  if (!tenant) {
    console.warn(
      `[webhook/app] installation_repositories.${action}: no tenant for installation_id=${installationId} — skipping`,
    );
    return;
  }
  const tenantId = tenant.id;
  const nowIso = new Date().toISOString();

  if (action === "added") {
    const repositories = (payload["repositories_added"] as unknown[] | undefined) ?? [];
    const stmts = repositories.flatMap((r) => {
      const repo = repoFullName(r);
      if (!repo) {
        return [];
      }
      return [upsertRepoAccess(db, tenantId, repo, isPrivateBit(r))];
    });

    if (stmts.length === 0) {
      return;
    }
    await db.batch([...stmts, bumpDataVersion(db, nowIso)]);
    return;
  }

  // removed
  const repositories = (payload["repositories_removed"] as unknown[] | undefined) ?? [];
  const stmts = repositories.flatMap((r) => {
    const repo = repoFullName(r);
    if (!repo) {
      return [];
    }
    return [deleteRepoAccess(db, tenantId, repo)];
  });

  if (stmts.length === 0) {
    return;
  }
  await db.batch([...stmts, bumpDataVersion(db, nowIso)]);
}

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
  const action = payload["action"] as string | undefined;
  if (
    action !== "created" &&
    action !== "renamed" &&
    action !== "transferred" &&
    action !== "privatized" &&
    action !== "publicized"
  ) {
    return;
  }

  const repoObj = (payload["repository"] as Record<string, unknown> | undefined) ?? {};
  const fullName = repoFullName(repoObj);
  if (!fullName) {
    console.warn(`[webhook/app] repository.${action}: missing repository.full_name`);
    return;
  }
  const nowIso = new Date().toISOString();

  // ── created ───────────────────────────────────────────────────────────────
  if (action === "created") {
    const installation =
      (payload["installation"] as Record<string, unknown> | undefined) ?? {};
    const installationId = installation["id"] as number | undefined;
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
    const nodeId = (repoObj["node_id"] as string | undefined) ?? null;
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
    const nodeId = (repoObj["node_id"] as string | undefined) ?? "";
    const changes = (payload["changes"] as Record<string, unknown> | undefined) ?? {};

    let oldFullName: string | null = null;

    // Priority 1: node_id anchor — look up the currently stored slug by node_id.
    if (nodeId) {
      const row = await db
        .prepare(`SELECT repo FROM repos WHERE repo_node_id = ?`)
        .bind(nodeId)
        .first<{ repo: string }>();
      if (row && row.repo !== fullName) {
        oldFullName = row.repo;
      }
    }

    // Priority 2: renamed fallback — changes.repository.name.from (owner unchanged).
    if (!oldFullName && action === "renamed") {
      const repoChanges = (changes["repository"] as Record<string, unknown> | undefined) ?? {};
      const nameChanges = (repoChanges["name"] as Record<string, unknown> | undefined) ?? {};
      const oldName = (nameChanges["from"] as string | undefined) ?? "";
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
      const ownerChanges = (changes["owner"] as Record<string, unknown> | undefined) ?? {};
      const fromBlock = (ownerChanges["from"] as Record<string, unknown> | undefined) ?? {};
      const userBlock = (fromBlock["user"] as Record<string, unknown> | undefined) ?? {};
      const orgBlock = (fromBlock["organization"] as Record<string, unknown> | undefined) ?? {};
      const oldOwner =
        (userBlock["login"] as string | undefined) ??
        (orgBlock["login"] as string | undefined) ??
        "";
      if (oldOwner) {
        const slashIdx = fullName.lastIndexOf("/");
        if (slashIdx >= 0) {
          // A transfer may also rename: prefer changes.repository.name.from; fall back to the
          // current name for a pure ownership transfer (name unchanged).
          const repoChanges = (changes["repository"] as Record<string, unknown> | undefined) ?? {};
          const nameChanges = (repoChanges["name"] as Record<string, unknown> | undefined) ?? {};
          const oldName = (nameChanges["from"] as string | undefined) ?? fullName.slice(slashIdx + 1);
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
  const action = payload["action"] as string | undefined;
  if (action !== "added" && action !== "removed") {
    return;
  }

  // `added`: the next permission check will miss cache and re-verify live.
  // No write needed — the live check will warm the cache correctly.
  if (action === "added") {
    return;
  }

  // `removed`: invalidate the specific (user, repo) pair.
  const memberObj = (payload["member"] as Record<string, unknown> | undefined) ?? {};
  const githubId = memberObj["id"] as number | undefined;
  if (githubId == null) {
    console.warn("[webhook/app] member.removed: missing member.id");
    return;
  }

  const repoObj = (payload["repository"] as Record<string, unknown> | undefined) ?? {};
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
  await db.batch([
    invalidateCacheByUserRepo(db, userId, repo),
    bumpDataVersion(db, nowIso),
  ]);
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
  const action = payload["action"] as string | undefined;
  if (action !== "added" && action !== "removed") {
    return;
  }

  // `added`: next check will re-verify live and warm the cache.
  if (action === "added") {
    return;
  }

  // `removed`: full-user cache wipe.
  const memberObj = (payload["member"] as Record<string, unknown> | undefined) ?? {};
  const githubId = memberObj["id"] as number | undefined;
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
  await db.batch([
    invalidateCacheByUser(db, userId),
    bumpDataVersion(db, nowIso),
  ]);
}
