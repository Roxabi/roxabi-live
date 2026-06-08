/**
 * POST /admin/sync — trigger a corpus sync run out-of-band.
 *
 * Uses waitUntil so the 202 response is returned immediately while sync runs
 * in the background (Cloudflare Workers execution model).
 *
 * Auth (#123): ADMIN_TOKEN gate is applied at the router level (router.ts
 * `app.use("/admin/*", ...)`) so this handler only runs when auth passes.
 * Unset ADMIN_TOKEN = edge-Access-only mode (no Worker-side gate).
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { runSync } from "../sync/sync";

export const adminSyncRoute = async (c: Context<{ Bindings: Env }>) => {
  c.executionCtx.waitUntil(runSync(c.env));
  return c.json({ ok: true, triggered: true }, 202);
};
