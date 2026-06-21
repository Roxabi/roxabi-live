/**
 * GitHub App install-lifecycle webhook handlers — installation,
 * installation_repositories events. (Resource/access events — repository,
 * member, membership — live in handlers-access.ts; shared payload helpers in
 * handlers-app-helpers.ts.)
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

import { supersedeStaleTenants } from "../auth/tenant-supersede";
import type { Env } from "../types";
import { isPrivateBit, repoFullName, resolveUserId } from "./handlers-app-helpers";
import { bumpDataVersion } from "./mutations";
import {
  deleteAllRepoAccessForTenant,
  deleteInstallTokensForTenant,
  deleteRepoAccess,
  deleteSessionsForTenant,
  setTenantSuspended,
  softDeleteTenant,
  upsertRepoAccess,
  upsertTenant,
} from "./mutations-app";
import { getTenantByInstallationId } from "./tenant";

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
  _env: Env,
): Promise<void> {
  const action = payload.action as string | undefined;
  if (!action) {
    console.warn("[webhook/app] installation event missing action");
    return;
  }

  const installation = (payload.installation as Record<string, unknown> | undefined) ?? {};
  const installationId = installation.id as number | undefined;
  if (installationId == null) {
    console.warn(`[webhook/app] installation.${action}: missing installation.id`);
    return;
  }

  const account = (installation.account as Record<string, unknown> | undefined) ?? {};
  const accountLogin = (account.login as string | undefined) ?? "";
  const accountType = (account.type as string | undefined) ?? "Organization";
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

    await supersedeStaleTenants(db, {
      keepTenantId: tenantId,
      accountLogin,
      accountType,
      installationId,
      nowIso,
    });

    // Build repo-access upserts from payload.repositories (the install-time selection).
    const repositories = (payload.repositories as unknown[] | undefined) ?? [];
    const repoStmts = repositories.flatMap((r) => {
      const repo = repoFullName(r);
      if (!repo) {
        return [];
      }
      return [upsertRepoAccess(db, tenantId, repo, isPrivateBit(r))];
    });

    const sender = (payload.sender as Record<string, unknown> | undefined) ?? {};
    const senderGithubId = sender.id as number | undefined;
    const linkStmts = [];
    if (senderGithubId != null) {
      const userId = await resolveUserId(db, senderGithubId);
      if (userId != null) {
        linkStmts.push(
          db
            .prepare("INSERT OR IGNORE INTO user_installations (user_id, tenant_id) VALUES (?, ?)")
            .bind(userId, tenantId),
        );
      }
    }

    // Atomic: repo access + user link + data-version bump.
    await db.batch([...repoStmts, ...linkStmts, bumpDataVersion(db, nowIso)]);
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
    await db.batch([setTenantSuspended(db, tenant.id, null, nowIso), bumpDataVersion(db, nowIso)]);
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
  _env: Env,
): Promise<void> {
  const action = payload.action as string | undefined;
  if (action !== "added" && action !== "removed") {
    console.info(`[webhook/app] installation_repositories.${action}: no-op`);
    return;
  }

  const installation = (payload.installation as Record<string, unknown> | undefined) ?? {};
  const installationId = installation.id as number | undefined;
  if (installationId == null) {
    console.warn(`[webhook/app] installation_repositories.${action}: missing installation.id`);
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
    const repositories = (payload.repositories_added as unknown[] | undefined) ?? [];
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
  const repositories = (payload.repositories_removed as unknown[] | undefined) ?? [];
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
