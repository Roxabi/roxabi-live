#!/usr/bin/env bash
# Load roxabi-live Workers Builds / deploy credentials from Bitwarden.
#
# Expected note body (JS object, not strict JSON):
#   {CLOUDFLARE_API_TOKEN: "cfut_…", CLOUDFLARE_ACCOUNT_ID: "…"}
#
# Usage:
#   source scripts/bw-cloudflare-live-build-env.sh
#   export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_BUILDS_ADMIN_TOKEN" && bun run setup:workers-builds
#   bash scripts/deploy-production.sh   # break-glass (uses CLOUDFLARE_API_TOKEN deploy token)
set -euo pipefail

BW_ITEM="${BW_CF_LIVE_BUILD_ITEM:-cloudflare/roxabi-live-build-token}"
LOGIN_SCRIPT="${AGENT_BW_LOGIN_SCRIPT:-$HOME/projects/security/vaultwarden/scripts/agent-bw-login.sh}"

if [[ -z "${BW_SESSION:-}" ]]; then
  # shellcheck source=/dev/null
  source "$LOGIN_SCRIPT"
fi

notes=""
if notes="$(bw get notes "$BW_ITEM" 2>/dev/null)" && [[ -n "$notes" ]]; then
  :
else
  item_id="$(
    bw list items --search roxabi-live-build 2>/dev/null \
      | python3 -c "
import json, sys
items = json.load(sys.stdin)
for it in items:
    if it.get('type') == 2 and 'roxabi-live-build' in (it.get('name') or '').lower():
        print(it['id'])
        break
" 2>/dev/null || true
  )"
  if [[ -n "${item_id:-}" ]]; then
    notes="$(bw get notes "$item_id" 2>/dev/null || true)"
  fi
fi

if [[ -z "${notes:-}" ]]; then
  echo "Bitwarden: could not read Secure Note \"$BW_ITEM\"." >&2
  return 1 2>/dev/null || exit 1
fi

parsed="$(
  NOTES="$notes" python3 - <<'PY'
import os, re, shlex

raw = os.environ.get("NOTES", "")
token = None
account = None
admin = None

m = re.search(r'CLOUDFLARE_API_TOKEN\s*[=:]\s*"([^"]+)"', raw)
if m:
    token = m.group(1)

m = re.search(r'CLOUDFLARE_BUILDS_ADMIN_TOKEN\s*[=:]\s*"([^"]+)"', raw)
if m:
    admin = m.group(1)

for pattern in (
    r'CLOUDFLARE_ACCOUNT_ID\s*[=:]\s*"([^"]+)"',
    r'CF_ACCOUNT_ID\s*[=:]\s*"([^"]+)"',
):
    m = re.search(pattern, raw)
    if m:
        account = m.group(1)
        break

if not token:
    raise SystemExit("Secure Note missing CLOUDFLARE_API_TOKEN")

print(f"export CLOUDFLARE_API_TOKEN={shlex.quote(token)}")
print(f"export CF_API_TOKEN={shlex.quote(token)}")
if admin:
    print(f"export CLOUDFLARE_BUILDS_ADMIN_TOKEN={shlex.quote(admin)}")
if account:
    print(f"export CLOUDFLARE_ACCOUNT_ID={shlex.quote(account)}")
PY
)"

eval "$parsed"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-b5e90be971920ce406f7b679c4f1cd33}"
unset CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CF_API_KEY