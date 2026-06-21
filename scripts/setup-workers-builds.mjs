#!/usr/bin/env node
/**
 * Configure Cloudflare Workers Builds for roxabi-live (git-connected deploy).
 *
 * Prerequisites (one-time):
 * 1. Cloudflare GitHub App authorized (Workers & Pages → any Worker → Settings → Builds → Connect)
 * 2. User-scoped API token with:
 *    - Workers Builds Configuration → Edit
 *    - Workers Scripts → Read
 *
 * Usage:
 *   export CLOUDFLARE_API_TOKEN=<user token>
 *   node scripts/setup-workers-builds.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/workers-builds.json"), "utf8"));
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? CONFIG.accountId;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`CF API ${path}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result;
}

async function getWorkerTag(workerName) {
  const scripts = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts`);
  const worker = scripts.find((s) => s.id === workerName);
  if (!worker?.tag) {
    throw new Error(`Worker ${workerName} not found. Deploy once with wrangler first.`);
  }
  return worker.tag;
}

async function ensureRepoConnection() {
  const connections = await cf(`/accounts/${ACCOUNT_ID}/builds/repos/connections`);
  const existing = connections.find(
    (c) =>
      c.provider_type === "github" &&
      c.repo_name === CONFIG.github.repo &&
      c.provider_account_name?.toLowerCase() === CONFIG.github.owner.toLowerCase(),
  );
  if (existing) {
    console.log(`✓ Repo connection exists (${existing.repo_connection_uuid})`);
    return existing.repo_connection_uuid;
  }

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

  console.log(`✓ Repo connection created (${created.repo_connection_uuid})`);
  return created.repo_connection_uuid;
}

async function getBuildTokenUuid() {
  const tokens = await cf(`/accounts/${ACCOUNT_ID}/builds/tokens`);
  if (!tokens?.length) {
    throw new Error(
      "No build token found. Create one: Worker roxabi-live → Settings → Builds → API token. " +
        "Use a token with Workers Scripts + D1 + Routes edit.",
    );
  }
  const token =
    tokens.find((t) => t.build_token_name?.toLowerCase().includes("live")) ?? tokens[0];
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
    path_includes: CONFIG.pathIncludes,
    path_excludes: CONFIG.pathExcludes ?? [],
    build_caching_enabled: true,
  };
}

async function upsertTrigger(workerTag, repoConnectionUuid, buildTokenUuid, spec) {
  const triggers = await cf(`/accounts/${ACCOUNT_ID}/builds/workers/${workerTag}/triggers`);
  const existing = triggers.find((t) => t.trigger_name === spec.name);
  const body = triggerBody(repoConnectionUuid, buildTokenUuid, workerTag, spec);

  if (existing) {
    await cf(`/accounts/${ACCOUNT_ID}/builds/triggers/${existing.trigger_uuid}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    console.log(`✓ Updated trigger "${spec.name}" (${existing.trigger_uuid})`);
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
  if (!TOKEN) {
    console.error("Set CLOUDFLARE_API_TOKEN (user-scoped, Workers Builds Configuration Edit)");
    process.exit(1);
  }

  let repoConnectionUuid;
  try {
    repoConnectionUuid = await ensureRepoConnection();
  } catch (err) {
    console.error(err.message);
    console.error(
      "\nIf repo connection failed: authorize Cloudflare GitHub App in dashboard first,\n" +
        "then re-run this script.",
    );
    process.exit(1);
  }

  const buildTokenUuid = await getBuildTokenUuid();

  for (const { workerName, trigger } of CONFIG.workers) {
    const workerTag = await getWorkerTag(workerName);
    console.log(`\nWorker ${workerName} tag=${workerTag}`);
    await upsertTrigger(workerTag, repoConnectionUuid, buildTokenUuid, trigger);
  }

  console.log("\n--- Workers Builds ready ---");
  console.log("Push to main   (worker/, frontend/, wrangler.toml) → production deploy");
  console.log("Push to staging (same paths)                    → staging deploy");
  console.log(
    "\nBuild token must include D1 Edit for migrations. Runtime secrets → Worker Settings (not CI).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});