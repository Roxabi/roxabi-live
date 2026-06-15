/**
 * POST /api/active-tenant — switch the authenticated user's active tenant.
 *
 * Body: { tenant_id: number }
 *
 * The route is also placed behind requireSession middleware in router.ts
 * (registered in T9). The explicit session check here is defense-in-depth.
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { readSessionToken } from "../auth/cookies";
import { setSessionTenant } from "../auth/session";

export async function activeTenantRoute(c: Context<AuthEnv>): Promise<Response> {
  // Defense-in-depth: requireSession already guards, but fail closed here too.
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Parse + validate request body.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "tenant_id required" }, 400);
  }

  const tenantId =
    body !== null && typeof body === "object" && "tenant_id" in body
      ? (body as Record<string, unknown>).tenant_id
      : undefined;

  if (typeof tenantId !== "number" || !Number.isInteger(tenantId)) {
    return c.json({ error: "tenant_id required" }, 400);
  }

  // Membership check — user must belong to the requested tenant.
  const membership = await c.env.DB
    .prepare(
      `SELECT 1 FROM user_installations WHERE user_id = ? AND tenant_id = ?`,
    )
    .bind(s.userId, tenantId)
    .first<{ 1: number }>();

  if (!membership) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Suspended-tenant guard: a member must not switch into a suspended tenant.
  // validateSession would 401 every subsequent request (NOT-EXISTS suspended guard),
  // self-locking the session — reject the switch up-front instead.
  const tenant = await c.env.DB
    .prepare(`SELECT suspended_at FROM tenants WHERE id = ?`)
    .bind(tenantId)
    .first<{ suspended_at: string | null }>();

  if (!tenant || tenant.suspended_at !== null) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Read raw token from cookie for hashing inside setSessionTenant.
  const raw = readSessionToken(c);
  if (!raw) {
    return c.json({ error: "unauthorized" }, 401);
  }

  await setSessionTenant(c.env.DB, raw, tenantId);

  return c.json({ active_tenant_id: tenantId });
}
