/**
 * GET /api/sync/status — bootstrap sync progress for the initial-load overlay.
 *
 * Also schedules a background runSync when the corpus is still empty (lazy
 * fallback if OAuth/webhook bootstrap was missed).
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import {
  getSyncStatus,
  isGlobalSyncRunning,
  maybeScheduleBootstrapSync,
} from "../sync/bootstrap";

export async function syncStatusRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const hasLinkedTenant = s.tenantId != null;
  const status = await getSyncStatus(c.env.DB, hasLinkedTenant);

  if (status.initial_sync && !status.sync_running) {
    await maybeScheduleBootstrapSync(c.env.DB, c.env, c.executionCtx);
    status.sync_running = await isGlobalSyncRunning(c.env.DB);
  }

  return c.json(status);
}