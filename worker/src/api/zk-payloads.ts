/**
 * ZK ciphertext blob store (#142 S2).
 *
 * GET  /api/zk/payloads — list user's sealed issue payloads
 * PUT  /api/zk/payloads — bulk upsert ciphertext (session-gated; seal-before-opt-in OK)
 */

import type { Context } from "hono";
import type { AuthEnv } from "../auth/types";
import { scrubIssuePayloads, userZkOptIn } from "../auth/zk";

const ISSUE_KEY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[0-9]+$/;
const MAX_BULK = 200;
const MAX_CIPHERTEXT_BYTES = 64 * 1024;

interface PayloadRow {
  issue_key: string;
  pubkey_fp: string;
  key_fp: string | null;
  encrypted_payload: string;
  updated_at: string;
}

interface PutEntry {
  issue_key: string;
  pubkey_fp: string;
  key_fp: string;
  encrypted_payload: string;
}

export async function listZkPayloadsRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);

  if (!(await userZkOptIn(c.env.DB, s.userId))) {
    return c.json({ error: "zk_not_enabled" }, 403);
  }

  const rows = await c.env.DB
    .prepare(
      `SELECT issue_key, pubkey_fp, key_fp, encrypted_payload, updated_at
       FROM zk_payloads WHERE user_id = ?`,
    )
    .bind(s.userId)
    .all<PayloadRow>();

  return c.json({ payloads: rows.results });
}

export async function putZkPayloadsRoute(
  c: Context<AuthEnv>,
): Promise<Response> {
  const s = c.get("session");
  if (!s) return c.json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "payloads required" }, 400);
  }

  const payloads =
    body !== null &&
    typeof body === "object" &&
    "payloads" in body &&
    Array.isArray((body as { payloads: unknown }).payloads)
      ? (body as { payloads: unknown[] }).payloads
      : null;

  if (!payloads || payloads.length === 0) {
    return c.json({ error: "payloads required" }, 400);
  }
  if (payloads.length > MAX_BULK) {
    return c.json({ error: `payloads max ${MAX_BULK}` }, 400);
  }

  const entries: PutEntry[] = [];
  for (const raw of payloads) {
    if (raw === null || typeof raw !== "object") {
      return c.json({ error: "invalid payload entry" }, 400);
    }
    const e = raw as Record<string, unknown>;
    const issue_key = e.issue_key;
    const key_fp_raw =
      typeof e.key_fp === "string"
        ? e.key_fp
        : typeof e.pubkey_fp === "string"
          ? e.pubkey_fp
          : null;
    const encrypted_payload = e.encrypted_payload;
    if (typeof issue_key !== "string" || !ISSUE_KEY_RE.test(issue_key)) {
      return c.json({ error: "invalid issue_key" }, 400);
    }
    if (
      typeof key_fp_raw !== "string" ||
      !/^[0-9a-f]{32}$/.test(key_fp_raw)
    ) {
      return c.json({ error: "invalid key_fp" }, 400);
    }
    const key_fp = key_fp_raw;
    const pubkey_fp = key_fp;
    if (
      typeof encrypted_payload !== "string" ||
      encrypted_payload.length === 0 ||
      encrypted_payload.length > MAX_CIPHERTEXT_BYTES
    ) {
      return c.json({ error: "invalid encrypted_payload" }, 400);
    }
    entries.push({ issue_key, pubkey_fp, key_fp, encrypted_payload });
  }

  await c.env.DB.batch(
    entries.map((e) =>
      c.env.DB.prepare(
        `INSERT INTO zk_payloads (user_id, issue_key, pubkey_fp, key_fp, encrypted_payload, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, issue_key) DO UPDATE SET
           pubkey_fp = excluded.key_fp,
           key_fp = excluded.key_fp,
           encrypted_payload = excluded.encrypted_payload,
           updated_at = datetime('now')`,
      ).bind(s.userId, e.issue_key, e.pubkey_fp, e.key_fp, e.encrypted_payload),
    ),
  );

  await scrubIssuePayloads(
    c.env.DB,
    entries.map((e) => e.issue_key),
  );

  return c.json({ upserted: entries.length });
}