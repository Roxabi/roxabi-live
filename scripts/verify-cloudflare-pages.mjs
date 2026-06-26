#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";
import { PAGES_CONFIG_PATHS } from "./lib/pages-configs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/workers-builds.json"), "utf8"));

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

async function verifyPagesProject(configPath) {
  const config = JSON.parse(readFileSync(join(ROOT, configPath), "utf8"));
  const expectedRepoId = String(WORKERS_CONFIG.github.repoId);

  let project;
  try {
    project = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${config.projectName}`);
  } catch {
    fail(`Pages ${config.projectName}`, "project not found — run setup:cloudflare-deploy");
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
    warn("Pages domain list", `${config.projectName} unavailable`);
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

async function main() {
  assertCfCredentials();
  for (const configPath of PAGES_CONFIG_PATHS) {
    await verifyPagesProject(configPath);
  }
}

main()
  .then(() => {
    if (process.exitCode) process.exit(process.exitCode);
  })
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });