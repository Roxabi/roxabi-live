import type { Context } from "hono";
import { AUTH_NO_CACHE } from "../auth/cookies";
import type { Env } from "../types";

/** GET /api/release — deployed app version (not corpus sync timestamp). */
export const releaseRoute = async (c: Context<{ Bindings: Env }>) => {
  return c.json(
    {
      release: c.env.APP_RELEASE ?? "unknown",
      session_cookie: "roxabi_session",
    },
    200,
    AUTH_NO_CACHE,
  );
};
