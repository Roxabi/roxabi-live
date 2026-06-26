/**
 * DEV-only route (/dev/zk) — browser self-test for the ZK core's IndexedDB
 * storage layer, which vitest (node, no IndexedDB) can't reach. Exercises the
 * exact DB names (roxabi-zk-v1 / roxabi-zk-v2) + round-trips device session,
 * remember-passphrase, and the ECDH keypair store. Not in production builds.
 */

import {
  clearDeviceSession,
  clearRememberPassphrase,
  ensureZkKeyPair,
  fingerprintAccountKey,
  generateAccountKey,
  hasRememberPassphrase,
  loadDeviceSession,
  loadRememberPassphrase,
  openContent,
  openWithAccountKey,
  saveDeviceSession,
  saveRememberPassphrase,
  sealContent,
  sealWithAccountKey,
} from "@/zk/crypto";
import { useEffect, useRef, useState } from "react";

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

const LOGIN = "zk-selftest";

async function runSelfTest(): Promise<Result[]> {
  const out: Result[] = [];
  const add = (name: string, pass: boolean, detail = "") => out.push({ name, pass, detail });

  // 1. Device-session IndexedDB round-trip (roxabi-zk-v2 / device_session).
  try {
    await clearDeviceSession(LOGIN);
    const ak = await generateAccountKey();
    const fp = await fingerprintAccountKey(ak);
    const env = await sealWithAccountKey(ak, { title: "device-session test" });
    await saveDeviceSession(LOGIN, ak, fp);
    const loaded = await loadDeviceSession(LOGIN);
    if (!loaded) throw new Error("loadDeviceSession returned null");
    const content = await openWithAccountKey(loaded.accountKey, env);
    add(
      "device session save/load round-trip",
      content.title === "device-session test" && loaded.key_fp === fp,
      `fp=${loaded.key_fp.slice(0, 8)}…`,
    );
    await clearDeviceSession(LOGIN);
    add("device session clears", (await loadDeviceSession(LOGIN)) === null);
  } catch (e) {
    add("device session save/load round-trip", false, String(e));
  }

  // 2. Remember-passphrase IndexedDB round-trip (roxabi-zk-v2 / remember_passphrase).
  try {
    await clearRememberPassphrase(LOGIN);
    await saveRememberPassphrase(LOGIN, "super-secret-pp");
    const got = await loadRememberPassphrase(LOGIN);
    const has = await hasRememberPassphrase(LOGIN);
    add(
      "remember passphrase round-trip",
      got === "super-secret-pp" && has === true,
      `got=${JSON.stringify(got)} has=${has}`,
    );
    await clearRememberPassphrase(LOGIN);
    add("remember passphrase clears", (await loadRememberPassphrase(LOGIN)) === null);
  } catch (e) {
    add("remember passphrase round-trip", false, String(e));
  }

  // 3. ECDH keypair store (roxabi-zk-v1 / keypairs) — persistence + ECIES seal/open.
  try {
    const a = await ensureZkKeyPair(LOGIN);
    const b = await ensureZkKeyPair(LOGIN);
    const env = await sealContent(a.publicKey, { title: "kp roundtrip" });
    const content = await openContent(b.privateKey, env);
    add(
      "keypair persists + ECIES seal/open",
      a.pubkeyFp === b.pubkeyFp && content.title === "kp roundtrip",
      `pubkeyFp=${a.pubkeyFp.slice(0, 8)}…`,
    );
  } catch (e) {
    add("keypair persists + ECIES seal/open", false, String(e));
  }

  return out;
}

export default function DevZkPage() {
  const [results, setResults] = useState<Result[] | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode double-invokes effects in dev; a second concurrent run would
    // race on the shared IndexedDB self-test key. Run exactly once.
    if (started.current) return;
    started.current = true;
    runSelfTest().then(setResults);
  }, []);

  const allPass = results?.every((r) => r.pass) ?? false;

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <h1 className="mb-4 text-2xl font-bold">ZK core — browser self-test</h1>
      {results === null ? (
        <p data-testid="zk-running" className="text-muted-foreground">
          Running…
        </p>
      ) : (
        <div data-testid="zk-results" data-allpass={allPass ? "1" : "0"} className="space-y-2">
          {results.map((r) => (
            <div
              key={r.name}
              data-testid={`zk-check-${r.pass ? "pass" : "fail"}`}
              className="rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className={r.pass ? "text-ready" : "text-blocked"}>{r.pass ? "✓" : "✗"}</span>{" "}
              {r.name}
              {r.detail && <span className="ml-2 text-muted-foreground">— {r.detail}</span>}
            </div>
          ))}
          <p className="pt-2 font-semibold" data-testid="zk-summary">
            {results.filter((r) => r.pass).length}/{results.length} passed
          </p>
        </div>
      )}
    </div>
  );
}
