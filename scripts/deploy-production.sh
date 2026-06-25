#!/usr/bin/env bash
# Workers Builds deploy command for the API worker — D1 migrate + wrangler deploy (production).
# Trigger: push to main touching scripts/deploy-*.sh. Post-monorepo-cutover the
# worker lives at apps/api/ (bun workspace); the SPA (apps/app) and marketing
# (apps/marketing) deploy via their own CF targets.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_ACCOUNT_ID:=b5e90be971920ce406f7b679c4f1cd33}"
export CLOUDFLARE_ACCOUNT_ID

echo "→ workspace deps (bun)"
bun install --frozen-lockfile

cd apps/api

echo "→ D1 migrations (production)"
bunx wrangler d1 migrations apply DB --remote

echo "→ wrangler deploy (production)"
bunx wrangler deploy --old-asset-ttl 0

echo "✓ roxabi-live (api) production deployed"
