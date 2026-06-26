#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";
import { LEGACY_FRONTEND_WORKERS, PAGES_CONFIG_PATHS } from "./lib/pages-configs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/workers-builds.json"), "utf8"));

function ok(label, detail) {
  console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail) {
  console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
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
    PAGES_CONFIG_PATHS.flatMap((path) => {
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
  await verifyApiWorkers();
  await verifyNoLegacyFrontendTriggers();
  await verifyNoWorkerCustomDomainsOnFronts();
}

main()
  .then(() => {
    if (process.exitCode) process.exit(process.exitCode);
  })
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });