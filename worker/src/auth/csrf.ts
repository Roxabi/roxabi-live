/**
 * Same-origin guard for cookie-authenticated POST mutations.
 */

import type { MiddlewareHandler } from "hono";
import type { AuthEnv } from "./types";

function requestHost(c: { req: { url: string; header: (n: string) => string | undefined } }): string {
  return new URL(c.req.url).host;
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Reject cross-site POST when Origin/Referer is present and mismatched. */
export const requireSameOriginPost: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const expected = requestHost(c);
  const origin = c.req.header("Origin");
  if (origin) {
    const host = originHost(origin);
    if (host && host !== expected) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
    return;
  }

  const referer = c.req.header("Referer");
  if (referer) {
    try {
      if (new URL(referer).host !== expected) {
        return c.json({ error: "forbidden" }, 403);
      }
    } catch {
      return c.json({ error: "forbidden" }, 403);
    }
  }

  await next();
};