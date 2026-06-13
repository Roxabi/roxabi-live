/**
 * Session management for GitHub App OAuth sessions.
 *
 * Tokens are stored as SHA-256 hashes (never raw). The __Host- cookie prefix
 * mandates Secure + Path=/ + no Domain — enforced by sessionCookie().
 */

import type { MiddlewareHandler, Context } from "hono";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionContext {
  userId: number;
  tenantId: number;
  githubId: number;
  githubLogin: string;
}

export type AuthEnv = {
  Bindings: Env;
  Variables: { session?: SessionContext };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "__Host-session";
export const SESSION_TTL_SECONDS = 28800; // 8 hours

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 digest of a UTF-8 string, returned as lowercase hex.
 * Uses the ambient crypto.subtle (Cloudflare Workers / Vitest Node env).
 */
async function sha256hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Cookie helpers (pure, synchronous)
// ---------------------------------------------------------------------------

/**
 * Build a Set-Cookie header value for the session token.
 * __Host- prefix requires: Secure, Path=/, no Domain.
 */
export function sessionCookie(rawToken: string): string {
  return `${SESSION_COOKIE}=${rawToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

/**
 * Build a Set-Cookie header value that immediately expires the session cookie.
 */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Token reader
// ---------------------------------------------------------------------------

/**
 * Parse the __Host-session cookie value from the Cookie header.
 * Returns null if the cookie is absent or the header is missing.
 */
export function readSessionToken(c: Context): string | null {
  const cookieHeader = c.req.header("Cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    if (name === SESSION_COOKIE) {
      return trimmed.slice(eqIdx + 1).trim() || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// D1 operations
// ---------------------------------------------------------------------------

/**
 * Mint a new session: generate 32 random bytes as a 64-char hex token,
 * store its SHA-256 hash in D1, and return the raw token (once, never stored).
 */
export async function mintSession(
  db: D1Database,
  userId: number,
  tenantId: number,
): Promise<string> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const rawToken = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const hash = await sha256hex(rawToken);

  await db
    .prepare(
      `INSERT INTO sessions (user_id, tenant_id, token_hash, expires_at)
       VALUES (?, ?, ?, datetime('now', '+8 hours'))`,
    )
    .bind(userId, tenantId, hash)
    .run();

  return rawToken;
}

/**
 * Validate a raw session token.
 * Returns the SessionContext if the session is valid (not expired, not revoked,
 * tenant not suspended), or null otherwise.
 */
export async function validateSession(
  db: D1Database,
  rawToken: string,
): Promise<SessionContext | null> {
  const hash = await sha256hex(rawToken);

  const row = await db
    .prepare(
      `SELECT s.user_id AS userId, s.tenant_id AS tenantId, u.github_id AS githubId, u.github_login AS githubLogin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.expires_at > datetime('now')
         AND s.revoked_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = s.tenant_id AND t.suspended_at IS NOT NULL)`,
    )
    .bind(hash)
    .first<SessionContext>();

  return row ?? null;
}

/**
 * Switch the active tenant for an existing session.
 * Hashes the raw token, then updates sessions.tenant_id in place.
 * The UPDATE is a no-op if the session has expired or been revoked,
 * which is safe — the caller (activeTenantRoute) guards membership first.
 */
export async function setSessionTenant(
  db: D1Database,
  rawToken: string,
  tenantId: number,
): Promise<void> {
  const hash = await sha256hex(rawToken);

  await db
    .prepare(
      `UPDATE sessions SET tenant_id = ?
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND expires_at > datetime('now')`,
    )
    .bind(tenantId, hash)
    .run();
}

/**
 * Delete a session by raw token (hashes before querying).
 */
export async function deleteSession(
  db: D1Database,
  rawToken: string,
): Promise<void> {
  const hash = await sha256hex(rawToken);

  await db
    .prepare(`DELETE FROM sessions WHERE token_hash = ?`)
    .bind(hash)
    .run();
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Fail-closed session middleware. Reads the __Host-session cookie, validates
 * against D1, and sets the session context on the Hono context. Returns 401
 * JSON if the token is absent or invalid.
 */
export const requireSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const token = readSessionToken(c);
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const ctx = await validateSession(c.env.DB, token);
  if (!ctx) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("session", ctx);
  await next();
};
