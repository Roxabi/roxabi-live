/**
 * POST /api/account/delete — wipe all per-user Roxabi data and sign out.
 * When a zk_key_backups row exists, requires OAuth step-up reauth_proof (#216).
 */

import type { Context } from "hono";
import { AUTH_NO_CACHE, clearSessionCookieHeaders, readSessionToken } from "../auth/cookies";
import { deleteSession } from "../auth/session";
import type { AuthEnv } from "../auth/types";
import { zkAccountKeyEnabled } from "../auth/zk-flags";
import { consumeReauthProof, issueReauthProof } from "../auth/zk-reauth";
import { writeZkAudit } from "../observability/zk-events";
import { purgeUserZkData } from "./zk-reset";

const REAUTH_PROOF_RE = /^[0-9a-f]{32}$/;

export interface AccountDeleteStats {
  zk_payloads_deleted: number;
  issues_scrubbed: number;
}

/** Remove all Roxabi-owned rows for a user (keeps users.github identity for re-login). */
export async function purgeUserAccountData(
  db: D1Database,
  userId: number,
): Promise<AccountDeleteStats> {
  const zkStats = await purgeUserZkData(db, userId);

  await db.batch([
    db.prepare("DELETE FROM user_installations WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM zk_reauth_proofs WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db
      .prepare(
        `UPDATE users SET consent_at = NULL, install_targets_json = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(userId),
  ]);

  return {
    zk_payloads_deleted: zkStats.payloads_deleted,
    issues_scrubbed: zkStats.issues_scrubbed,
  };
}

export async function postAccountDeleteRoute(c: Context<AuthEnv>): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);

  const backupRow = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM zk_key_backups WHERE user_id = ? LIMIT 1",
  )
    .bind(s.userId)
    .first<{ ok: number }>();

  const needsReauth = zkAccountKeyEnabled(c.env) && backupRow != null;

  let body: unknown = {};
  if (needsReauth) {
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const reauth_proof = (body as Record<string, unknown>).reauth_proof;
    if (typeof reauth_proof !== "string" || !REAUTH_PROOF_RE.test(reauth_proof)) {
      return c.json({ error: "reauth_required" }, 403);
    }
    if (!(await issueReauthProof(c.env, s.userId, reauth_proof))) {
      return c.json({ error: "reauth_required" }, 403);
    }
    if (!(await consumeReauthProof(c.env, s.userId, reauth_proof))) {
      return c.json({ error: "reauth_required" }, 403);
    }
  }

  const stats = await purgeUserAccountData(c.env.DB, s.userId);

  const raw = readSessionToken(c);
  if (raw) {
    await deleteSession(c.env.DB, raw);
  }

  await writeZkAudit(c.env, {
    event: "account.delete",
    user_id: s.userId,
  });

  const headers = new Headers({
    "Content-Type": "application/json",
    "Clear-Site-Data": '"cache", "cookies", "storage"',
    ...AUTH_NO_CACHE,
  });
  for (const cookie of clearSessionCookieHeaders()) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(JSON.stringify({ ok: true, ...stats }), { status: 200, headers });
}
