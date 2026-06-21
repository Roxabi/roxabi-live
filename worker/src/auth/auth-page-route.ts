/**
 * GET /sign-in/, /sign-up/ — public auth pages; redirect to dashboard when already signed in.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { authRedirect, readSessionToken, sanitizeAuthRedirect, withAuthNoCache } from "./cookies";
import { validateSession } from "./session";
import type { AuthEnv } from "./types";

export const SIGN_IN_PATH = "/sign-in/";
export const SIGN_UP_PATH = "/sign-up/";

/** Resolve post-login destination from ?redirect= (open-redirect safe). */
export function authPageRedirectDest(reqUrl: URL): string {
  return sanitizeAuthRedirect(reqUrl.searchParams.get("redirect") ?? undefined);
}

async function serveAuthPageShell(
  env: Env,
  raw: Request,
  reqUrl: string,
  canonicalPath: string,
): Promise<Response> {
  const assetUrl = new URL(reqUrl);
  assetUrl.pathname = canonicalPath;
  const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), raw));
  return withAuthNoCache(assetRes);
}

export async function signInPageRoute(c: Context<AuthEnv>): Promise<Response> {
  return authPageRoute(c, SIGN_IN_PATH);
}

export async function signUpPageRoute(c: Context<AuthEnv>): Promise<Response> {
  return authPageRoute(c, SIGN_UP_PATH);
}

async function authPageRoute(c: Context<AuthEnv>, canonicalPath: string): Promise<Response> {
  const reqUrl = new URL(c.req.url);
  const token = readSessionToken(c);
  if (token) {
    const session = await validateSession(c.env.DB, token);
    if (session) {
      return authRedirect(authPageRedirectDest(reqUrl));
    }
  }

  return serveAuthPageShell(c.env, c.req.raw, c.req.url, canonicalPath);
}
