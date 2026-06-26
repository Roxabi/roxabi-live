import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function bwEnvScripts(root) {
  return {
    global: join(root, "scripts/bw-cloudflare-global-env.sh"),
    builds: join(root, "scripts/bw-cloudflare-live-build-env.sh"),
  };
}

export function runWithBwEnv(root, bwScript, nodeScript, args = []) {
  const cmd = `source "${bwScript}" && node "${join(root, nodeScript)}"${args.length ? ` ${args.map((a) => `"${a}"`).join(" ")}` : ""}`;
  const result = spawnSync("bash", ["-lc", cmd], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${nodeScript} failed (exit ${result.status ?? "unknown"})`);
  }
}