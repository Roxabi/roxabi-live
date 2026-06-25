import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionContext {
  userId: number;
  /** null while the user is signed in but has not linked a GitHub App installation yet */
  tenantId: number | null;
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

/** Primary session cookie (no __Host- prefix — broader browser support, e.g. Opera). */
export const SESSION_COOKIE = "roxabi_session";
/** Legacy name — still read/cleared during migration. */
export const LEGACY_SESSION_COOKIE = "__Host-session";
export const SESSION_TTL_SECONDS = 28800; // 8 hours
export const SESSION_TTL_REMEMBER_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Cookie / D1 session lifetime from the remember-me choice at sign-in. */
export function sessionTtlSeconds(remember: boolean): number {
  return remember ? SESSION_TTL_REMEMBER_SECONDS : SESSION_TTL_SECONDS;
}
