#!/usr/bin/env node
/**
 * Register Workers Builds token "roxabi-live-build" for roxabi-live API deploys.
 * Uses the existing user API token roxabi-live-workers-build (Bitwarden deploy token).
 *
 * Prerequisites:
 *   CLOUDFLARE_BUILDS_ADMIN_TOKEN — Workers Builds Configuration Edit
 *   CLOUDFLARE_LIVE_DEPLOY_TOKEN — roxabi-live-workers-build secret (cfut_…)
 *
 * Usage:
 *   source scripts/bw-cloudflare-live-build-env.sh
 *   export CLOUDFLARE_LIVE_DEPLOY_TOKEN="$CLOUDFLARE_API_TOKEN"
 *   export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_BUILDS_ADMIN_TOKEN"
 *   node scripts/setup-live-build-token.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_ID, assertCfCredentials, cf } from "./lib/cf-access.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "infra/workers-builds.json"), "utf8"));
const BUILD_TOKEN_NAME = CONFIG.buildTokenName ?? "roxabi-live-build";
const CF_TOKEN_ID = CONFIG.buildCloudflareTokenId ?? "9dfd88902b221961e377ab2a0eb4b1d4";

async function main() {
  const deploySecret = process.env.CLOUDFLARE_LIVE_DEPLOY_TOKEN;
  if (!deploySecret) {
    throw new Error(
      "Set CLOUDFLARE_LIVE_DEPLOY_TOKEN to the roxabi-live-workers-build API token secret",
    );
  }

  assertCfCredentials();

  const tokens = await cf(`/accounts/${ACCOUNT_ID}/builds/tokens`);
  const existing = tokens.find((t) => t.build_token_name === BUILD_TOKEN_NAME);
  if (existing) {
    if (existing.cloudflare_token_id === CF_TOKEN_ID) {
      console.log(`✓ Build token ${BUILD_TOKEN_NAME} already registered (${existing.build_token_uuid})`);
      return;
    }
    console.log(
      `⚠ Build token ${BUILD_TOKEN_NAME} exists but points to ${existing.cloudflare_token_id} — expected ${CF_TOKEN_ID}`,
    );
    return;
  }

  const created = await cf(`/accounts/${ACCOUNT_ID}/builds/tokens`, {
    method: "POST",
    body: JSON.stringify({
      build_token_name: BUILD_TOKEN_NAME,
      build_token_secret: deploySecret,
      cloudflare_token_id: CF_TOKEN_ID,
    }),
  });

  console.log(`✓ Registered ${BUILD_TOKEN_NAME} (${created.build_token_uuid})`);
  console.log(`  cloudflare_token_id: ${created.cloudflare_token_id}`);
  console.log("Next: bun run setup:workers-builds  # rebind API triggers to this token");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});