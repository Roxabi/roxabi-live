// enroll.ts — passphrase enroll / unlock / auto-unlock / lock building blocks.
// Port of frontend/zk-enroll.js (#216 PR 4) minus its imperative DOM gates
// (showEnrollGate / showUnlockGate / requireZkEnrollmentGate). Those become the
// declarative React gate (ZkGate.tsx); here we keep the async key-backup +
// single-flight auto-unlock + remember/migration logic exactly. The imperative
// `updateLockButton()` calls are replaced by `notifyZk()` store broadcasts.

import { apiFetch } from "@/lib/api";
import type { ZkKeyBackup } from "@roxabi-live/shared";
import {
  REMEMBER_PASSPHRASE_PREF_KEY,
  clearDeviceSession,
  clearRememberPassphrase,
  generateAccountKey,
  hasRememberPassphrase,
  hasZkKeyPair,
  loadDeviceSession,
  loadRememberPassphrase,
  parseEnvelopeVersion,
  saveAccountMeta,
  saveDeviceSession,
  saveRememberPassphrase,
  sessionAccountKey,
  unwrapAccountKey,
  wrapAccountKey,
} from "./crypto";
import { clearZkReauthProof, getZkReauthProof } from "./github";
import { clearZkSession, isZkUnlocked, setZkRememberMode, setZkSession } from "./session";
import {
  fetchZkPayloadRows,
  invalidateZkPayloadCache,
  migrateV1PayloadsToAccountKey,
} from "./sync";
import { notifyZk } from "./zkStore";

let keyBackupInflight: Promise<ZkKeyBackup> | null = null;
let keyBackupCache: ZkKeyBackup | null = null;
let zkUnlockInFlight: Promise<boolean> | null = null;

// True once enroll succeeds in this tab — so a same-session Lock routes to the
// unlock gate, not back to enroll (the cached /api/me still says not-enrolled
// until a refetch). Mirrors legacy requireZkEnrollmentGate, which never
// re-checks zk_enrolled after the gate resolves.
let enrolledThisSession = false;

export function hasEnrolledThisSession(): boolean {
  return enrolledThisSession;
}

function invalidateKeyBackupCache(): void {
  keyBackupCache = null;
  keyBackupInflight = null;
}

// biome-ignore lint/suspicious/noExplicitAny: structured zk log payloads
function zkLog(event: string, extra: Record<string, any> = {}): void {
  console.info("[zk]", { event, ...extra });
}

export function isZkRememberPreferred(): boolean {
  return localStorage.getItem(REMEMBER_PASSPHRASE_PREF_KEY) === "1";
}

export function setZkRememberPreferred(on: boolean): void {
  localStorage.setItem(REMEMBER_PASSPHRASE_PREF_KEY, on ? "1" : "0");
}

export async function applyZkRememberChoice(
  githubLogin: string,
  passphrase: string,
  remember: boolean,
): Promise<void> {
  if (remember) {
    await saveRememberPassphrase(githubLogin, passphrase);
    setZkRememberMode(true);
    localStorage.setItem(REMEMBER_PASSPHRASE_PREF_KEY, "1");
  } else {
    await clearRememberPassphrase(githubLogin);
    setZkRememberMode(false);
    localStorage.setItem(REMEMBER_PASSPHRASE_PREF_KEY, "0");
  }
}

async function syncZkRememberMode(githubLogin: string): Promise<void> {
  const remembered =
    localStorage.getItem(REMEMBER_PASSPHRASE_PREF_KEY) === "1" ||
    (await hasRememberPassphrase(githubLogin));
  if (remembered) setZkRememberMode(true);
}

export async function fetchKeyBackup(): Promise<ZkKeyBackup> {
  if (keyBackupCache) return keyBackupCache;
  if (keyBackupInflight) return keyBackupInflight;
  keyBackupInflight = apiFetch<ZkKeyBackup>("/api/zk/key-backup")
    .then((data) => {
      keyBackupCache = data;
      keyBackupInflight = null;
      return data;
    })
    .catch((err) => {
      keyBackupInflight = null;
      throw err;
    });
  return keyBackupInflight;
}

async function putKeyBackup<T>(body: unknown): Promise<T> {
  const result = await apiFetch<T>("/api/zk/key-backup", {
    method: "PUT",
    body,
  });
  invalidateKeyBackupCache();
  return result;
}

/**
 * PUT backup update (passphrase change or rotation) — attaches OAuth reauth_proof
 * from sessionStorage after /login?reauth=1 flow.
 */
export async function updateKeyBackup<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const reauth_proof = getZkReauthProof();
  if (!reauth_proof) {
    throw new Error("reauth_required");
  }
  const result = await putKeyBackup<T>({ ...body, reauth_proof });
  clearZkReauthProof();
  return result;
}

export function payloadsHaveV1(payloads: Array<{ encrypted_payload: string }>): boolean {
  for (const row of payloads ?? []) {
    if (parseEnvelopeVersion(row.encrypted_payload) === 1) return true;
  }
  return false;
}

export async function fetchPayloadRows(): Promise<Array<{ encrypted_payload: string }>> {
  try {
    return await fetchZkPayloadRows();
  } catch {
    return [];
  }
}

