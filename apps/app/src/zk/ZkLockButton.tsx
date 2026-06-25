/**
 * ZkLockButton — header control that clears the in-memory accountKey on demand
 * (frontend/zk-enroll.js wireZkLockButton / lockZkSession). Visible only while
 * unlocked; after locking, the session version bumps and ZkGate re-renders into
 * the unlock flow. Lives in AppShell (inside ZkSessionProvider, outside ZkGate).
 */

import { Lock } from "@phosphor-icons/react";
import { useZkRuntime, useZkSession } from "./ZkSessionProvider";
import { lockZkSession } from "./enroll";

export function ZkLockButton() {
  const { unlocked } = useZkSession();
  const { githubLogin, zkAccountKeyEnabled } = useZkRuntime();

  if (!zkAccountKeyEnabled || !unlocked) return null;

  return (
    <button
      type="button"
      data-testid="zk-lock-btn"
      title="Verrouiller le chiffrement (effacer la clé de la mémoire)"
      onClick={() => lockZkSession(githubLogin)}
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Lock className="size-4" aria-hidden />
      Verrouiller
    </button>
  );
}
