/**
 * POST /api/install/refresh — link new GitHub App installs without full re-OAuth.
 *
 * Relies on installation.created webhook → user_installations (sender match).
 * Returns 202 while webhook is in flight; OAuth fallback URL when exhausted.
 */

import type { Context } from "hono";
import { readSessionToken } from "../auth/cookies";
import { listActiveInstallations, tryLinkInstallPendingSession } from "../auth/link-install";
import type { AuthEnv } from "../auth/types";
import { buildMePayload } from "./me";

export const OAUTH_FALLBACK = "/login?intent=install&redirect=%2Fdashboard";

export async function installRefreshRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const installations = await listActiveInstallations(c.env.DB, s.userId);
  if (installations.length === 0) {
    return c.json(
      {
        status: "pending",
        retry_after_ms: 2000,
        oauth_fallback: OAUTH_FALLBACK,
      },
      202,
    );
  }

  const rawToken = readSessionToken(c);
  let activeTenantId = s.tenantId;

  if (rawToken && activeTenantId == null && installations.length === 1) {
    const linked = await tryLinkInstallPendingSession(c.env.DB, rawToken, s);
    if (linked == null) {
      return c.json({ error: "unauthorized" }, 401);
    }
    activeTenantId = linked;
  }

  const payload = await buildMePayload(c.env, {
    ...s,
    tenantId: activeTenantId,
  });
  return c.json({ status: "linked", ...payload });
}
