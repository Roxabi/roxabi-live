// zkStore.ts — external store bridging the module-scope ZK session (session.ts)
// to React via useSyncExternalStore. session.ts keeps the CryptoKey out of React
// state; this store exposes only booleans/fingerprints so a re-render can never
// touch key material. `notifyZk()` is the single change signal (unlock, enroll,
// device restore, idle lock, explicit lock) — wired through ZkSessionProvider.

import { getSessionKeyFp, isZkUnlocked } from "./session";

type Listener = () => void;

const listeners = new Set<Listener>();

export interface ZkSnapshot {
  unlocked: boolean;
  keyFp: string | null;
  version: number;
}

let snapshot: ZkSnapshot = { unlocked: isZkUnlocked(), keyFp: getSessionKeyFp(), version: 0 };

/** Recompute + broadcast the snapshot. Idempotent objects keep React stable. */
export function notifyZk(): void {
  snapshot = {
    unlocked: isZkUnlocked(),
    keyFp: getSessionKeyFp(),
    version: snapshot.version + 1,
  };
  for (const l of listeners) l();
}

export function subscribeZk(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getZkSnapshot(): ZkSnapshot {
  return snapshot;
}
