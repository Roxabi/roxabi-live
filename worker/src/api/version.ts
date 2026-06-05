import type { Context } from "hono";
import type { Env } from "../types";

/**
 * GET /api/version — cheap change-detection token for the frontend poller
 * (frontend/app.js polls every 15s and reloads the graph when `version` changes).
 *
 * Response shape MUST stay `{ version: string }` — matches the Python
 * `app.py::api_version` contract consumed by `frontend/app.js::fetchVersion`.
 *
 * The Python impl returned the max mtime across corpus.db + WAL/SHM, catching
 * BOTH webhook and reconciler writes. D1 has no file mtime, so we use
 * `MAX(last_synced_at)` from sync_state (per spec #92 §2).
 *
 * TODO(#97/#98, S5/S6): `last_synced_at` only advances on the hourly cron sync,
 * not on webhook-driven writes — so webhook board changes won't trigger a
 * live-refresh. Restore parity with a per-write mutation token (e.g. a
 * `sync_control` row bumped on every webhook upsert) when those paths land.
 */
export const versionRoute = async (c: Context<{ Bindings: Env }>) => {
  const row = await c.env.DB.prepare(
    "SELECT MAX(last_synced_at) AS ts FROM sync_state",
  ).first<{ ts: string | null }>();
  return c.json({ version: row?.ts ?? "" });
};
