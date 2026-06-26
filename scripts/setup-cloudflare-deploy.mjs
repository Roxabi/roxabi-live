#!/usr/bin/env node
/**
 * One-shot sync for roxabi-live git-connected deploy (enishu model).
 * - Workers Builds: API only (infra/workers-builds.json)
 * - Pages: app + marketing, prod + staging (infra/pages-*.json)
 *
 * Usage (loads Bitwarden creds in subprocesses — BW_SESSION or agent-bw-login required):
 *   bun run setup:cloudflare-deploy
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAGES_CONFIGS = [
  "infra/pages-app.json",
  "infra/pages-app-staging.json",
  "infra/pages-marketing.json",
  "infra/pages-marketing-staging.json",
];

const GLOBAL_ENV = join(ROOT, "scripts/bw-cloudflare-global-env.sh");
const BUILDS_ENV = join(ROOT, "scripts/bw-cloudflare-live-build-env.sh");

function runWithBwEnv(bwScript, nodeScript, args = []) {
  const cmd = `source "${bwScript}" && node "${join(ROOT, nodeScript)}"${args.length ? ` ${args.map((a) => `"${a}"`).join(" ")}` : ""}`;
  const result = spawnSync("bash", ["-lc", cmd], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${nodeScript} failed (exit ${result.status ?? "unknown"})`);
  }
}

async function main() {
  console.log("=== Pages projects (create if missing) ===\n");
  runWithBwEnv(GLOBAL_ENV, "scripts/setup-pages-projects.mjs");

  console.log("\n=== Workers Builds (API) ===\n");
  try {
    runWithBwEnv(BUILDS_ENV, "scripts/setup-workers-builds.mjs");
  } catch (err) {
    console.log(`\n⚠ Workers Builds skipped: ${err.message}`);
  }

  console.log("\n=== Pages build settings ===\n");
  for (const configPath of PAGES_CONFIGS) {
    runWithBwEnv(GLOBAL_ENV, "scripts/setup-pages-build.mjs", [configPath]);
  }

  console.log("\n=== Pages GitHub repo sync ===\n");
  runWithBwEnv(GLOBAL_ENV, "scripts/setup-cloudflare-deploy-pages-sync.mjs");

  console.log("\n=== Pages DNS (CNAME) ===\n");
  runWithBwEnv(GLOBAL_ENV, "scripts/setup-live-domains.mjs");

  console.log("\n=== Pages initial deploy ===\n");
  runWithBwEnv(GLOBAL_ENV, "scripts/trigger-pages-deployments.mjs");

  console.log("\n--- Cloudflare deploy setup complete ---");
  console.log("CI = GitHub Actions quality gates only.");
  console.log("Deploy: push to staging/main → CF Pages (fronts) + Workers Builds (API).");
  console.log("Verify: bun run verify:cloudflare");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});