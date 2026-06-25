/**
 * ZkSessionProvider — mounts once inside AuthGate's ready branch. Responsibilities
 * (ported from the imperative wiring in frontend/app.js init + zk-enroll.js
 * requireZkEnrollmentGate):
 *
 *  - wireIdleLock() / wirePageHideLock() — 15-min idle + BFCache pagehide locks.
 *  - register the session handlers → notifyZk() so React re-renders on every
 *    lock-state transition (unlock / enroll / device restore / idle lock).
 *  - on BFCache restore, attempt a silent device/remember auto-unlock.
 *  - consume ?zk_handoff= / ?zk_reauth= from the URL and reconcile a pending
 *    reset BEFORE the gate decides what to show (urlConsumed flag).
 *
 * The accountKey itself never enters React — only booleans cross via zkStore.
 */

import { useAuth } from "@/auth/AuthContext";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { tryAutoUnlockZk } from "./enroll";
import { consumeZkHandoffFromUrl, consumeZkReauthFromUrl } from "./github";
import { reconcileZkResetPendingAfterReauth } from "./reset";
import {
  isZkUnlocked,
  setZkAutoLockHandler,
  setZkPageRestoreHandler,
  setZkSessionReadyHandler,
  wireIdleLock,
  wirePageHideLock,
} from "./session";
import { type ZkSnapshot, getZkSnapshot, notifyZk, subscribeZk } from "./zkStore";

interface ZkRuntime {
  githubLogin: string;
  zkAccountKeyEnabled: boolean;
  /** True once URL handoff/reauth params have been consumed (gate may proceed). */
  urlConsumed: boolean;
}

const ZkRuntimeContext = createContext<ZkRuntime | null>(null);

export function useZkRuntime(): ZkRuntime {
  const ctx = useContext(ZkRuntimeContext);
  if (!ctx) throw new Error("useZkRuntime must be used within ZkSessionProvider");
  return ctx;
}

/** Subscribe to the module-scope lock state (unlocked / keyFp / version). */
export function useZkSession(): ZkSnapshot {
  return useSyncExternalStore(subscribeZk, getZkSnapshot, getZkSnapshot);
}

export function ZkSessionProvider({ children }: { children: React.ReactNode }) {
  const me = useAuth();
  const githubLogin = me.user.github_login;
  const enrolled = me.user.zk_enrolled;
  const zkAccountKeyEnabled = me.user.zk_account_key_enabled;
  const [urlConsumed, setUrlConsumed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    wireIdleLock();
    wirePageHideLock();

    setZkSessionReadyHandler(() => notifyZk());
    setZkAutoLockHandler(() => notifyZk());
    setZkPageRestoreHandler(() => {
      // BFCache restored the page after pagehide cleared the in-memory key. If the
      // account is enrolled, retry a silent device/remember unlock; notifyZk() so
      // the gate either renders the dashboard again or falls back to the unlock UI.
      if (enrolled && !isZkUnlocked()) {
        tryAutoUnlockZk(githubLogin).finally(() => notifyZk());
      } else {
        notifyZk();
      }
    });

    (async () => {
      await consumeZkHandoffFromUrl().catch(() => {});
      await consumeZkReauthFromUrl().catch(() => {});
      reconcileZkResetPendingAfterReauth();
      if (!cancelled) setUrlConsumed(true);
    })();

    return () => {
      cancelled = true;
      setZkSessionReadyHandler(null);
      setZkAutoLockHandler(null);
      setZkPageRestoreHandler(null);
    };
  }, [githubLogin, enrolled]);

  return (
    <ZkRuntimeContext.Provider value={{ githubLogin, zkAccountKeyEnabled, urlConsumed }}>
      {children}
    </ZkRuntimeContext.Provider>
  );
}
