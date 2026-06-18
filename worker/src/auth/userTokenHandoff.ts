/**
 * Ephemeral GitHub user-token handoff (#142 S3).
 *
 * OAuth callback encrypts the user access_token into user_token_handoffs;
 * the browser consumes it once via POST /api/zk/consume-handoff.
 * Never logs plaintext tokens.
 */

import type { Env } from "../types";
import { encryptToken, importDek, decryptToken } from "./tokenCrypto";

const HANDOFF_TTL_MINUTES = 5;

function handoffCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getDek(env: Env): Promise<CryptoKey> {
  const b64 = env.INSTALL_TOKEN_KEY;
  if (!b64) {
    throw new Error("INSTALL_TOKEN_KEY not configured");
  }
  return importDek(b64);
}

export async function createUserTokenHandoff(
  env: Env,
  userId: number,
  plaintextToken: string,
): Promise<string> {
  const dek = await getDek(env);
  const { enc, iv } = await encryptToken(dek, plaintextToken);
  const code = handoffCode();

  await env.DB.prepare(
    `INSERT INTO user_token_handoffs (code, user_id, token_enc, token_iv, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+${HANDOFF_TTL_MINUTES} minutes'))`,
  )
    .bind(code, userId, enc, iv)
    .run();

  return code;
}

export async function consumeUserTokenHandoff(
  env: Env,
  userId: number,
  code: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `DELETE FROM user_token_handoffs
     WHERE code = ? AND user_id = ? AND expires_at > datetime('now')
     RETURNING token_enc, token_iv`,
  )
    .bind(code, userId)
    .first<{ token_enc: string; token_iv: string }>();

  if (!row) return null;

  const dek = await getDek(env);
  return decryptToken(dek, row.token_enc, row.token_iv);
}