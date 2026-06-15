/**
 * Per-request visible-repo resolver and private-repo permission check.
 *
 * Security invariant: every uncertain / error path returns false (deny).
 * This is the IDOR-closing primitive — fail-closed on all branches.
 *
 * Never throws out to the caller. All errors are caught internally and
 * resolved as a denial so transient failures cannot leak private data.
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import type { Env } from "../types";
import { getInstallationToken } from "./installToken";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RepoAccessRow {
  repo: string;
  is_private: number;
}

interface TenantInstallRow {
  installation_id: number;
}

interface PermCacheRow {
  has_access: number;
}

// ---------------------------------------------------------------------------
// resolveVisibleRepos
// ---------------------------------------------------------------------------

/**
 * Return the list of repo full-names visible to the authenticated session user.
 *
 * Public repos (is_private = 0) are always included.
 * Private repos (is_private = 1) are included only if checkPrivateAccess returns true.
 *
 * Fail-closed: missing session, DB errors, or any per-repo check error → deny that repo.
 * installation_id is resolved once before the loop; never re-queried per repo.
 *
 * @param c - Hono context carrying AuthEnv (DB binding + session variable).
 * @returns Array of visible repo full-names ("owner/name").
 */
export async function resolveVisibleRepos(
  c: Context<AuthEnv>,
): Promise<string[]> {
  const s = c.get("session");
  // Middleware guarantees session; guard defensively — fail-closed.
  if (!s) {
    return [];
  }

  const db = c.env.DB;
  const env = c.env;

  // Fetch all repos registered for this tenant.
  let rows: RepoAccessRow[];
  try {
    const result = await db
      .prepare(
        `SELECT repo, is_private FROM tenant_repo_access WHERE tenant_id = ?`,
      )
      .bind(s.tenantId)
      .all<RepoAccessRow>();
    rows = result.results ?? [];
  } catch {
    // DB error — fail-closed, no repos visible.
    return [];
  }

  if (rows.length === 0) {
    return [];
  }

  // Resolve installation_id ONCE for this tenant before iterating private repos.
  // We only need it if there are private repos, but resolve eagerly to keep the
  // loop simple and avoid conditional re-queries.
  let installationId: number | null = null;
  const hasPrivate = rows.some((r) => r.is_private !== 0);
  if (hasPrivate) {
    try {
      const tenantRow = await db
        .prepare(
          `SELECT installation_id FROM tenants WHERE id = ?`,
        )
        .bind(s.tenantId)
        .first<TenantInstallRow>();
      installationId = tenantRow?.installation_id ?? null;
    } catch {
      // DB error — treat all private repos as denied below (installationId = null).
    }
  }

  const visible: string[] = [];

  for (const row of rows) {
    if (row.is_private === 0) {
      // Public repo — always visible.
      visible.push(row.repo);
    } else {
      // Private repo — check per-user permission.
      if (installationId === null) {
        // Could not resolve installation — deny (fail-closed).
        continue;
      }
      const allowed = await checkPrivateAccess(
        db,
        env,
        s.userId,
        s.tenantId,
        installationId,
        row.repo,
        s.githubLogin,
      );
      if (allowed) {
        visible.push(row.repo);
      }
    }
  }

  return visible;
}

// ---------------------------------------------------------------------------
// checkPrivateAccess
// ---------------------------------------------------------------------------

/**
 * Check whether a user has read access to a private repository.
 *
 * Cache path (24 h TTL): reads user_repo_permission_cache. Hit → return cached value.
 * Live path (cache miss / stale):
 *   - Mints an installation access token via getInstallationToken.
 *   - Calls GET /repos/{repo}/collaborators/{login} with the token.
 *   - HTTP 204 → access granted. HTTP 404 or 403 → access denied.
 *   - On 204/404/403: UPSERTs result into cache, then returns boolean.
 *   - Any other status, network error, or thrown exception → fail-closed (false),
 *     cache is NOT written (transient failure must not poison future cache hits).
 *
 * @param db             - D1 database binding.
 * @param env            - Worker env bindings (for getInstallationToken).
 * @param userId         - users.id of the authenticated user.
 * @param tenantId       - tenants.id (supplied by the caller, which already holds it).
 * @param installationId - GitHub App installation_id (resolved by the caller).
 * @param repo           - Full repo name "owner/name" (already validated by caller).
 * @param login          - GitHub login of the user (for the collaborator check URL).
 * @returns true if the user has access, false in all other cases (deny-by-default).
 */
export async function checkPrivateAccess(
  db: D1Database,
  env: Env,
  userId: number,
  tenantId: number,
  installationId: number,
  repo: string,
  login: string,
): Promise<boolean> {
  // Step 1 — Cache check (24 h TTL).
  try {
    const cached = await db
      .prepare(
        `SELECT has_access FROM user_repo_permission_cache
         WHERE user_id = ? AND repo = ? AND checked_at > datetime('now','-24 hours')`,
      )
      .bind(userId, repo)
      .first<PermCacheRow>();

    if (cached !== null && cached !== undefined) {
      // Cache hit — return stored value.
      return Boolean(cached.has_access);
    }
  } catch {
    // Cache read failure — proceed to live check; do not short-circuit to false
    // (a DB read error should not permanently deny a user; live check can clarify).
  }

  // Step 2 — Live check via GitHub Collaborators API.
  // Any error in this block must return false without writing cache.
  let access: boolean;
  try {
    // tenantId + installationId are both supplied by the caller (resolveVisibleRepos),
    // which already holds them on the session — no reverse lookup needed.
    const token = await getInstallationToken(
      db,
      env,
      tenantId,
      installationId,
    );

    // GET /repos/{owner}/{name}/collaborators/{login}
    // repo is already "owner/name" — use directly.
    const url = `https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(login)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "roxabi-live-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 204) {
      access = true;
    } else if (res.status === 404 || res.status === 403) {
      access = false;
    } else {
      // Unexpected status (5xx, 429, etc.) — fail-closed, do NOT cache.
      return false;
    }
  } catch {
    // Network failure, token mint error, or any thrown exception — fail-closed.
    // Do NOT write cache: a transient failure must not poison future reads.
    return false;
  }

  // Step 3 — UPSERT result into cache (only reached on 204 / 404 / 403).
  try {
    await db
      .prepare(
        `INSERT INTO user_repo_permission_cache (user_id, repo, has_access, checked_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, repo) DO UPDATE SET
           has_access = excluded.has_access,
           checked_at = excluded.checked_at`,
      )
      .bind(userId, repo, access ? 1 : 0)
      .run();
  } catch {
    // Cache write failure — log-only concern; return the live result regardless.
    // A failed upsert means the next request re-checks live; it does not affect
    // the current request's answer.
  }

  return access;
}
