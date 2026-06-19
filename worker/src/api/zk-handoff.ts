/**
 * POST /api/zk/consume-handoff — one-time GitHub user-token delivery (#142 S3).
 *
 * Body: { code: string }
 * Returns: { github_token: string }
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { consumeUserTokenHandoff } from "../auth/userTokenHandoff";

const CODE_RE = /^[0-9a-f]{32}$/;

export async function consumeZkHandoffRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "code required" }, 400);
  }

  const code =
    body !== null &&
    typeof body === "object" &&
    "code" in body &&
    typeof (body as { code: unknown }).code === "string"
      ? (body as { code: string }).code
      : null;

  if (!code || !CODE_RE.test(code)) {
    return c.json({ error: "invalid code" }, 400);
  }

  try {
    const github_token = await consumeUserTokenHandoff(c.env, s.userId, code);
    if (!github_token) {
      return c.json({ error: "handoff_expired" }, 410);
    }
    return c.json({ github_token });
  } catch {
    return c.json({ error: "handoff_unavailable" }, 503);
  }
}
