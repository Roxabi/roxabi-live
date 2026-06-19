/**
 * POST /api/zk/reset — wipe user ZK state after lost passphrase (#216).
 * Requires OAuth step-up reauth_proof. Irreversible; user must re-enroll.
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { zkAccountKeyEnabled } from "../auth/zk-flags";
import { consumeReauthProof, issueReauthProof } from "../auth/zk-reauth";
import { loadZkSealedIssueKeys, scrubIssuePayloads } from "../auth/zk";
import { writeZkAudit } from "../observability/zk-events";

const REAUTH_PROOF_RE = /^[0-9a-f]{32}$/;
const MAX_RESET_PER_HOUR = 3;

async function readResetCount(
  db: D1Database,
  userId: number,
): Promise<{ hourKey: string; count: number }> {
  const hourKey = new Date().toISOString().slice(0, 13);
  const rowKey = `zk_reset:${userId}`;
  const row = await db
    .prepare(`SELECT value FROM sync_control WHERE tenant_id = 0 AND key = ?`)
    .bind(rowKey)
    .first<{ value: string }>();

  let count = 0;
  let storedHour = hourKey;
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as { hour?: string; count?: number };
      storedHour = parsed.hour ?? hourKey;
      count = typeof parsed.count === "number" ? parsed.count : 0;
    } catch {
      count = 0;
    }
  }
  if (storedHour !== hourKey) count = 0;
  return { hourKey, count };
}

async function isResetRateLimited(
  db: D1Database,
  userId: number,
): Promise<boolean> {
  const { count } = await readResetCount(db, userId);
  return count >= MAX_RESET_PER_HOUR;
}

async function recordResetSuccess(
  db: D1Database,
  userId: number,
): Promise<void> {
  const { hourKey, count } = await readResetCount(db, userId);
  const rowKey = `zk_reset:${userId}`;
  await db
    .prepare(
      `INSERT INTO sync_control (tenant_id, key, value, updated_at)
       VALUES (0, ?, ?, datetime('now'))
       ON CONFLICT(tenant_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`,
    )
    .bind(rowKey, JSON.stringify({ hour: hourKey, count: count + 1 }))
    .run();
}

/** Delete all ZK rows for user; scrub issues no longer sealed by anyone. */
export async function purgeUserZkData(
  db: D1Database,
  userId: number,
): Promise<{ payloads_deleted: number; issues_scrubbed: number }> {
  const keyRows = await db
    .prepare(`SELECT DISTINCT issue_key FROM zk_payloads WHERE user_id = ?`)
    .bind(userId)
    .all<{ issue_key: string }>();
  const affectedKeys = (keyRows.results ?? []).map((r) => r.issue_key);

  const payloadCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM zk_payloads WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();

  await db.batch([
    db.prepare(`DELETE FROM zk_payloads WHERE user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM zk_key_backups WHERE user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM zk_reauth_proofs WHERE user_id = ?`).bind(userId),
    db.prepare(`DELETE FROM user_token_handoffs WHERE user_id = ?`).bind(userId),
  ]);

  const stillSealed = await loadZkSealedIssueKeys(db);
  const toScrub = affectedKeys.filter((k) => !stillSealed.has(k));
  await scrubIssuePayloads(db, toScrub);

  return {
    payloads_deleted: payloadCount?.n ?? 0,
    issues_scrubbed: toScrub.length,
  };
}

export async function postZkResetRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);
  if (!zkAccountKeyEnabled(c.env)) {
    return c.json({ error: "zk_account_key_disabled" }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }

  if (body === null || typeof body !== "object") {
    return c.json({ error: "invalid body" }, 400);
  }

  const reauth_proof = (body as Record<string, unknown>).reauth_proof;
  if (typeof reauth_proof !== "string" || !REAUTH_PROOF_RE.test(reauth_proof)) {
    return c.json({ error: "reauth_required" }, 403);
  }

  if (await isResetRateLimited(c.env.DB, s.userId)) {
    return c.json({ error: "rate_limited" }, 429);
  }

  if (!(await issueReauthProof(c.env, s.userId, reauth_proof))) {
    return c.json({ error: "reauth_required" }, 403);
  }

  const stats = await purgeUserZkData(c.env.DB, s.userId);

  if (!(await consumeReauthProof(c.env, s.userId, reauth_proof))) {
    return c.json({ error: "reauth_required" }, 403);
  }

  await recordResetSuccess(c.env.DB, s.userId);
  await writeZkAudit(c.env, {
    event: "zk.account.reset",
    user_id: s.userId,
  });

  return c.json({ ok: true, ...stats });
}