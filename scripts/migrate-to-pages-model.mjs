#!/usr/bin/env node
/**
 * Cutover app/marketing from Workers Builds + custom domains → Pages + thin proxy workers.
 * SSOT: infra/pages-migration.json
 *
 * Usage:
 *   source scripts/bw-cloudflare-global-env.sh   # Pages domains + Workers Builds cleanup
 *   # or: source scripts/bw-cloudflare-live-build-env.sh && export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_BUILDS_ADMIN_TOKEN"
 *   node scripts/migrate-to-pages-model.mjs [--dry-run] [--skip-proxy-deploy]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bwEnvScripts, runWithBwEnv } from "./lib/cf-bw-run.mjs";
import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/pages-migration.json"), "utf8"));
const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_PROXY = process.argv.includes("--skip-proxy-deploy");

function log(msg) {
  console.log(DRY_RUN ? `[dry-run] ${msg}` : msg);
}

async function getWorkerTag(workerName) {
  const scripts = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts`);
  const worker = scripts.find((s) => s.id === workerName);
  return worker?.tag ?? null;
}

async function deleteWorkersBuildsTriggers(workerName) {
  const tag = await getWorkerTag(workerName);
  if (!tag) {
    log(`✓ Worker ${workerName} not found — skip trigger cleanup`);
    return;
  }

  let triggers = [];
  try {
    triggers = await cf(`/accounts/${ACCOUNT_ID}/builds/workers/${tag}/triggers`);
  } catch (err) {
    log(`ℹ Cannot list triggers for ${workerName}: ${err.message}`);
    return;
  }

  if (!triggers.length) {
    log(`✓ No Workers Builds triggers on ${workerName}`);
    return;
  }

  for (const trigger of triggers) {
    log(`- Delete trigger "${trigger.trigger_name}" on ${workerName} (${trigger.trigger_uuid})`);
    if (!DRY_RUN) {
      await cf(`/accounts/${ACCOUNT_ID}/builds/triggers/${trigger.trigger_uuid}`, {
        method: "DELETE",
      });
    }
  }
  log(`✓ Workers Builds triggers removed from ${workerName}`);
}

async function removeWorkerCustomDomain(hostname) {
  let domains = [];
  try {
    domains = await cf(`/accounts/${ACCOUNT_ID}/workers/domains`);
  } catch {
    log(`⚠ Cannot list worker domains — skip ${hostname}`);
    return;
  }

  const hit = domains.find((d) => d.hostname === hostname);
  if (!hit) {
    log(`✓ No worker custom domain ${hostname}`);
    return;
  }

  log(`- Worker custom domain ${hostname}`);
  if (!DRY_RUN) {
    await cf(`/accounts/${ACCOUNT_ID}/workers/domains/${hit.id}`, { method: "DELETE" });
  }
  log(`✓ Worker custom domain ${hostname} removed`);
}

async function ensurePagesDomain(projectName, domain) {
  let customDomains = [];
  try {
    customDomains = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${projectName}/domains`);
  } catch {
    customDomains = [];
  }
  if (customDomains.some((d) => d.name === domain)) {
    log(`✓ Pages ${projectName} already has ${domain}`);
    return;
  }

  log(`+ Pages ${projectName} add domain ${domain}`);
  if (DRY_RUN) return;

  try {
    await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${projectName}/domains`, {
      method: "POST",
      body: JSON.stringify({ name: domain }),
    });
    log(`✓ Pages ${projectName} domain ${domain} added`);
  } catch (err) {
    const msg = String(err.message);
    if (msg.includes("already exists") || msg.includes("already added this custom domain")) {
      log(`✓ Pages ${projectName} domain ${domain} already registered`);
      return;
    }
    throw err;
  }
}

function deployProxyWorker(command) {
  log(`→ Deploy proxy: ${command}`);
  if (DRY_RUN) return;

  const result = spawnSync("bash", ["-lc", command], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Proxy deploy failed: ${command} (exit ${result.status ?? "unknown"})`);
  }
  log(`✓ Proxy deployed (${command})`);
}

async function main() {
  assertCfCredentials();

  console.log("Migrating roxabi-live frontends → Cloudflare Pages (enishu model)\n");

  for (const workerName of CONFIG.legacyWorkers) {
    await deleteWorkersBuildsTriggers(workerName);
  }

  for (const hostname of CONFIG.workerCustomDomains) {
    await removeWorkerCustomDomain(hostname);
  }

  for (const configPath of CONFIG.pagesConfigs) {
    const pages = JSON.parse(readFileSync(join(ROOT, configPath), "utf8"));
    for (const domain of pages.domains ?? []) {
      await ensurePagesDomain(pages.projectName, domain);
    }
  }

  if (!SKIP_PROXY) {
    for (const { deploy } of CONFIG.proxyWorkers ?? []) {
      deployProxyWorker(deploy);
    }
  } else {
    log("ℹ Skipping proxy worker deploy (--skip-proxy-deploy)");
  }

  log("→ DNS CNAMEs for Pages frontends");
  if (!DRY_RUN) {
    const { global: GLOBAL_ENV } = bwEnvScripts(ROOT);
    runWithBwEnv(ROOT, GLOBAL_ENV, "scripts/setup-live-domains.mjs");
  }

  console.log("\nDone. Next steps:");
  for (const note of CONFIG.notes ?? []) {
    console.log(`  • ${note}`);
  }
  console.log("  • bun run setup:cloudflare-deploy  # sync Pages build commands + API triggers");
  console.log("  • bun run verify:cloudflare");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});