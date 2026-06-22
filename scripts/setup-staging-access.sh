#!/usr/bin/env bash
# Provision Cloudflare Access on the staging workers.dev URL.
#
# Auth (either):
#   export CLOUDFLARE_API_TOKEN=…   # Access: Apps and Policies Write
#   source scripts/bw-cloudflare-global-env.sh   # global API key via Bitwarden
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:=b5e90be971920ce406f7b679c4f1cd33}"

STAGING_HOST="${STAGING_HOST:-roxabi-live-staging.mickael-b5e.workers.dev}"
# Comma-separated allowlist — extend when onboarding more operators.
STAGING_ACCESS_EMAILS="${STAGING_ACCESS_EMAILS:-mickael@bouly.io}"

API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps"

cf_auth_args() {
  if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
    printf '%s\n' "-H" "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    return 0
  fi
  if [[ -n "${CLOUDFLARE_EMAIL:-}" && -n "${CLOUDFLARE_API_KEY:-}" ]]; then
    printf '%s\n' "-H" "X-Auth-Email: ${CLOUDFLARE_EMAIL}" "-H" "X-Auth-Key: ${CLOUDFLARE_API_KEY}"
    return 0
  fi
  echo "Set CLOUDFLARE_API_TOKEN or source scripts/bw-cloudflare-global-env.sh" >&2
  return 1
}

cf_json() {
  local -a auth
  mapfile -t auth < <(cf_auth_args)
  curl -fsS "${auth[@]}" -H "Content-Type: application/json" "$@"
}

list_apps() {
  cf_json "${API}?per_page=50"
}

app_exists() {
  local name="$1"
  list_apps | jq -e --arg n "$name" '.result[] | select(.name == $n) | .id' >/dev/null
}

email_includes_json() {
  local emails_csv="$1"
  local arr="["
  local first=1
  IFS=',' read -ra parts <<< "$emails_csv"
  for raw in "${parts[@]}"; do
    local email
    email="$(echo "$raw" | xargs)"
    [[ -z "$email" ]] && continue
    [[ $first -eq 0 ]] && arr+=","
    first=0
    arr+="$(jq -nc --arg e "$email" '{email:{email:$e}}')"
  done
  arr+="]"
  echo "$arr"
}

webhook_bypass_payload() {
  local name="Roxabi Live Staging — webhook bypass"
  # Path is embedded in domain (same shape as prod live.roxabi.dev/webhook).
  jq -nc \
    --arg name "$name" \
    --arg domain "${STAGING_HOST}/webhook" \
    '{
      name: $name,
      type: "self_hosted",
      domain: $domain,
      session_duration: "24h",
      app_launcher_visible: false,
      policies: [
        {
          name: "GitHub webhook bypass",
          decision: "bypass",
          include: [{ everyone: {} }],
          precedence: 1
        }
      ]
    }'
}

create_webhook_bypass_app() {
  local name="Roxabi Live Staging — webhook bypass"
  local app_id domain
  app_id="$(list_apps | jq -r --arg n "$name" '.result[] | select(.name == $n) | .id' | head -1)"
  domain="${STAGING_HOST}/webhook"
  if [[ -n "$app_id" ]]; then
    local current
    current="$(cf_json "${API}/${app_id}" | jq -r '.result.domain')"
    if [[ "$current" == "$domain" ]]; then
      echo "✓ Access app already exists: ${name}"
      return 0
    fi
    echo "→ Updating Access app domain: ${name} (${current} → ${domain})"
    cf_json --request PUT "${API}/${app_id}" --data "$(webhook_bypass_payload)" >/dev/null
    echo "✓ ${name} (updated)"
    return 0
  fi
  echo "→ Creating Access app: ${name}"
  cf_json --request POST "$API" --data "$(webhook_bypass_payload)" >/dev/null
  echo "✓ ${name}"
}

create_staging_gate_app() {
  local name="Roxabi Live Staging"
  if app_exists "$name"; then
    echo "✓ Access app already exists: ${name}"
    return 0
  fi
  local includes
  includes="$(email_includes_json "$STAGING_ACCESS_EMAILS")"
  echo "→ Creating Access app: ${name} (emails: ${STAGING_ACCESS_EMAILS})"
  cf_json --request POST "$API" --data "$(jq -nc \
    --arg name "$name" \
    --arg domain "$STAGING_HOST" \
    --argjson includes "$includes" \
    '{
      name: $name,
      type: "self_hosted",
      domain: $domain,
      session_duration: "24h",
      app_launcher_visible: false,
      policies: [
        {
          name: "Allow staging operators",
          decision: "allow",
          include: $includes,
          precedence: 1
        }
      ]
    }')"
  echo "✓ ${name}"
}

verify_gate() {
  echo "→ Verifying edge gate"
  local code location
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://${STAGING_HOST}/dashboard/")"
  location="$(curl -sI "https://${STAGING_HOST}/dashboard/" | awk 'tolower($1)=="location:" {print $2}' | tr -d '\r')"
  if [[ "$code" == "302" && "$location" == *"cloudflareaccess.com"* ]]; then
    echo "✓ Dashboard redirects to Cloudflare Access (${code})"
  else
    echo "⚠ Expected CF Access redirect; got HTTP ${code} location=${location:-none}" >&2
    return 1
  fi

  local webhook_code
  webhook_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://${STAGING_HOST}/webhook/github")"
  if [[ "$webhook_code" != "302" ]]; then
    echo "✓ /webhook/github bypasses Access (HTTP ${webhook_code}, Worker HMAC gate)"
  else
    echo "⚠ /webhook/github still redirects to Access — check bypass app path precedence" >&2
    return 1
  fi
}

echo "Account: ${CLOUDFLARE_ACCOUNT_ID}"
echo "Host:    ${STAGING_HOST}"

# More-specific /webhook app must exist before the catch-all OTP app (prod runbook pattern).
create_webhook_bypass_app
create_staging_gate_app
verify_gate

echo "✓ Staging CF Access configured"