/** v1→v2 migration must never block unlock — a network error used to surface as "wrong passphrase". */
async function runBestEffortV1Migration(
  githubLogin: string,
  accountKey: CryptoKey,
  key_fp: string,
): Promise<void> {
  if (!githubLogin) return;
  try {
    const payloads = await fetchPayloadRows();
    if (payloadsHaveV1(payloads) && (await hasZkKeyPair(githubLogin))) {
      await migrateV1PayloadsToAccountKey(githubLogin, accountKey, key_fp);
    }
  } catch (err) {
    zkLog("zk.migrate.v1_to_v2.deferred", { error: String((err as Error)?.message ?? err) });
  }
}

/** Restore from device session or remembered passphrase — at most one GET key-backup. */
async function tryAutoUnlockZkInner(githubLogin: string): Promise<boolean> {
  if (isZkUnlocked()) return true;

  let backup: ZkKeyBackup;
  try {
    backup = await fetchKeyBackup();
  } catch {
    return false;
  }

  const local = await loadDeviceSession(githubLogin);
  if (local?.accountKey && local.key_fp === backup.key_fp) {
    setZkSession(local.accountKey, local.key_fp);
    await syncZkRememberMode(githubLogin);
    zkLog("zk.device.restore", { key_fp: local.key_fp });
    notifyZk();
    return true;
  }
  if (local?.key_fp && local.key_fp !== backup.key_fp) {
    await clearDeviceSession(githubLogin);
    zkLog("zk.device.stale", { local_fp: local.key_fp, server_fp: backup.key_fp });
  }

  const pass = await loadRememberPassphrase(githubLogin);
  if (!pass) return false;

  const t0 = performance.now();
  try {
    const accountKey = await unwrapAccountKey(pass, backup);
    const session = await sessionAccountKey(accountKey);
    setZkSession(session, backup.key_fp);
    if (githubLogin) {
      await saveDeviceSession(githubLogin, accountKey, backup.key_fp);
      await runBestEffortV1Migration(githubLogin, accountKey, backup.key_fp);
    }
    setZkRememberMode(true);
    zkLog("zk.unlock.success", {
      key_fp: backup.key_fp,
      kdf_duration_ms: Math.round(performance.now() - t0),
      remember: true,
    });
    notifyZk();
    return true;
  } catch {
    clearZkSession();
    await clearRememberPassphrase(githubLogin);
    setZkRememberMode(false);
    zkLog("zk.unlock.failure");
    return false;
  }
}

export async function tryAutoUnlockZk(githubLogin: string): Promise<boolean> {
  if (isZkUnlocked()) return true;
  if (zkUnlockInFlight) return zkUnlockInFlight;
  zkUnlockInFlight = tryAutoUnlockZkInner(githubLogin).finally(() => {
    zkUnlockInFlight = null;
  });
  return zkUnlockInFlight;
}

/**
 * Enroll: generate accountKey and upload wrapped backup.
 * Caller should run ensureAccountKeySealing after the gate resolves.
 */
export async function enrollAccountKey(
  passphrase: string,
  githubLogin: string,
): Promise<{ key_fp: string; migrated: number }> {
  const t0 = performance.now();
  const accountKey = await generateAccountKey();
  const wrapped = await wrapAccountKey(passphrase, accountKey);
  await putKeyBackup(wrapped);
  const session = await sessionAccountKey(accountKey);
  await saveAccountMeta(githubLogin, {
    key_fp: wrapped.key_fp,
    enrolled_at: new Date().toISOString(),
  });

  const migrated = await migrateV1PayloadsToAccountKey(githubLogin, session, wrapped.key_fp);

  await saveDeviceSession(githubLogin, accountKey, wrapped.key_fp);
  setZkSession(session, wrapped.key_fp);
  enrolledThisSession = true;
  zkLog("zk.enroll.success", {
    key_fp: wrapped.key_fp,
    kdf_duration_ms: Math.round(performance.now() - t0),
    migrated,
  });
  notifyZk();
  return { key_fp: wrapped.key_fp, migrated };
}

export async function unlockAccountKey(
  passphrase: string,
  githubLogin: string,
): Promise<{ key_fp: string }> {
  const t0 = performance.now();
  const backup = await fetchKeyBackup();
  let accountKey: CryptoKey;
  try {
    accountKey = await unwrapAccountKey(passphrase, backup);
  } catch (err) {
    clearZkSession();
    zkLog("zk.unlock.failure");
    throw err;
  }
  const session = await sessionAccountKey(accountKey);
  setZkSession(session, backup.key_fp);
  if (githubLogin) {
    try {
      await saveDeviceSession(githubLogin, accountKey, backup.key_fp);
    } catch (err) {
      zkLog("zk.device.save.deferred", { error: String((err as Error)?.message ?? err) });
    }
    await runBestEffortV1Migration(githubLogin, accountKey, backup.key_fp);
  }
  zkLog("zk.unlock.success", {
    key_fp: backup.key_fp,
    kdf_duration_ms: Math.round(performance.now() - t0),
  });
  notifyZk();
  return { key_fp: backup.key_fp };
}

/** Explicit lock: clear in-memory key + remembered material, then re-broadcast. */
export function lockZkSession(githubLogin: string): void {
  if (!isZkUnlocked()) return;
  clearZkSession();
  setZkRememberMode(false);
  if (githubLogin) {
    clearDeviceSession(githubLogin).catch(() => {});
    clearRememberPassphrase(githubLogin).catch(() => {});
  }
  zkLog("zk.lock.explicit");
  notifyZk();
}

/** Drop the cached key-backup + payload rows (post passphrase-change / reset). */
export function invalidateZkCaches(): void {
  invalidateKeyBackupCache();
  invalidateZkPayloadCache();
}
