/**
 * One-time OAuth session exchange (#145).
 *
 * Callback mints a session then 302s to GET /auth/exchange?code=…
 * Exchange sets roxabi_session and either serves dashboard HTML (200) or 302s.
 * Serving dashboard inline avoids a follow-up navigation that drops Set-Cookie
 * in some browsers (Opera/normal profile redirect loops).
 */

import type { Context } from "hono";
import type { AuthEnv } from "./types";
import { serveDashboardShell } from "./dashboard-route";
import {
  authRedirect,
  isDashboardDest,
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

  const cookies = sessionCookieHeaders(row.session_token);
  if (isDashboardDest(row.redirect_after)) {
    return serveDashboardShell(c, cookies);
  }

  return authRedirect(row.redirect_after, cookies);
}