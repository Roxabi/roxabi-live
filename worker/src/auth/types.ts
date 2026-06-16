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
