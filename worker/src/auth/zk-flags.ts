import type { Env } from "../types";

/** True when `ZK_ACCOUNT_KEY` env is `1` or `true` (case-insensitive). */
export function zkAccountKeyEnabled(env: Env): boolean {
  const v = env.ZK_ACCOUNT_KEY?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** True when `ZK_STRUCTURE_ONLY` env is `1` or `true` (case-insensitive). */
export function zkStructureOnlyEnabled(env: Env): boolean {
  const v = env.ZK_STRUCTURE_ONLY?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Loudly warn (do NOT crash) when ZK content encryption is on but structure-only
 * sync is off. In that state the cron/webhook still fetch and store plaintext
 * issue titles in D1 — operator-readable — defeating the ZK guarantee
 * (#142/#216). Called once per fetch/scheduled invocation so a misconfigured
 * deploy is visible in Workers Logs immediately rather than at the next cron.
 */
export function assertZkConfigCoherent(env: Env): void {
  if (zkAccountKeyEnabled(env) && !zkStructureOnlyEnabled(env)) {
    console.error(
      "[zk] config: ZK_ACCOUNT_KEY=1 requires ZK_STRUCTURE_ONLY=1 — " +
        "sync will write plaintext issue titles to D1 (operator-readable).",
    );
  }
}