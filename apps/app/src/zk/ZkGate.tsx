/**
 * ZkGate — declarative replacement for the imperative requireZkEnrollmentGate()
 * (frontend/zk-enroll.js). Renders the dashboard (`children`) only once the
 * account is enrolled AND unlocked; otherwise drives the enroll / device-2 /
 * unlock / reset flows. Lock-state transitions arrive via useZkSession() (the
 * external store fed by session.ts handlers), so an idle/BFCache lock re-renders
 * straight back into the unlock flow.
 */

import { useAuth } from "@/auth/AuthContext";
import { CircleNotch } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { ZkDevice2Block } from "./ZkDevice2Block";
import { ZkEnrollDialog } from "./ZkEnrollDialog";
import { ZkResetExecuteDialog } from "./ZkResetDialog";
import { useZkRuntime, useZkSession } from "./ZkSessionProvider";
import { ZkUnlockDialog } from "./ZkUnlockDialog";
import { hasZkKeyPair } from "./crypto";
import {
  fetchPayloadRows,
  hasEnrolledThisSession,
  payloadsHaveV1,
  tryAutoUnlockZk,
} from "./enroll";
import { getZkReauthProof } from "./github";
import { clearZkResetPending, isZkResetPending } from "./reset";
import { ensurePrivateMode } from "./sync";

function ZkGateLoading() {
  return (
    <div
      className="flex min-h-[60vh] items-center justify-center text-muted-foreground"
      data-testid="zk-loading"
    >
      <CircleNotch className="size-6 animate-spin" aria-hidden />
      <span className="sr-only">Déverrouillage du chiffrement…</span>
    </div>
  );
}

/**
 * Legacy flag-off path (per-device ECDH v1, no passphrase). ensurePrivateMode
 * opts in + seals server-side; decryption uses the local ECDH key (no unlock).
 * Best-effort & non-blocking — this branch is dead while zk_account_key_enabled.
 */
function ZkLegacyV1Gate({ login, children }: { login: string; children: React.ReactNode }) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    ensurePrivateMode(login).catch(() => {});
  }, [login]);
  return <>{children}</>;
}

function ZkEnrollController({ login }: { login: string }) {
  const [phase, setPhase] = useState<"checking" | "device2" | "enroll">("checking");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const payloads = await fetchPayloadRows();
      const hasV1 = payloadsHaveV1(payloads);
      const hasLocalKey = await hasZkKeyPair(login);
      setPhase(hasV1 && !hasLocalKey ? "device2" : "enroll");
    })();
  }, [login]);

  if (phase === "checking") return <ZkGateLoading />;
  if (phase === "device2") return <ZkDevice2Block />;
  return <ZkEnrollDialog login={login} />;
}

function ZkUnlockController({ login }: { login: string }) {
  const [phase, setPhase] = useState<"checking" | "unlock" | "reset-execute">("checking");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      // Returned from OAuth step-up with a fresh proof → confirm the reset.
      if (isZkResetPending() && getZkReauthProof()) {
        setPhase("reset-execute");
        return;
      }
      if (isZkResetPending() && !getZkReauthProof()) clearZkResetPending();
      // Single-flight: silent device/remember restore before prompting.
      if (await tryAutoUnlockZk(login)) return; // unlocked → ZkGate unmounts this.
      setPhase("unlock");
    })();
  }, [login]);

  if (phase === "checking") return <ZkGateLoading />;
  if (phase === "reset-execute") {
    return <ZkResetExecuteDialog login={login} onCancel={() => setPhase("unlock")} />;
  }
  return <ZkUnlockDialog login={login} />;
}

export function ZkGate({ children }: { children: React.ReactNode }) {
  const me = useAuth();
  const { unlocked } = useZkSession();
  const { urlConsumed, githubLogin, zkAccountKeyEnabled } = useZkRuntime();

  if (!zkAccountKeyEnabled) {
    return <ZkLegacyV1Gate login={githubLogin}>{children}</ZkLegacyV1Gate>;
  }

  // Wait until ?zk_handoff= / ?zk_reauth= are consumed so the reset-execute
  // branch sees the proof on the first paint after the OAuth round-trip.
  if (!urlConsumed) return <ZkGateLoading />;

  if (unlocked) return <>{children}</>;

  const enrolled = me.user.zk_enrolled || hasEnrolledThisSession();
  if (!enrolled) return <ZkEnrollController login={githubLogin} />;

  return <ZkUnlockController login={githubLogin} />;
}
