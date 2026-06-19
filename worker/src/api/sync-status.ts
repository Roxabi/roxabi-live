/**
 * GET /api/sync/status — bootstrap sync progress for the initial-load overlay.
 *
 * Schedules a background runSync when the corpus is still empty. With
 * ZK_ACCOUNT_KEY on, only after the session user has a passphrase backup row
 * (post-enrollment — frontend calls this after requireZkEnrollmentGate).
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { zkAccountKeyEnabled } from "../auth/zk-flags";
import { getSyncStatus, isGlobalSyncRunning, maybeScheduleBootstrapSync } from "../sync/bootstrap";

export async function syncStatusRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const hasLinkedTenant = s.tenantId != null;
  const syncCtx = {
    userId: s.userId,
    zkAccountKeyEnabled: zkAccountKeyEnabled(c.env),
  };
  const status = await getSyncStatus(c.env.DB, hasLinkedTenant, syncCtx);

  if (status.initial_sync && !status.sync_running) {
    await maybeScheduleBootstrapSync(c.env.DB, c.env, c.executionCtx, syncCtx);
    status.sync_running = await isGlobalSyncRunning(c.env.DB);
  }

  return c.json(status);
}
