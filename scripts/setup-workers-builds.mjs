#!/usr/bin/env node
/**
 * Configure Cloudflare Workers Builds for roxabi-live (git-connected deploy).
 * Model: enishu — CF pulls the repo and runs build/deploy commands; GHA is CI-only.
 *
 * Prerequisites:
 * 1. Cloudflare GitHub App authorized (Workers & Pages → Builds → Connect GitHub)
 * 2. Build API token on a worker (Settings → Builds → API token; D1 Edit required)
 *
 * Usage:
 *   source scripts/bw-cloudflare-live-build-env.sh
 *   export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_BUILDS_ADMIN_TOKEN"
 *   bun run setup:workers-builds
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/workers-builds.json"), "utf8"));

async function getWorkerTag(workerName) {
  const scripts = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts`);
  const worker = scripts.find((s) => s.id === workerName);
  if (!worker?.tag) {
    throw new Error(`Worker ${workerName} not found. Deploy once with wrangler first.`);
  }
  return worker.tag;
}

async function upsertRepoConnection() {
  const created = await cf(`/accounts/${ACCOUNT_ID}/builds/repos/connections`, {
    method: "PUT",
    body: JSON.stringify({
      provider_type: "github",
      provider_account_id: String(CONFIG.github.ownerId),
      provider_account_name: CONFIG.github.owner,
      repo_id: String(CONFIG.github.repoId),
      repo_name: CONFIG.github.repo,
    }),
  });
  console.log(`✓ Repo connection upserted (${created.repo_connection_uuid})`);
  return created.repo_connection_uuid;
}

async function ensureRepoConnection() {
  try {
    const connections = await cf(`/accounts/${ACCOUNT_ID}/builds/repos/connections`);
    const existing = connections.find(
      (c) =>
        c.provider_type === "github" &&
        String(c.repo_id) === String(CONFIG.github.repoId) &&
        c.provider_account_name?.toLowerCase() === CONFIG.github.owner.toLowerCase(),
    );
    if (existing) {
      console.log(
        `✓ Repo connection exists (${existing.repo_connection_uuid}, repo=${existing.repo_name})`,
      );
      if (existing.repo_name !== CONFIG.github.repo) {
        return upsertRepoConnection();
      }
      return existing.repo_connection_uuid;
    }
  } catch {
    console.log("ℹ Repo connection list unavailable — upserting");
  }
  return upsertRepoConnection();
}

async function getBuildTokenUuid() {
  const tokens = await cf(`/accounts/${ACCOUNT_ID}/builds/tokens`);
  if (!tokens?.length) {
    throw new Error(
      "No build token found. Create one: Worker roxabi-live → Settings → Builds → API token. " +
        "Scopes: Workers Scripts Edit, D1 Edit, Workers Routes Edit.",
    );
  }
  const token =
    tokens.find((t) => /roxabi-live/i.test(t.build_token_name ?? "")) ??
    tokens.find((t) => /live|links/i.test(t.build_token_name ?? "")) ??
    tokens[0];
  console.log(`✓ Build token: ${token.build_token_name} (${token.build_token_uuid})`);
  return token.build_token_uuid;
}

function triggerBody(repoConnectionUuid, buildTokenUuid, workerTag, spec) {
  return {
    external_script_id: workerTag,
    repo_connection_uuid: repoConnectionUuid,
    build_token_uuid: buildTokenUuid,
    trigger_name: spec.name,
    build_command: spec.buildCommand,
    deploy_command: spec.deployCommand,
    root_directory: spec.rootDirectory,
    branch_includes: spec.branchIncludes,
    branch_excludes: spec.branchExcludes ?? [],
    path_includes: spec.pathIncludes ?? CONFIG.pathIncludes,
    path_excludes: spec.pathExcludes ?? CONFIG.pathExcludes ?? [],
    build_caching_enabled: true,
  };
}

function branchesMatch(trigger, spec) {
  const want = [...(spec.branchIncludes ?? [])].sort().join(",");
  const have = [...(trigger.branch_includes ?? [])].sort().join(",");
  return want === have;
}

async function upsertTrigger(workerTag, repoConnectionUuid, buildTokenUuid, spec) {
  const triggers = await cf(`/accounts/${ACCOUNT_ID}/builds/workers/${workerTag}/triggers`);
  const existing =
    triggers.find((t) => t.trigger_name === spec.name) ??
    triggers.find((t) => branchesMatch(t, spec));
  const body = triggerBody(repoConnectionUuid, buildTokenUuid, workerTag, spec);

  if (existing) {
    await cf(`/accounts/${ACCOUNT_ID}/builds/triggers/${existing.trigger_uuid}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    const renamed = existing.trigger_name !== spec.name ? ` (was "${existing.trigger_name}")` : "";
    console.log(`✓ Updated trigger "${spec.name}" (${existing.trigger_uuid})${renamed}`);
    return existing.trigger_uuid;
  }

  const created = await cf(`/accounts/${ACCOUNT_ID}/builds/triggers`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(`✓ Created trigger "${spec.name}" (${created.trigger_uuid})`);
  return created.trigger_uuid;
}

async function main() {
  assertCfCredentials();

  const repoConnectionUuid = await ensureRepoConnection();
  const buildTokenUuid = await getBuildTokenUuid();

  for (const { workerName, trigger } of CONFIG.workers) {
    const workerTag = await getWorkerTag(workerName);
    console.log(`\nWorker ${workerName} tag=${workerTag}`);
    await upsertTrigger(workerTag, repoConnectionUuid, buildTokenUuid, trigger);
  }

  console.log("\n--- Workers Builds ready ---");
  console.log("Push to staging → staging Workers (api, app, marketing)");
  console.log("Push to main    → production Workers");
  console.log("\nCI (GitHub Actions) = quality gates only. Deploy = Cloudflare Workers Builds.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});