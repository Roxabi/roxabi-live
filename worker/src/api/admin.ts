/**
 * POST /admin/sync — trigger a corpus sync run out-of-band.
 *
 * Uses waitUntil so the 202 response is returned immediately while sync runs
 * in the background (Cloudflare Workers execution model).
 *
 * NOTE: OTP / access gating is enforced at the Cloudflare Access edge (S9
 * cutover); in-worker JWT verification is deferred (spec #92 open-Q7).
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { runSync } from "../sync/sync";

export const adminSyncRoute = async (c: Context<{ Bindings: Env }>) => {
  c.executionCtx.waitUntil(runSync(c.env));
  return c.json({ ok: true, triggered: true }, 202);
};
