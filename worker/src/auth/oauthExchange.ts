/**
 * One-time OAuth session exchange (#145).
 *
 * Callback mints a session then 302s to GET /auth/exchange?code=…
 * Exchange consumes the code, sets roxabi_session via 302 Set-Cookie, redirects.
 * Avoids HTML+JS cookie races in browsers that drop Set-Cookie on 200 shells.
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import {
  authRedirect,
  sanitizeAuthRedirect,
  sessionCookieHeaders,
} from "./cookies";

const EXCHANGE_TTL_MINUTES = 5;

function exchangeCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createOAuthExchange(
  db: D1Database,
  rawToken: string,
  redirectAfter: string,
): Promise<string> {
  const code = exchangeCode();
  const dest = sanitizeAuthRedirect(redirectAfter);

  await db
    .prepare(
      `INSERT INTO oauth_exchange (code, session_token, redirect_after, expires_at)
       VALUES (?, ?, ?, datetime('now', '+${EXCHANGE_TTL_MINUTES} minutes'))`,
    )
    .bind(code, rawToken, dest)
    .run();

  return code;
}

export async function authExchangeRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const code = c.req.query("code");
  if (!code) {
    return c.json({ error: "bad_request" }, 400);
  }

  const row = await c.env.DB.prepare(
    `DELETE FROM oauth_exchange
     WHERE code = ? AND expires_at > datetime('now')
     RETURNING session_token, redirect_after`,
  )
    .bind(code)
    .first<{ session_token: string; redirect_after: string }>();

  if (!row) {
    return c.json({ error: "expired" }, 400);
  }

  return authRedirect(row.redirect_after, sessionCookieHeaders(row.session_token));
}