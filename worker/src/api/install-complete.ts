/**
 * GET /install/complete — post-install return URL (GitHub App Setup URL).
 *
 * Operator config (GitHub App settings → Setup URL):
 *   https://live.roxabi.dev/install/complete
 *
 * Re-OAuth is required so we can fetch /user/installations and link tenants.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { authRedirect } from "../auth/cookies";

export async function installCompleteRoute(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  return authRedirect("/login?redirect=/dashboard");
}