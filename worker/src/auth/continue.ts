/**
 * GET /auth/continue — post-OAuth server hop; verifies session cookie then redirects.
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import {
  authRedirect,
  clearSessionCookieHeaders,
  readSessionToken,
  sanitizeAuthRedirect,
} from "./cookies";
import { validateSession } from "./session";

export async function authContinueRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const dest = sanitizeAuthRedirect(c.req.query("to") ?? undefined);
  const loginDest = `/login?redirect=${encodeURIComponent(dest)}`;

  const token = readSessionToken(c);
  if (!token) {
    return authRedirect(loginDest);
  }

  const session = await validateSession(c.env.DB, token);
  if (!session) {
    return authRedirect(loginDest, clearSessionCookieHeaders());
  }

  return authRedirect(dest);
}