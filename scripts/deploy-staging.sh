#!/usr/bin/env bash
# Workers Builds deploy command — D1 migrate + wrangler deploy (staging).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_ACCOUNT_ID:=b5e90be971920ce406f7b679c4f1cd33}"
export CLOUDFLARE_ACCOUNT_ID

echo "→ worker deps"
cd worker && npm ci

echo "→ D1 migrations (staging)"
npx wrangler d1 migrations apply DB --env staging --remote --config ../wrangler.toml

echo "→ wrangler deploy (staging)"
npx wrangler deploy --env staging --old-asset-ttl 0 --config ../wrangler.toml

echo "✓ roxabi-live-staging deployed"