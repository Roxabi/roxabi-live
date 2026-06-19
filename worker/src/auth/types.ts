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
