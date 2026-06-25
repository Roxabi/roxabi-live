/**
 * GET /login — legacy entry; redirects to dedicated /sign-in/ page.
 * OAuth starts only via ?intent=signin|install|reauth|zk or legacy ?go=1 flags.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { AUTH_NO_CACHE, sanitizeAuthRedirect } from "./cookies";

export function serveLoginPrompt(_c: Context<{ Bindings: Env }>, redirectAfter: string): Response {
  const dest = sanitizeAuthRedirect(redirectAfter);
  const url = new URL("/sign-in/", "http://localhost");
  url.searchParams.set("redirect", dest);

  return new Response(null, {
    status: 302,
    headers: { Location: `${url.pathname}${url.search}`, ...AUTH_NO_CACHE },
  });
}
