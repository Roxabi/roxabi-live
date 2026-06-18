/**
 * OAuth step-up re-auth for zk_key_backups UPDATE (#216 PR 2).
 */

import type { Env } from "../types";

const REAUTH_TTL_MINUTES = 5;
const CODE_RE = /^[0-9a-f]{32}$/;

function reauthCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createZkReauthCode(
  env: Env,
  userId: number,
): Promise<string> {
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