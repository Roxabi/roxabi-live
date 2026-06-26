#!/usr/bin/env node
/**
 * Trigger production Pages deployments (git-connected) for roxabi-live frontends.
 *
 * Usage:
 *   node scripts/trigger-pages-deployments.mjs [--if-empty]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";
import { PAGES_CONFIG_PATHS } from "./lib/pages-configs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IF_EMPTY = process.argv.includes("--if-empty");

async function hasSuccessfulDeployment(projectName) {
  const deployments = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${projectName}/deployments`);
  return deployments.some((d) => d.latest_stage?.status === "success");
}

async function main() {
  assertCfCredentials();

  for (const path of PAGES_CONFIG_PATHS) {
    const { projectName } = JSON.parse(readFileSync(join(ROOT, path), "utf8"));

    if (IF_EMPTY && (await hasSuccessfulDeployment(projectName))) {
      console.log(`✓ ${projectName} already has a successful deployment — skip`);
      continue;
    }

    const deployment = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${projectName}/deployments`, {
      method: "POST",
      body: "{}",
    });
    console.log(`✓ Triggered ${projectName} (${deployment.id})`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});