#!/usr/bin/env node
/**
 * Verify Cloudflare Workers Builds setup for roxabi-live.
 *
 * Usage:
 *   source scripts/bw-cloudflare-live-build-env.sh
 *   export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_BUILDS_ADMIN_TOKEN"
 *   bun run verify:cloudflare
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/workers-builds.json"), "utf8"));

function ok(label, detail) {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail) {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function main() {
  assertCfCredentials();

  try {
    const connections = await cf(`/accounts/${ACCOUNT_ID}/builds/repos/connections`);
    const repoConn = connections.find(
      (c) =>
        c.provider_type === "github" &&
        String(c.repo_id) === String(CONFIG.github.repoId) &&
        c.provider_account_name?.toLowerCase() === CONFIG.github.owner.toLowerCase(),
    );
    if (repoConn?.repo_name === CONFIG.github.repo) {
      ok("Workers Builds repo connection", `${repoConn.provider_account_name}/${repoConn.repo_name}`);
    } else if (repoConn) {
      fail("Workers Builds repo connection", `stale repo name ${repoConn.repo_name}`);
    } else {
      fail("Workers Builds repo connection", "not connected — run setup:workers-builds");
    }
  } catch {
    console.log("ℹ Repo connection list unavailable — run setup:workers-builds to upsert");
  }

  const scripts = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts`);
  for (const { workerName, trigger } of CONFIG.workers) {
    const worker = scripts.find((s) => s.id === workerName);
    if (!worker?.tag) {
      fail(`Worker ${workerName}`, "not found");
      continue;
    }
    ok(`Worker ${workerName}`, `tag=${worker.tag}`);

    const triggers = await cf(`/accounts/${ACCOUNT_ID}/builds/workers/${worker.tag}/triggers`);
    const match = triggers.find((t) => t.trigger_name === trigger.name);
    if (match) {
      ok(`Trigger ${trigger.name}`, match.trigger_uuid);
    } else {
      fail(`Trigger ${trigger.name}`, "missing — run setup:workers-builds");
    }
  }

  if (process.exitCode) {
    console.error("\nFix: source scripts/bw-cloudflare-live-build-env.sh && bun run setup:workers-builds");
  } else {
    console.log("\nCloudflare Workers Builds looks healthy.");
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});