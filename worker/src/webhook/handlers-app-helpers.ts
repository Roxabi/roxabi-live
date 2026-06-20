/**
 * Shared module-local helpers for the GitHub App webhook handlers
 * (handlers-app.ts install-lifecycle + handlers-access.ts resource/access).
 * Pure payload-shape coercions plus a single users-table lookup; no D1 writes.
 */

/**
 * Extract the full_name from a repository object in a webhook payload.
 * Returns an empty string when the field is absent or malformed so callers
 * can early-return on the empty-string check without additional type guards.
 */
export function repoFullName(repoObj: unknown): string {
  if (!repoObj || typeof repoObj !== "object") {
    return "";
  }
  const fn = (repoObj as Record<string, unknown>).full_name;
  return typeof fn === "string" ? fn : "";
}

/**
 * Derive 0|1 from a boolean-ish `private` field found in GitHub repo objects.
 * Defaults to 1 (private) on ambiguous input — fail-closed for access control.
 */
export function isPrivateBit(repoObj: unknown): 0 | 1 {
  if (!repoObj || typeof repoObj !== "object") {
    return 1;
  }
  const priv = (repoObj as Record<string, unknown>).private;
  return priv === false ? 0 : 1;
}

/**
 * Derive 0|1 from a boolean-ish `archived` field found in GitHub repo objects.
 * Defaults to 0 (live) on ambiguous input — archived only drives dropdown
 * grouping, so the safe default is "show as live" rather than fail-closed.
 */
export function archivedBit(repoObj: unknown): 0 | 1 {
  if (!repoObj || typeof repoObj !== "object") {
    return 0;
  }
  const arch = (repoObj as Record<string, unknown>).archived;
  return arch === true ? 1 : 0;
}

/**
 * Resolve the local `users.id` for a given GitHub numeric user id.
 * Returns null when the user has no local account (never logged in) — callers
 * can skip cache invalidation safely in that case.
 */
export async function resolveUserId(db: D1Database, githubId: number): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM users WHERE github_id = ?")
    .bind(githubId)
    .first<{ id: number }>();
  return row?.id ?? null;
}
