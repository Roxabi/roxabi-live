/**
 * POST /api/consent — persist operator-read acknowledgement (idempotent).
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { buildMePayload } from "./me";

export async function consentRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const row = await c.env.DB.prepare(
    `UPDATE users SET consent_at = COALESCE(consent_at, datetime('now')), updated_at = datetime('now')
     WHERE id = ?
     RETURNING consent_at`,
  )
    .bind(s.userId)
    .first<{ consent_at: string }>();

  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  const payload = await buildMePayload(c.env, s);
  return c.json({ ...payload, consent_at: row.consent_at });
}
