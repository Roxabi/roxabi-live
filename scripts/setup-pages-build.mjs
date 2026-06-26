#!/usr/bin/env node
/**
 * Sync Cloudflare Pages build settings from infra/pages-*.json (enishu model).
 *
 * Usage:
 *   export CLOUDFLARE_API_TOKEN=<token with Pages Configuration Edit>
 *   node scripts/setup-pages-build.mjs infra/pages-app.json
 *   node scripts/setup-pages-build.mjs infra/pages-marketing-staging.json
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertCfCredentials, cf } from "./lib/cf-access.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function envVarsRecord(vars) {
  return Object.fromEntries(
    Object.entries(vars ?? {}).map(([key, value]) => [key, { type: "plain_text", value }]),
  );
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error("Usage: node scripts/setup-pages-build.mjs <infra/pages-*.json>");
  }

  const CONFIG = JSON.parse(readFileSync(join(ROOT, configPath), "utf8"));
  const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? CONFIG.accountId;

  assertCfCredentials();

  const project = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${CONFIG.projectName}`);
  const body = {
    build_config: {
      build_command: CONFIG.buildConfig.build_command,
      destination_dir: CONFIG.buildConfig.destination_dir,
      root_dir: CONFIG.buildConfig.root_dir ?? "",
    },
  };

  if (CONFIG.productionEnv && Object.keys(CONFIG.productionEnv).length > 0) {
    body.deployment_configs = {
      ...project.deployment_configs,
      production: {
        ...project.deployment_configs?.production,
        env_vars: envVarsRecord(CONFIG.productionEnv),
      },
    };
  }

  if (CONFIG.source?.path_includes) {
    body.source = {
      type: project.source?.type ?? "github",
      config: {
        ...project.source?.config,
        path_includes: CONFIG.source.path_includes,
      },
    };
  }

  if (CONFIG.productionBranch && CONFIG.productionBranch !== project.production_branch) {
    body.production_branch = CONFIG.productionBranch;
  }

  const updated = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${CONFIG.projectName}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

  console.log(`✓ ${CONFIG.projectName} build settings updated`);
  console.log(
    `  branch:  ${updated.production_branch ?? CONFIG.productionBranch ?? project.production_branch}`,
  );
  console.log(
    `  command: ${updated.build_config?.build_command ?? CONFIG.buildConfig.build_command}`,
  );
  console.log(
    `  output:  ${updated.build_config?.destination_dir ?? CONFIG.buildConfig.destination_dir}`,
  );
  for (const note of CONFIG.notes ?? []) {
    console.log(`  ℹ ${note}`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});