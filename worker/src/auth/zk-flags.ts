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