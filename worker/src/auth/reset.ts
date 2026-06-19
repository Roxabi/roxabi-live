/**
 * GET /auth/reset — clear session + browser site data, then redirect home.
 *
 * Use when a normal browser profile is stuck in a cached redirect loop after
 * OAuth (private mode works because its HTTP cache is empty).
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import {
  AUTH_NO_CACHE,
  authRedirect,
  clearSessionCookie,
  readSessionToken,
} from "./cookies";
import { deleteSession } from "./session";

export async function authResetRoute(c: Context<AuthEnv>): Promise<Response> {
  const raw = readSessionToken(c);
  if (raw) {
    await deleteSession(c.env.DB, raw);
  }

  return authRedirect("/", {
    "Set-Cookie": clearSessionCookie(),
    "Clear-Site-Data": '"cache", "cookies", "storage"',
    ...AUTH_NO_CACHE,
  });
}