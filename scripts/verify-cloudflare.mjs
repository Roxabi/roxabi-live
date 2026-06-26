#!/usr/bin/env node
/**
 * Verify Cloudflare git-connected deploy for roxabi-live (enishu model).
 * Pages × 4 + Workers Builds API × 2 (dual Bitwarden creds in subprocesses).
 *
 * Usage:
 *   bun run verify:cloudflare
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bwEnvScripts, runWithBwEnv } from "./lib/cf-bw-run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { global: GLOBAL_ENV, builds: BUILDS_ENV } = bwEnvScripts(ROOT);

async function main() {
  console.log("=== Pages ===\n");
  runWithBwEnv(ROOT, GLOBAL_ENV, "scripts/verify-cloudflare-pages.mjs");

  console.log("\n=== Workers Builds (API) ===\n");
  runWithBwEnv(ROOT, BUILDS_ENV, "scripts/verify-cloudflare-workers.mjs");

  console.log("\nCloudflare git-connected deploy looks healthy (Pages + API Workers Builds).");
}

main().catch((err) => {
  console.error(err.message ?? err);
  console.error("\nFix: bun run setup:cloudflare-deploy");
  console.error("Cutover: bun run migrate:pages-model");
  process.exit(1);
});