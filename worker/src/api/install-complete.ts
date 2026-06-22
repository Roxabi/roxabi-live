/**
 * GET /install/complete — post-install return URL (GitHub App Setup URL).
 *
 * Operator config (GitHub App settings → Setup URL):
 *   https://live.roxabi.dev/install/complete
 *
 * Session already exists; dashboard calls POST /api/install/refresh to link tenants.
 */

import type { Context } from "hono";
import { authRedirect, readSessionToken } from "../auth/cookies";
import { tryLinkInstallPendingSession } from "../auth/link-install";
import { validateSession } from "../auth/session";
import type { AuthEnv } from "../auth/types";

export async function installCompleteRoute(c: Context<AuthEnv>): Promise<Response> {
  const token = readSessionToken(c);
  if (token) {
    const session = await validateSession(c.env.DB, token);
    if (session) {
      await tryLinkInstallPendingSession(c.env.DB, token, session);
    }
  }
  return authRedirect("/dashboard");
}
