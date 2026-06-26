/**
 * Installation access token management for GitHub App installs.
 *
 * Tokens are encrypted at rest using AES-GCM (tokenCrypto.ts) in the
 * install_tokens D1 table and refreshed proactively 5 minutes before expiry.
 *
 * Compatible with the Cloudflare Workers runtime — no Node.js imports.
 */

import type { Env } from "../types";
import { importAppPrivateKey, signAppJwt } from "./jwt";
import { decryptToken, encryptToken, importDek } from "./tokenCrypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InstallTokenRow {
  token_enc: string;
  token_iv: string;
  expires_at: string;
}

interface TenantRow {
  id: number;
  installation_id: number;
  suspended_at: string | null;
}

interface GHAccessTokenResponse {
  token: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Proactive refresh window: treat tokens expiring within 5 minutes as stale. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Env access helper
// ---------------------------------------------------------------------------

/** Read the AES-GCM DEK (base64) used to encrypt install tokens at rest. */
function getInstallTokenKey(env: Env): string {
  if (!env.INSTALL_TOKEN_KEY) {
    throw new Error("INSTALL_TOKEN_KEY secret is not configured");
  }
  return env.INSTALL_TOKEN_KEY;
}

// ---------------------------------------------------------------------------
// Core: getInstallationToken
// ---------------------------------------------------------------------------

/**
 * Return a valid installation access token for the given tenant/installation.
 *
 * Cache-hit path: if install_tokens has a row with expires_at > now+5min, decrypts
 * and returns it without calling GitHub.
 *
 * Mint path: calls POST /app/installations/{id}/access_tokens, encrypts the new
 * token, upserts into install_tokens, and returns the plaintext token (once).
 *
 * @param db             - D1 database binding.
 * @param env            - Worker env bindings.
 * @param tenantId       - Primary key in the tenants table.
 * @param installationId - GitHub App installation ID.
 * @returns Plaintext GitHub installation access token.
 */
export async function getInstallationToken(
  db: D1Database,
  env: Env,
  tenantId: number,
  installationId: number,
): Promise<string> {
  // Fail-closed on suspended installations: sync.ts calls this directly, bypassing
  // resolveInstallToken's guard. Covers both the cache-hit and mint paths.
  const tenantRow = await db
    .prepare("SELECT suspended_at FROM tenants WHERE id = ?")
    .bind(tenantId)
    .first<{ suspended_at: string | null }>();
  if (!tenantRow) {
    throw new Error(`Installation for tenant ${tenantId} not found`);
  }
  if (tenantRow.suspended_at !== null) {
    throw new Error(`Installation for tenant ${tenantId} is suspended`);
  }

  const installTokenKey = getInstallTokenKey(env);

  // Step 1 — Check cache
  const row = await db
    .prepare("SELECT token_enc, token_iv, expires_at FROM install_tokens WHERE tenant_id = ?")
    .bind(tenantId)
    .first<InstallTokenRow>();

  if (row) {
    const expiresAt = new Date(row.expires_at).getTime();
    const threshold = Date.now() + STALE_THRESHOLD_MS;
    if (expiresAt > threshold) {
      // Cache hit — decrypt and return
      const dek = await importDek(installTokenKey);
      return decryptToken(dek, row.token_enc, row.token_iv);
    }
  }

  // Step 2 — Mint a fresh token via GitHub App JWT
  const appKey = await importAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const jwt = await signAppJwt(env.GITHUB_APP_ID, appKey);

  const mintUrl = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const mintRes = await fetch(mintUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "roxabi-live-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!mintRes.ok) {
    const text = await mintRes.text();
    throw new Error(
      `GitHub installation token mint failed: HTTP ${mintRes.status} — ${text.slice(0, 200)}`,
    );
  }

  let mintBody: GHAccessTokenResponse;
  try {
    mintBody = (await mintRes.json()) as GHAccessTokenResponse;
  } catch {
    throw new Error(
      `GitHub installation token mint failed: unexpected non-JSON response for installation ${installationId}`,
    );
  }
  const { token, expires_at } = mintBody;

  // Step 3 — Encrypt and upsert
  const dek = await importDek(installTokenKey);
  const { enc, iv } = await encryptToken(dek, token);
  const updatedAt = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO install_tokens (tenant_id, token_enc, token_iv, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         token_enc  = excluded.token_enc,
         token_iv   = excluded.token_iv,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(tenantId, enc, iv, expires_at, updatedAt)
    .run();

  // Step 4 — Return the fresh plaintext token (never persisted raw)
  return token;
}

// ---------------------------------------------------------------------------
// resolveInstallToken
// ---------------------------------------------------------------------------

/**
 * Resolve an installation access token by repository owner + name.
 *
 * Fail-closed: throws if no tenant_repo_access row exists for the repo, or if
 * the owning tenant is suspended.
 *
 * @param db    - D1 database binding.
 * @param env   - Worker env bindings.
 * @param owner - Repository owner (org or user login).
 * @param name  - Repository name.
 * @returns Plaintext GitHub installation access token for the owning installation.
 * @throws If the repo is not registered or the tenant is suspended.
 */
export async function resolveInstallToken(
  db: D1Database,
  env: Env,
  owner: string,
  name: string,
): Promise<string> {
  const repo = `${owner}/${name}`;

  // JOIN tenant_repo_access → tenants to get suspension status + installation_id.
  // Phase-1 invariant (see #141/#147): one repo → one installation (enforced by
  // tenants UNIQUE(installation_id) + tenant_repo_access FK). .first() is therefore
  // deterministic here. Re-verify this assumption before extending to multi-tenant
  // (Phase 2 / #147) — the query will need GROUP BY or a different resolution strategy.
  const row = await db
    .prepare(
      `SELECT t.id, t.installation_id, t.suspended_at
       FROM tenant_repo_access tra
       JOIN tenants t ON t.id = tra.tenant_id
       WHERE tra.repo = ?`,
    )
    .bind(repo)
    .first<TenantRow>();

  if (!row) {
    throw new Error(`No installation found for repository: ${repo}`);
  }

  if (row.suspended_at !== null) {
    throw new Error(`Installation for ${repo} is suspended`);
  }

  return getInstallationToken(db, env, row.id, row.installation_id);
}

// ---------------------------------------------------------------------------
// listInstallationRepos
// ---------------------------------------------------------------------------

interface GHRepository {
  full_name: string;
  private: boolean;
  archived: boolean;
}

interface GHInstallationReposResponse {
  repositories: GHRepository[];
  total_count: number;
}

/**
 * List all repositories accessible to an installation via its access token.
 *
 * Paginates automatically (100 per page) until all repos are collected.
 *
 * @param token - GitHub installation access token (from getInstallationToken).
 * @returns Array of `{ repo: "owner/name", isPrivate, isArchived }` entries.
 *          `isArchived` is optional in the type (so callers/mocks omitting it
 *          still typecheck) but the real implementation always sets it from the
 *          GitHub `archived` field — consumed by the repos-table archived flag.
 */
export async function listInstallationRepos(
  token: string,
): Promise<Array<{ repo: string; isPrivate: boolean; isArchived?: boolean }>> {
  const MAX_PAGES = 10;
  const repos: Array<{ repo: string; isPrivate: boolean; isArchived?: boolean }> = [];
  let lastPageFull = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/installation/repositories?per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "roxabi-live-worker",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `GitHub list installation repositories failed: HTTP ${res.status} — ${text.slice(0, 200)}`,
      );
    }

    let body: GHInstallationReposResponse;
    try {
      body = (await res.json()) as GHInstallationReposResponse;
    } catch {
      throw new Error(
        `GitHub list installation repositories failed: unexpected non-JSON response (page ${page})`,
      );
    }
    const pageRepos = body.repositories ?? [];

    for (const r of pageRepos) {
      repos.push({ repo: r.full_name, isPrivate: r.private, isArchived: r.archived });
    }

    lastPageFull = pageRepos.length === 100;

    // Stop if this page was not full (last page)
    if (pageRepos.length < 100) {
      break;
    }
  }

  if (lastPageFull) {
    console.warn(
      `[installToken] listInstallationRepos hit MAX_PAGES (${MAX_PAGES}) — repo list may be truncated`,
    );
  }

  return repos;
}
