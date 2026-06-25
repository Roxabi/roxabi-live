#!/usr/bin/env bash
# Workers Builds deploy command for the API worker — D1 migrate + wrangler deploy (staging).
# Post-monorepo-cutover the worker lives at apps/api/ (bun workspace).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_ACCOUNT_ID:=b5e90be971920ce406f7b679c4f1cd33}"
export CLOUDFLARE_ACCOUNT_ID

echo "→ workspace deps (bun)"
bun install --frozen-lockfile

cd apps/api

echo "→ D1 migrations (staging)"
bunx wrangler d1 migrations apply DB --env staging --remote

echo "→ wrangler deploy (staging)"
bunx wrangler deploy --env staging --old-asset-ttl 0

echo "✓ roxabi-live-staging deployed"
