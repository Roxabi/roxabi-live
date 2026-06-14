/**
 * Tenant lookup helpers for webhook routing.
 *
 * getTenantByInstallationId — primary path: every webhook with `installation`
 *   in the payload carries the installation id; route via that.
 * getTenantByOrgLogin       — fallback path: membership webhooks may omit
 *   `installation`; route via payload.organization.login instead.
 *
 * Both return null (never undefined) when no matching row exists.
 * D1Database is an ambient global from @cloudflare/workers-types.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantRow {
  id: number;
  installation_id: number;
  account_login: string;
  account_type: string;
  suspended_at: string | null;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a tenant by GitHub App installation id.
 * Returns null if no matching row exists.
 */
export async function getTenantByInstallationId(
  db: D1Database,
  installationId: number,
): Promise<TenantRow | null> {
  return (
    (await db
      .prepare(
        `SELECT id, installation_id, account_login, account_type, suspended_at, deleted_at
         FROM tenants
         WHERE installation_id = ?`,
      )
      .bind(installationId)
      .first<TenantRow>()) ?? null
  );
}

/**
 * Look up a tenant by the GitHub account login (org or user name).
 * Used when a webhook payload lacks an `installation` block.
 * Returns null if no matching row exists.
 */
export async function getTenantByOrgLogin(
  db: D1Database,
  login: string,
): Promise<TenantRow | null> {
  return (
    (await db
      .prepare(
        `SELECT id, installation_id, account_login, account_type, suspended_at, deleted_at
         FROM tenants
         WHERE account_login = ?`,
      )
      .bind(login)
      .first<TenantRow>()) ?? null
  );
}
