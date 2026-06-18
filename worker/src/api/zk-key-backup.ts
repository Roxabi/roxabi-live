/**
 * GET/PUT /api/zk/key-backup — passphrase-wrapped accountKey (#216 PR 2).
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { consumeReauthProof } from "../auth/zk-reauth";

const KEY_FP_RE = /^[0-9a-f]{8,64}$/;
const MAX_WRAPPED_BYTES = 8 * 1024;
const MAX_PUT_PER_HOUR = 5;

interface BackupRow {
  backup_version: number;
  kdf_alg: string;
  kdf_params: string;
  wrap_iv: string;
  wrapped_key: string;
  key_fp: string;
  created_at: string;
  updated_at: string;
}

async function checkBackupPutRateLimit(
  db: D1Database,
  userId: number,
): Promise<boolean> {
  const hourKey = new Date().toISOString().slice(0, 13);
  const rowKey = `zk_backup_put:${userId}`;
  const row = await db
    .prepare(
      `SELECT value FROM sync_control WHERE tenant_id = 0 AND key = ?`,
    )
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

  if (storedHour !== hourKey) {
    count = 0;
  }
  if (count >= MAX_PUT_PER_HOUR) {
    return false;
  }

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

  return true;
}

function logBackupEvent(
  event: string,
  userId: number,
  keyFp: string,
  backupVersion: number,
  rotation: boolean,
): void {
  console.log(
    JSON.stringify({
      prefix: "[zk]",
      event,
      user_id: userId,
      key_fp: keyFp,
      backup_version: backupVersion,
      rotation,
    }),
  );
}

export async function getZkKeyBackupRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);

  const row = await c.env.DB
    .prepare(
      `SELECT backup_version, kdf_alg, kdf_params, wrap_iv, wrapped_key, key_fp,
              created_at, updated_at
       FROM zk_key_backups WHERE user_id = ?`,
    )
    .bind(s.userId)
    .first<BackupRow>();

  if (!row) {
    return c.json({ error: "not_enrolled" }, 404);
  }

  return c.json({
    backup_version: row.backup_version,
    kdf_alg: row.kdf_alg,
    kdf_params: row.kdf_params,
    wrap_iv: row.wrap_iv,
    wrapped_key: row.wrapped_key,
    key_fp: row.key_fp,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export async function putZkKeyBackupRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);

  if (!(await checkBackupPutRateLimit(c.env.DB, s.userId))) {
    return c.json({ error: "rate_limited" }, 429);
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

  const b = body as Record<string, unknown>;
  const key_fp = b.key_fp;
  const kdf_params = b.kdf_params;
  const wrap_iv = b.wrap_iv;
  const wrapped_key = b.wrapped_key;
  const kdf_alg =
    typeof b.kdf_alg === "string" && b.kdf_alg.length > 0
      ? b.kdf_alg
      : "argon2id";
  const rotation = b.rotation === true;
  const reauth_proof =
    typeof b.reauth_proof === "string" ? b.reauth_proof : null;
  const expected_backup_version =
    typeof b.expected_backup_version === "number"
      ? b.expected_backup_version
      : typeof b.backup_version === "number"
        ? b.backup_version
        : null;

  if (typeof key_fp !== "string" || !KEY_FP_RE.test(key_fp)) {
    return c.json({ error: "invalid key_fp" }, 400);
  }
  if (typeof kdf_params !== "string" || kdf_params.length === 0 || kdf_params.length > 512) {
    return c.json({ error: "invalid kdf_params" }, 400);
  }
  if (typeof wrap_iv !== "string" || wrap_iv.length === 0 || wrap_iv.length > 256) {
    return c.json({ error: "invalid wrap_iv" }, 400);
  }
  if (
    typeof wrapped_key !== "string" ||
    wrapped_key.length === 0 ||
    wrapped_key.length > MAX_WRAPPED_BYTES
  ) {
    return c.json({ error: "invalid wrapped_key" }, 400);
  }

  const existing = await c.env.DB
    .prepare(
      `SELECT backup_version, key_fp FROM zk_key_backups WHERE user_id = ?`,
    )
    .bind(s.userId)
    .first<{ backup_version: number; key_fp: string }>();

  if (!existing) {
    if (expected_backup_version != null && expected_backup_version !== 1) {
      return c.json({ error: "backup_version_conflict" }, 409);
    }
    await c.env.DB
      .prepare(
        `INSERT INTO zk_key_backups
         (user_id, backup_version, kdf_alg, kdf_params, wrap_iv, wrapped_key, key_fp)
         VALUES (?, 1, ?, ?, ?, ?, ?)`,
      )
      .bind(s.userId, kdf_alg, kdf_params, wrap_iv, wrapped_key, key_fp)
      .run();
    logBackupEvent("zk.backup.enrolled", s.userId, key_fp, 1, false);
    return c.json({ backup_version: 1, key_fp });
  }

  if (!reauth_proof) {
    return c.json({ error: "reauth_required" }, 403);
  }
  if (!(await consumeReauthProof(c.env, s.userId, reauth_proof))) {
    return c.json({ error: "reauth_required" }, 403);
  }

  if (rotation) {
    if (expected_backup_version == null) {
      return c.json({ error: "backup_version_conflict" }, 409);
    }
    if (expected_backup_version !== existing.backup_version) {
      return c.json({ error: "backup_version_conflict" }, 409);
    }
    const nextVersion = existing.backup_version + 1;
    await c.env.DB
      .prepare(
        `UPDATE zk_key_backups SET
           backup_version = ?,
           kdf_alg = ?,
           kdf_params = ?,
           wrap_iv = ?,
           wrapped_key = ?,
           key_fp = ?,
           updated_at = datetime('now')
         WHERE user_id = ?`,
      )
      .bind(
        nextVersion,
        kdf_alg,
        kdf_params,
        wrap_iv,
        wrapped_key,
        key_fp,
        s.userId,
      )
      .run();
    logBackupEvent("zk.backup.rotated", s.userId, key_fp, nextVersion, true);
    return c.json({ backup_version: nextVersion, key_fp });
  }

  if (key_fp !== existing.key_fp) {
    return c.json({ error: "enrolled" }, 409);
  }

  if (expected_backup_version == null) {
    return c.json({ error: "backup_version_conflict" }, 409);
  }
  if (expected_backup_version !== existing.backup_version) {
    return c.json({ error: "backup_version_conflict" }, 409);
  }

  const nextVersion = existing.backup_version + 1;
  await c.env.DB
    .prepare(
      `UPDATE zk_key_backups SET
         backup_version = ?,
         kdf_alg = ?,
         kdf_params = ?,
         wrap_iv = ?,
         wrapped_key = ?,
         updated_at = datetime('now')
       WHERE user_id = ?`,
    )
    .bind(
      nextVersion,
      kdf_alg,
      kdf_params,
      wrap_iv,
      wrapped_key,
      s.userId,
    )
    .run();
  logBackupEvent("zk.backup.updated", s.userId, key_fp, nextVersion, false);
  return c.json({ backup_version: nextVersion, key_fp });
}