// reset.ts — lost-passphrase recovery: wipe server + local ZK state.
// Port of frontend/zk-reset.js (#216) minus its DOM dialogs (renderResetWarning /
// renderResetExecute → React components in ZkResetDialog.tsx). The pure recovery
// logic — partial-reset guard, local wipe order — is preserved exactly.

import { ApiError, apiFetch } from "@/lib/api";
import type { MePayload } from "@roxabi-live/shared";
import {
  clearDeviceSession,
  clearRememberPassphrase,
  deleteAccountMeta,
  deleteZkKeyPair,
} from "./crypto";
import { clearZkReauthProof, getZkReauthProof } from "./github";
import { clearZkSession } from "./session";

const RESET_PENDING_KEY = "roxabi:zk-reset-pending";

/** Error carrying the server's machine-readable reset failure code. */
export class ZkResetError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ZkResetError";
    this.code = code;
  }
}

export function isZkResetPending(): boolean {
  return sessionStorage.getItem(RESET_PENDING_KEY) === "1";
}

export function setZkResetPending(): void {
  sessionStorage.setItem(RESET_PENDING_KEY, "1");
}

export function clearZkResetPending(): void {
  sessionStorage.removeItem(RESET_PENDING_KEY);
}

/** Drop stale reset intent when OAuth step-up did not yield a proof. */
export function reconcileZkResetPendingAfterReauth(): void {
  if (isZkResetPending() && !getZkReauthProof()) {
    clearZkResetPending();
  }
}

/** Wipe browser key material after server reset. */
export async function clearLocalZkState(githubLogin: string): Promise<boolean> {
  clearZkSession();
  clearZkReauthProof();
  clearZkResetPending();
  let cleanupOk = true;
  try {
    await deleteZkKeyPair(githubLogin);
  } catch (e) {
    cleanupOk = false;
    console.warn("[zk] deleteZkKeyPair failed — clear site data manually", e);
  }
  try {
    await deleteAccountMeta(githubLogin);
  } catch (e) {
    cleanupOk = false;
    console.warn("[zk] deleteAccountMeta failed — clear site data manually", e);
  }
  try {
    await clearDeviceSession(githubLogin);
  } catch (e) {
    cleanupOk = false;
    console.warn("[zk] clearDeviceSession failed — clear site data manually", e);
  }
  try {
    await clearRememberPassphrase(githubLogin);
  } catch (e) {
    cleanupOk = false;
    console.warn("[zk] clearRememberPassphrase failed — clear site data manually", e);
  }
  return cleanupOk;
}

async function postZkReset(): Promise<unknown> {
  const reauth_proof = getZkReauthProof();
  if (!reauth_proof) throw new ZkResetError("reauth_required", "reauth_required");
  let data: unknown;
  try {
    data = await apiFetch<unknown>("/api/zk/reset", {
      method: "POST",
      body: { reauth_proof },
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const code =
        err.body && typeof err.body === "object" && "error" in err.body
          ? String((err.body as { error: unknown }).error)
          : undefined;
      throw new ZkResetError(code ?? "reset_failed", code);
    }
    throw err;
  }
  clearZkReauthProof();
  return data;
}

/** If server already wiped enrollment, treat reset as complete locally. */
export async function recoverFromPartialZkReset(githubLogin: string): Promise<boolean> {
  try {
    const me = await apiFetch<MePayload>("/api/me");
    if (me?.user?.zk_enrolled === false) {
      await clearLocalZkState(githubLogin);
      window.location.reload();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Full reset: server purge + local wipe, then reload into the enroll gate. */
export async function resetZkAccountAndReenroll(githubLogin: string): Promise<void> {
  try {
    await postZkReset();
  } catch (err) {
    // `reauth_required` is a pre-network guard — nothing was wiped server-side,
    // so never run partial-reset recovery (it would wipe local keys / lock out
    // the user on a merely-expired proof). Only genuine partial-reset signals
    // (network error / 5xx / reset_failed) may trigger recovery.
    const code = err instanceof ZkResetError ? err.code : undefined;
    const message = err instanceof Error ? err.message : "";
    if (code !== "reauth_required" && message !== "reauth_required") {
      if (await recoverFromPartialZkReset(githubLogin)) return;
    }
    throw err;
  }
  await clearLocalZkState(githubLogin);
  window.location.reload();
}
