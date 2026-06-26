#!/usr/bin/env node
/**
 * Verify Cloudflare git-connected deploy for roxabi-live (enishu model).
 * Pages × 4 (app + marketing, prod + staging) + Workers Builds API × 2.
 *
 * Usage:
 *   source scripts/bw-cloudflare-global-env.sh   # Pages read
 *   source scripts/bw-cloudflare-live-build-env.sh
 *   export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_BUILDS_ADMIN_TOKEN"  # Workers Builds
 *   bun run verify:cloudflare
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/workers-builds.json"), "utf8"));

const PAGES_CONFIGS = [
  "infra/pages-app.json",
  "infra/pages-app-staging.json",
  "infra/pages-marketing.json",
  "infra/pages-marketing-staging.json",
];

const LEGACY_FRONTEND_WORKERS = [
  "roxabi-live-app",
  "roxabi-live-app-staging",
  "roxabi-live-marketing",
  "roxabi-live-marketing-staging",
];

function ok(label, detail) {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail) {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function warn(label, detail) {
  console.log(`⚠ ${label}${detail ? ` — ${detail}` : ""}`);
}

async function verifyRepoConnection() {
  try {
    const connections = await cf(`/accounts/${ACCOUNT_ID}/builds/repos/connections`);
    const repoConn = connections.find(
      (c) =>
        c.provider_type === "github" &&
        String(c.repo_id) === String(WORKERS_CONFIG.github.repoId) &&
        c.provider_account_name?.toLowerCase() === WORKERS_CONFIG.github.owner.toLowerCase(),
    );
    if (repoConn) {
      const label = `${repoConn.provider_account_name}/${repoConn.repo_name}`;
      if (repoConn.repo_name === WORKERS_CONFIG.github.repo) {
        ok("Workers Builds repo connection", label);
      } else {
        ok(
          "Workers Builds repo connection",
          `${label} (repo_id match; run setup:cloudflare-deploy to rename)`,
        );
      }
    } else {
      fail("Workers Builds repo connection", "repo_id not connected");
    }
  } catch {
    console.log("ℹ Workers Builds repo connection list unavailable (upsert via setup:workers-builds)");
  }
}

async function verifyPagesProject(configPath) {
  const config = JSON.parse(readFileSync(join(ROOT, configPath), "utf8"));
  const expectedRepoId = String(WORKERS_CONFIG.github.repoId);

  let project;
  try {
    project = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${config.projectName}`);
  } catch {
    fail(`Pages ${config.projectName}`, "project not found — create in dashboard + git-connect");
    return;
  }

  const cfg = project.source?.config;
  const repo = cfg ? `${cfg.owner}/${cfg.repo_name}` : "unknown";
  const deploy = project.latest_deployment?.latest_stage;
  const repoOk =
    String(cfg?.repo_id) === expectedRepoId &&
    cfg?.owner?.toLowerCase() === WORKERS_CONFIG.github.owner.toLowerCase();

  if (repoOk && cfg?.repo_name === WORKERS_CONFIG.github.repo) {
    ok(
      `Pages ${config.projectName}`,
      `branch=${project.production_branch}, last=${deploy?.status ?? "?"}`,
    );
  } else if (repoOk) {
    ok(
      `Pages ${config.projectName}`,
      `${repo} (repo_id match; CF label stale), branch=${project.production_branch}, last=${deploy?.status ?? "?"}`,
    );
  } else if (project.source?.type === "github") {
    fail(`Pages ${config.projectName}`, `unexpected repo ${repo}`);
  } else {
    fail(`Pages ${config.projectName}`, "not git-connected");
  }

  let customDomains = [];
  try {
    customDomains = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${config.projectName}/domains`);
  } catch {
    warn(`Pages domain list`, `${config.projectName} unavailable`);
  }

  for (const domain of config.domains ?? []) {
    const hit = customDomains.find((d) => d.name === domain);
    if (hit?.status === "active") {
      ok(`Pages domain ${domain}`, config.projectName);
    } else if (hit) {
      warn(`Pages domain ${domain}`, `${hit.status} on ${config.projectName}`);
    } else {
      fail(`Pages domain ${domain}`, `missing on ${config.projectName} — run migrate-to-pages-model`);
    }
  }
}

async function verifyApiWorkers() {
  const scripts = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts`);

  for (const { workerName, trigger } of WORKERS_CONFIG.workers) {
    const worker = scripts.find((s) => s.id === workerName);
    if (!worker?.tag) {
      fail(`Worker ${workerName}`, "not found");
      continue;
    }
    ok(`Worker ${workerName}`, `tag=${worker.tag}`);

    const triggers = await cf(`/accounts/${ACCOUNT_ID}/builds/workers/${worker.tag}/triggers`);
    const match = triggers.find((t) => t.trigger_name === trigger.name);
    if (match) {
      ok(`Workers Builds trigger ${trigger.name}`, workerName);
    } else {
      fail(`Workers Builds trigger ${trigger.name}`, `missing on ${workerName}`);
    }
  }
}

async function verifyNoLegacyFrontendTriggers() {
  const scripts = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts`);

  for (const workerName of LEGACY_FRONTEND_WORKERS) {
    const worker = scripts.find((s) => s.id === workerName);
    if (!worker?.tag) continue;

    let triggers = [];
    try {
      triggers = await cf(`/accounts/${ACCOUNT_ID}/builds/workers/${worker.tag}/triggers`);
    } catch {
      continue;
    }

    if (triggers.length > 0) {
      fail(
        `Legacy Workers Builds on ${workerName}`,
        `${triggers.length} trigger(s) — run migrate-to-pages-model`,
      );
    } else {
      ok(`No Workers Builds on ${workerName}`, "Pages model");
    }
  }
}

async function verifyNoWorkerCustomDomainsOnFronts() {
  let domains = [];
  try {
    domains = await cf(`/accounts/${ACCOUNT_ID}/workers/domains`);
  } catch {
    console.log("ℹ Worker custom domain list unavailable (token scope?)");
    return;
  }

  const frontHosts = new Set(
    PAGES_CONFIGS.flatMap((path) => {
      const config = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
      return config.domains ?? [];
    }),
  );

  for (const entry of domains) {
    if (frontHosts.has(entry.hostname)) {
      fail(
        `Worker custom domain ${entry.hostname}`,
        `still on worker ${entry.service} — run migrate-to-pages-model`,
      );
    }
  }
}

async function main() {
  assertCfCredentials();

  await verifyRepoConnection();

  for (const configPath of PAGES_CONFIGS) {
    await verifyPagesProject(configPath);
  }

  await verifyApiWorkers();
  await verifyNoLegacyFrontendTriggers();
  await verifyNoWorkerCustomDomainsOnFronts();

  if (process.exitCode) {
    console.error(
      "\nFix: source scripts/bw-cloudflare-live-build-env.sh && export CLOUDFLARE_API_TOKEN=\"$CLOUDFLARE_BUILDS_ADMIN_TOKEN\" && bun run setup:cloudflare-deploy",
    );
    console.error("Cutover: node scripts/migrate-to-pages-model.mjs");
  } else {
    console.log("\nCloudflare git-connected deploy looks healthy (Pages + API Workers Builds).");
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});