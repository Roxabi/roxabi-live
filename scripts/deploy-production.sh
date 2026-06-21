#!/usr/bin/env bash
# Workers Builds deploy command — D1 migrate + wrangler deploy (production).
# Trigger: push to main touching scripts/deploy-*.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_ACCOUNT_ID:=b5e90be971920ce406f7b679c4f1cd33}"
export CLOUDFLARE_ACCOUNT_ID

echo "→ worker deps"
cd worker && npm ci

echo "→ D1 migrations (production)"
npx wrangler d1 migrations apply DB --remote --config ../wrangler.toml

echo "→ wrangler deploy (production)"
npx wrangler deploy --old-asset-ttl 0 --config ../wrangler.toml

echo "✓ roxabi-live production deployed"