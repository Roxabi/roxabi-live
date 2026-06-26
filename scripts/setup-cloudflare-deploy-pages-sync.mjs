#!/usr/bin/env node
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

async function reconnectPagesRepo(projectName) {
  const { owner, ownerId, repo, repoId } = WORKERS_CONFIG.github;
  const project = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${projectName}`);
  if (project.source?.type !== "github") {
    console.log(`ℹ Pages ${projectName}: not git-connected — connect in dashboard first`);
    return;
  }

  const updated = await cf(`/accounts/${ACCOUNT_ID}/pages/projects/${projectName}`, {
    method: "PATCH",
    body: JSON.stringify({
      source: {
        type: "github",
        config: {
          ...project.source.config,
          owner,
          owner_id: String(ownerId),
          repo_name: repo,
          repo_id: String(repoId),
        },
      },
    }),
  });
  const cfg = updated.source?.config;
  console.log(`✓ Pages ${projectName} repo → ${cfg?.owner}/${cfg?.repo_name}`);
}

async function main() {
  assertCfCredentials();
  for (const configPath of PAGES_CONFIGS) {
    const { projectName } = JSON.parse(readFileSync(join(ROOT, configPath), "utf8"));
    await reconnectPagesRepo(projectName);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});