#!/usr/bin/env bash
# Load CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY from a Bitwarden Secure Note.
#
# Expected note body (JS object, not strict JSON):
#   {CF_email: "mon@email.com", CLOUDFLARE_API_KEY:"cfk_…"}
#
# Usage:
#   source scripts/bw-cloudflare-global-env.sh
#   npm run setup:workers-builds
set -euo pipefail

BW_ITEM="${BW_CF_ITEM:-cloudflare/global-api-key}"
LOGIN_SCRIPT="${AGENT_BW_LOGIN_SCRIPT:-$HOME/projects/security/vaultwarden/scripts/agent-bw-login.sh}"

if [[ -z "${BW_SESSION:-}" ]]; then
  # shellcheck source=/dev/null
  source "$LOGIN_SCRIPT"
fi

notes=""
if notes="$(bw get notes "$BW_ITEM" 2>/dev/null)" && [[ -n "$notes" ]]; then
  :
else
  # Org-shared items may have an empty name — match Secure Note in agents/cloudflare collection.
  item_id="$(
    bw list items --search cloudflare 2>/dev/null \
      | python3 -c "
import json, sys
items = json.load(sys.stdin)
for it in items:
    if it.get('type') == 2 and 'global-api' in (it.get('name') or '').lower():
        print(it['id'])
        break
else:
    for it in items:
        if it.get('type') == 2 and it.get('organizationId'):
            print(it['id'])
            break
" 2>/dev/null || true
  )"
  if [[ -n "${item_id:-}" ]]; then
    notes="$(bw get notes "$item_id" 2>/dev/null || true)"
  fi
fi

if [[ -z "${notes:-}" ]]; then
  echo "Bitwarden: could not read Secure Note \"$BW_ITEM\" (decrypt org items or duplicate note in agent vault)." >&2
  return 1 2>/dev/null || exit 1
fi

parsed="$(
  NOTES="$notes" python3 - <<'PY'
import os, re, shlex

raw = os.environ.get("NOTES", "")
email = None
api_key = None

for pattern in (
    r'CF_email\s*:\s*"([^"]+)"',
    r'cf_email\s*:\s*"([^"]+)"',
    r'CLOUDFLARE_EMAIL\s*:\s*"([^"]+)"',
):
    m = re.search(pattern, raw)
    if m:
        email = m.group(1)
        break

m = re.search(r'CLOUDFLARE_API_KEY\s*:\s*"([^"]+)"', raw)
if m:
    api_key = m.group(1)

if not email or not api_key:
    raise SystemExit("Secure Note missing CF_email or CLOUDFLARE_API_KEY")

print(f"export CLOUDFLARE_EMAIL={shlex.quote(email)}")
print(f"export CLOUDFLARE_API_KEY={shlex.quote(api_key)}")
PY
)"

eval "$parsed"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-b5e90be971920ce406f7b679c4f1cd33}"
unset CLOUDFLARE_API_TOKEN CF_API_TOKEN