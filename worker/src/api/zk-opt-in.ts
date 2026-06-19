/**
 * POST /api/zk-opt-in — toggle per-user zero-knowledge mode preference (#142 S1).
 *
 * Body: { enabled: boolean }
 *
 * When enabled, graph titles are redacted server-side; client decrypts via
 * zk_payloads. When enabling, the UI seals titles first (see frontend/zk-sync.js).
 * the UI must surface the residual trust gap (metadata leaks, XSS, etc.).
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";

export async function zkOptInRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "enabled required" }, 400);
  }

  const enabled =
    body !== null && typeof body === "object" && "enabled" in body
      ? (body as Record<string, unknown>).enabled
      : undefined;

  if (typeof enabled !== "boolean") {
    return c.json({ error: "enabled required" }, 400);
  }

  const flag = enabled ? 1 : 0;

  await c.env.DB.prepare(
    `UPDATE users SET zk_opt_in = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(flag, s.userId)
    .run();

  return c.json({ zk_opt_in: enabled });
}
