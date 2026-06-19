/**
 * OAuth step-up re-auth for zk_key_backups UPDATE (#216 PR 2).
 */

import type { Env } from "../types";

const REAUTH_TTL_MINUTES = 5;
const MAX_CONSUME_PER_HOUR = 10;
const CODE_RE = /^[0-9a-f]{32}$/;

function currentHourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

function parseCount(value: string | null | undefined, hourKey: string): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as { hour?: string; count?: number };
    if (parsed.hour !== hourKey) return 0;
    return typeof parsed.count === "number" ? parsed.count : 0;
  } catch {
    return 0;
  }
}

/** Rate limit POST /api/zk/consume-reauth (defense in depth). */
export async function isConsumeReauthRateLimited(db: D1Database, userId: number): Promise<boolean> {
  const hourKey = currentHourKey();
  const rowKey = `zk_reauth_consume:${userId}`;
  const row = await db
    .prepare("SELECT value FROM sync_control WHERE tenant_id = 0 AND key = ?")
    .bind(rowKey)
    .first<{ value: string }>();
  return parseCount(row?.value, hourKey) >= MAX_CONSUME_PER_HOUR;
}

/**
 * Atomically increment the consume-reauth counter for the current hour.
 * A single INSERT … ON CONFLICT DO UPDATE performs the read-modify-write in
 * one SQL statement, preventing lost increments under concurrent isolates.
 */
export async function recordConsumeReauthSuccess(db: D1Database, userId: number): Promise<void> {
  const hourKey = currentHourKey();
  const rowKey = `zk_reauth_consume:${userId}`;
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

function reauthCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createZkReauthCode(env: Env, userId: number): Promise<string> {
  const code = reauthCode();
  await env.DB.prepare(
    `INSERT INTO zk_reauth_proofs (code, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${REAUTH_TTL_MINUTES} minutes'))`,
  )
    .bind(code, userId)
    .run();
  return code;
}

/** Validates code for session user; returns same code as opaque reauth_proof. */
export async function issueReauthProof(
  env: Env,
  userId: number,
  code: string,
): Promise<string | null> {
  if (!CODE_RE.test(code)) return null;
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM zk_reauth_proofs
     WHERE code = ? AND user_id = ? AND expires_at > datetime('now')`,
  )
    .bind(code, userId)
    .first<{ ok: number }>();
  return row ? code : null;
}

/** Single-use consume on backup PUT — deletes proof row. */
export async function consumeReauthProof(
  env: Env,
  userId: number,
  proof: string,
): Promise<boolean> {
  if (!CODE_RE.test(proof)) return false;
  const row = await env.DB.prepare(
    `DELETE FROM zk_reauth_proofs
     WHERE code = ? AND user_id = ? AND expires_at > datetime('now')
     RETURNING code`,
  )
    .bind(proof, userId)
    .first<{ code: string }>();
  return row != null;
}
