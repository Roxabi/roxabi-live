#!/usr/bin/env bash
# Register roxabi-live-build Workers Builds token (needs deploy + admin creds from BW).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/bw-cloudflare-live-build-env.sh
source "$ROOT/scripts/bw-cloudflare-live-build-env.sh"
export CLOUDFLARE_LIVE_DEPLOY_TOKEN="$CLOUDFLARE_API_TOKEN"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_BUILDS_ADMIN_TOKEN:?Missing CLOUDFLARE_BUILDS_ADMIN_TOKEN}"
exec node "$ROOT/scripts/setup-live-build-token.mjs"