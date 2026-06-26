#!/usr/bin/env node
/**
 * Trigger production Pages deployments (git-connected) for all roxabi-live frontends.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIGS = [
  "infra/pages-app.json",
  "infra/pages-app-staging.json",
  "infra/pages-marketing.json",
  "infra/pages-marketing-staging.json",
];

async function main() {
  assertCfCredentials();

  for (const path of CONFIGS) {
    const { projectName } = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
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