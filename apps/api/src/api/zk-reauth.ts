/**
 * POST /api/zk/consume-reauth — validate OAuth step-up code (#216 PR 2).
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { zkAccountKeyEnabled } from "../auth/zk-flags";
import {
  isConsumeReauthRateLimited,
  issueReauthProof,
  recordConsumeReauthSuccess,
} from "../auth/zk-reauth";

const CODE_RE = /^[0-9a-f]{32}$/;

export async function consumeZkReauthRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);
  if (!zkAccountKeyEnabled(c.env)) {
    return c.json({ error: "zk_account_key_disabled" }, 403);
  }
  if (await isConsumeReauthRateLimited(c.env.DB, s.userId)) {
    return c.json({ error: "rate_limited" }, 429);
  }

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

  const proof = await issueReauthProof(c.env, s.userId, code);
  if (!proof) {
    return c.json({ error: "reauth_expired" }, 410);
  }

  await recordConsumeReauthSuccess(c.env.DB, s.userId);
  return c.json({ reauth_proof: proof });
}
