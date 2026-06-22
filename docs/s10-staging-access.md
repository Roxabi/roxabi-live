# S10 — Staging edge gate (CF Access + anti-indexing)

Staging (`roxabi-live-staging.mickael-b5e.workers.dev`) must not be publicly reachable or
indexable. Two layers:

1. **Cloudflare Access (edge)** — Email OTP before any Worker handler runs.
2. **Worker anti-indexing** — `robots.txt` + `X-Robots-Tag: noindex` on every staging response.

Prod (`live.roxabi.dev`) keeps the S7 model: GitHub OAuth at the Worker for `/dashboard` and
`/api/*`; CF Access only on `/admin/*` (+ webhook bypass).

---

## Prerequisites

- Cloudflare account `b5e90be971920ce406f7b679c4f1cd33` (`mickael@bouly.io`)
- Zero Trust → Settings → Authentication → **One-time PIN** enabled
- API token with **Access: Apps and Policies Write**

---

## Automated setup (preferred)

```bash
export CLOUDFLARE_API_TOKEN='<token>'
# Optional: comma-separated operators
export STAGING_ACCESS_EMAILS='mickael@bouly.io'

./scripts/setup-staging-access.sh
```

Creates two Access apps (order matters):

| App | Domain | Path | Policy |
|-----|--------|------|--------|
| Roxabi Live Staging — webhook bypass | `roxabi-live-staging.mickael-b5e.workers.dev` | `/webhook` | **Bypass** (Everyone) |
| Roxabi Live Staging | same | `/` (all paths) | **Allow** emails in `STAGING_ACCESS_EMAILS` |

Default allowlist: `mickael@bouly.io`. Add emails:

```bash
STAGING_ACCESS_EMAILS='mickael@bouly.io,teammate@example.com' ./scripts/setup-staging-access.sh
```

To update an existing app's policy, edit it in **Zero Trust → Access → Applications** (the
script is idempotent on create only).

---

## Manual setup (dashboard)

### 1 — Webhook bypass (create first)

Zero Trust → Access → Applications → Add → **Self-hosted**

- Name: `Roxabi Live Staging — webhook bypass`
- Domain: `roxabi-live-staging.mickael-b5e.workers.dev`
- Path: `/webhook`
- Policy: **Bypass**, include **Everyone**

### 2 — Staging gate

Add → **Self-hosted**

- Name: `Roxabi Live Staging`
- Domain: `roxabi-live-staging.mickael-b5e.workers.dev` (no path → all paths)
- Policy: **Allow**, include emails `mickael@bouly.io`
- Auth: One-time PIN, session **24 h**

### Alternative: one-click workers.dev Access

Workers & Pages → `roxabi-live-staging` → Settings → Domains & Routes →
**Enable Cloudflare Access** → **Manage Cloudflare Access** to add emails.

Still add the `/webhook` bypass app manually — the one-click toggle does not split paths.

---

## Verification

```bash
# Dashboard — must hit CF Access, NOT Worker /login:
curl -sI "https://roxabi-live-staging.mickael-b5e.workers.dev/dashboard/" \
  | grep -iE 'HTTP/|^location'
# expect: HTTP/2 302  |  Location: https://*.cloudflareaccess.com/...

# Webhook — must reach Worker (4xx without HMAC), no Access redirect:
curl -sI -X POST "https://roxabi-live-staging.mickael-b5e.workers.dev/webhook/github" \
  | grep -iE 'HTTP/|^location|cf-access'
# expect: HTTP 401/403/405  |  no Location: *.cloudflareaccess.com

# Anti-indexing (deployed Worker):
curl -s "https://roxabi-live-staging.mickael-b5e.workers.dev/robots.txt"
# expect: User-agent: *\nDisallow: /
```

After CF Access OTP, users still complete **GitHub OAuth** (`/login`) for app sessions.
Access and OAuth are stacked: edge identity first, then GitHub App membership.

---

## Worker anti-indexing

When `GITHUB_APP_SLUG=roxabi-live-staging` (see `wrangler.toml` `[env.staging.vars]`):

- `GET /robots.txt` → `Disallow: /`
- Every response gets `X-Robots-Tag: noindex, nofollow, noarchive`

This is defense-in-depth if the URL is shared or crawled before Access is enabled.