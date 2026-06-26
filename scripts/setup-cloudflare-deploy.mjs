#!/usr/bin/env node
/**
 * One-shot sync for roxabi-live git-connected deploy (enishu model).
 *
 * Usage (loads Bitwarden creds in subprocesses):
 *   bun run setup:cloudflare-deploy
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bwEnvScripts, runWithBwEnv } from "./lib/cf-bw-run.mjs";
import { PAGES_CONFIG_PATHS } from "./lib/pages-configs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { global: GLOBAL_ENV, builds: BUILDS_ENV } = bwEnvScripts(ROOT);

async function main() {
  console.log("=== Pages projects (create if missing) ===\n");
  runWithBwEnv(ROOT, GLOBAL_ENV, "scripts/setup-pages-projects.mjs");

  console.log("\n=== Workers Builds (API) ===\n");
  runWithBwEnv(ROOT, BUILDS_ENV, "scripts/setup-workers-builds.mjs");

  console.log("\n=== Pages build settings ===\n");
  for (const configPath of PAGES_CONFIG_PATHS) {
    runWithBwEnv(ROOT, GLOBAL_ENV, "scripts/setup-pages-build.mjs", [configPath]);
  }

  console.log("\n=== Pages GitHub repo sync ===\n");
  runWithBwEnv(ROOT, GLOBAL_ENV, "scripts/setup-cloudflare-deploy-pages-sync.mjs");

  console.log("\n=== Pages DNS (CNAME) ===\n");
  runWithBwEnv(ROOT, GLOBAL_ENV, "scripts/setup-live-domains.mjs");

  console.log("\n=== Pages deploy (if no successful build) ===\n");
  runWithBwEnv(ROOT, GLOBAL_ENV, "scripts/trigger-pages-deployments.mjs", ["--if-empty"]);

  console.log("\n--- Cloudflare deploy setup complete ---");
  console.log("CI = GitHub Actions quality gates only.");
  console.log("Deploy: push to staging/main → CF Pages (fronts) + Workers Builds (API).");
  console.log("Verify: bun run verify:cloudflare");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});