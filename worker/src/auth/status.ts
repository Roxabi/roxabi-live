/**
 * GET /auth/status — public auth diagnostic (release + cookie/session state).
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import { AUTH_NO_CACHE, readNamedCookie, readSessionToken } from "./cookies";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE } from "./types";
import { validateSession } from "./session";

export async function authStatusRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const cookieHeader = c.req.header("Cookie");
  const primary = readNamedCookie(cookieHeader, SESSION_COOKIE);
  const legacy = readNamedCookie(cookieHeader, LEGACY_SESSION_COOKIE);
  const token = readSessionToken(c);
  let sessionValid = false;
  if (token) {
    sessionValid = !!(await validateSession(c.env.DB, token));
  }

  return c.json(
    {
      release: c.env.APP_RELEASE ?? "unknown",
      cookies: {
        [SESSION_COOKIE]: primary != null,
        [LEGACY_SESSION_COOKIE]: legacy != null,
      },
      session_valid: sessionValid,
    },
    200,
    AUTH_NO_CACHE,
  );
}