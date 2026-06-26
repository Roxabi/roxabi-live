#!/usr/bin/env bash
# Move apex live.roxabi.dev from roxabi-live (legacy api worker) to roxabi-live-marketing.
# Requires CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY (source scripts/bw-cloudflare-global-env.sh).
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:=b5e90be971920ce406f7b679c4f1cd33}"
APEX="live.roxabi.dev"

list_domains() {
  curl -s "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" \
    -H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" \
    -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}"
}

delete_domain() {
  local id="$1"
  curl -s -X DELETE \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains/${id}" \
    -H "X-Auth-Email: ${CLOUDFLARE_EMAIL}" \
    -H "X-Auth-Key: ${CLOUDFLARE_API_KEY}"
}

domain_id="$(list_domains | python3 -c "
import json, sys
data = json.load(sys.stdin)
for d in data.get('result', []):
    if d.get('hostname') == '${APEX}':
        print(d['id'])
        break
")"

if [[ -z "${domain_id}" ]]; then
  echo "✓ No worker domain on ${APEX} — safe to deploy roxabi-live-marketing"
  exit 0
fi

service="$(list_domains | python3 -c "
import json, sys
data = json.load(sys.stdin)
for d in data.get('result', []):
    if d.get('hostname') == '${APEX}':
        print(d.get('service',''))
        break
")"

echo "→ ${APEX} currently on worker: ${service}"
if [[ "${service}" != "roxabi-live" ]]; then
  echo "Refusing to delete — unexpected service. Reconcile manually in the dashboard." >&2
  exit 1
fi

echo "→ Removing ${APEX} from roxabi-live (api worker keeps api.live.roxabi.dev)"
delete_domain "${domain_id}" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)"
echo "✓ Apex detached — run: cd apps/marketing && bunx wrangler deploy --config wrangler.deploy.jsonc"