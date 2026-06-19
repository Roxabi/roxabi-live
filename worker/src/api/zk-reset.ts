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

function resetHourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

function parseResetCount(value: string | null | undefined, hourKey: string): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as { hour?: string; count?: number };
    if (parsed.hour !== hourKey) return 0;
    return typeof parsed.count === "number" ? parsed.count : 0;
  } catch {
    return 0;
  }
}

async function isResetRateLimited(
  db: D1Database,
  userId: number,
): Promise<boolean> {
  const hourKey = resetHourKey();
  const rowKey = `zk_reset:${userId}`;
  const row = await db
    .prepare(`SELECT value FROM sync_control WHERE tenant_id = 0 AND key = ?`)
    .bind(rowKey)
    .first<{ value: string }>();
  return parseResetCount(row?.value, hourKey) >= MAX_RESET_PER_HOUR;
}

/**
 * Atomically increment the reset counter for the current hour.
 * A single INSERT … ON CONFLICT DO UPDATE performs the read-modify-write in
 * one SQL statement, preventing lost increments under concurrent isolates.
 */
async function recordResetSuccess(
  db: D1Database,
  userId: number,
): Promise<void> {
  const hourKey = resetHourKey();
  const rowKey = `zk_reset:${userId}`;
  await db
    .prepare(
      `INSERT INTO sync_control (tenant_id, key, value, updated_at)
       VALUES (0, ?, json_object('hour', ?, 'count', 1), datetime('now'))
       ON CONFLICT(tenant_id, key) DO UPDATE SET
         value = CASE
           WHEN json_extract(value, '$.hour') = ?
           THEN json_object('hour', ?,
                  'count', CAST(json_extract(value, '$.count') AS INTEGER) + 1)
           ELSE json_object('hour', ?, 'count', 1)
         END,
         updated_at = datetime('now')`,
    )
    .bind(rowKey, hourKey, hourKey, hourKey, hourKey)
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

  const proof = await issueReauthProof(c.env, s.userId, reauth_proof);
  if (!proof) {
    return c.json({ error: "reauth_required" }, 403);
  }

  if (!(await consumeReauthProof(c.env, s.userId, reauth_proof))) {
    return c.json({ error: "reauth_required" }, 403);
  }

  const stats = await purgeUserZkData(c.env.DB, s.userId);

  await recordResetSuccess(c.env.DB, s.userId);
  await writeZkAudit(c.env, {
    event: "zk.account.reset",
    user_id: s.userId,
  });

  return c.json({ ok: true, ...stats });
}