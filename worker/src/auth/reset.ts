/**
 * GET /auth/reset — clear session + browser site data, then redirect home.
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import { authRedirect, clearSessionCookieHeaders, readSessionToken } from "./cookies";
import { deleteSession } from "./session";

export async function authResetRoute(c: Context<AuthEnv>): Promise<Response> {
  const raw = readSessionToken(c);
  if (raw) {
    await deleteSession(c.env.DB, raw);
  }

  return authRedirect("/", clearSessionCookieHeaders(), {
    "Clear-Site-Data": '"cache", "cookies", "storage"',
  });
}