#!/usr/bin/env node
/**
 * Create Cloudflare Pages projects for roxabi-live if missing (git-connected).
 * SSOT: infra/pages-*.json + infra/workers-builds.json (github ids).
 *
 * Requires global API key or token with Pages Write:
 *   source scripts/bw-cloudflare-global-env.sh
 *
 * Usage:
 *   node scripts/setup-pages-projects.mjs [--dry-run]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB = JSON.parse(readFileSync(join(ROOT, "infra/workers-builds.json"), "utf8")).github;
const DRY_RUN = process.argv.includes("--dry-run");

const PAGES_CONFIGS = [
  "infra/pages-app.json",
  "infra/pages-app-staging.json",
  "infra/pages-marketing.json",
  "infra/pages-marketing-staging.json",
];

function envVarsRecord(vars) {
  return Object.fromEntries(
    Object.entries(vars ?? {}).map(([key, value]) => [key, { type: "plain_text", value }]),
  );
}

function log(msg) {
  console.log(DRY_RUN ? `[dry-run] ${msg}` : msg);
}

async function projectExists(projectName) {
  try {
    await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${projectName}`);
    return true;
  } catch (err) {
    if (String(err.message).includes("Project not found")) return false;
    throw err;
  }
}

async function createProject(config) {
  const body = {
    name: config.projectName,
    production_branch: config.productionBranch ?? "main",
    build_config: {
      build_command: config.buildConfig.build_command,
      destination_dir: config.buildConfig.destination_dir,
      root_dir: config.buildConfig.root_dir ?? "",
      build_caching: true,
    },
    source: {
      type: "github",
      config: {
        owner: GITHUB.owner,
        owner_id: String(GITHUB.ownerId),
        repo_name: GITHUB.repo,
        repo_id: String(GITHUB.repoId),
        production_branch: config.productionBranch ?? "main",
        deployments_enabled: true,
        production_deployments_enabled: true,
        preview_deployment_setting: "none",
        pr_comments_enabled: false,
        path_includes: config.source?.path_includes ?? [],
        path_excludes: config.source?.path_excludes ?? [],
      },
    },
  };

  if (config.productionEnv && Object.keys(config.productionEnv).length > 0) {
    body.deployment_configs = {
      production: {
        env_vars: envVarsRecord(config.productionEnv),
      },
    };
  }

  log(`+ Create Pages project ${config.projectName} (branch=${body.production_branch})`);
  if (DRY_RUN) return;

  const created = await cf(`/accounts/${ACCOUNT_ID}/pages/projects`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  log(`✓ Created ${created.name} (${created.id})`);
}

async function main() {
  assertCfCredentials();

  for (const configPath of PAGES_CONFIGS) {
    const config = JSON.parse(readFileSync(join(ROOT, configPath), "utf8"));
    if (await projectExists(config.projectName)) {
      log(`✓ Pages project ${config.projectName} exists`);
      continue;
    }
    await createProject(config);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});