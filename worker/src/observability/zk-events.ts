/**
 * ZK audit events → Workers Logs + R2 LOGS bucket (#216 PR 9).
 * Reuses the writeRunAudit pattern from sync.ts — best-effort, never throws.
 */

import type { Env } from "../types";

/** Fields safe to persist in audit logs (no passphrase, keys, or ciphertext). */
export interface ZkAuditEvent {
  event: string;
  user_id: number;
  key_fp?: string;
  backup_version?: number;
  rotation?: boolean;
}

export async function writeZkAudit(
  env: Env,
  event: ZkAuditEvent,
): Promise<void> {
  try {
    const ts = new Date().toISOString();
    const payload = { ts, prefix: "[zk]", ...event };

    console.log(JSON.stringify(payload));

    const bucket = env.LOGS;
    if (!bucket) return;

    const slug = event.event.replace(/\./g, "-");
    const key = `zk/events/${ts.slice(0, 10)}/${ts}-${slug}.json`;
    await bucket.put(key, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
    });
    console.log(`[zk] audit written → ${key}`);
  } catch (err) {
    console.error("[zk] audit write failed (non-fatal):", err);
  }
}