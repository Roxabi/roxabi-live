import type { Context } from "hono";
import type { Env } from "../types";

/**
 * GET /api/version — cheap change-detection token for the frontend poller
 * (frontend/app.js polls every 15s and reloads the graph when `version` changes).
 *
 * Response shape MUST stay `{ version: string }` — matches the Python
 * `app.py::api_version` contract consumed by `frontend/app.js::fetchVersion`.
 *
 * Returns MAX across:
 *   - sync_state.last_synced_at  (advances on hourly cron)
 *   - sync_control['data_version'] (bumped on every mutating webhook dispatch)
 *
 * Both columns are ISO-8601 strings and compare lexicographically, so MAX()
 * over the UNION ALL correctly returns the most-recent write regardless of
 * which path produced it. Resolves #133.
 */
export const versionRoute = async (c: Context<{ Bindings: Env }>) => {
  const row = await c.env.DB.prepare(
    `SELECT MAX(v) AS version FROM (
       SELECT COALESCE(MAX(last_synced_at), '') AS v FROM sync_state
       UNION ALL
       SELECT COALESCE(value, '') AS v FROM sync_control WHERE key = 'data_version' AND tenant_id = 0
     )`,
  ).first<{ version: string | null }>();
  return c.json({ version: row?.version ?? "" });
};
