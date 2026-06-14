# Self-Hosting Guide

End-to-end instructions to go from a fresh fork to a running deployment on Cloudflare Workers.

---

## 0. What you'll provision

**Checklist — gather or create each before starting:**

- [ ] Cloudflare account (free tier is sufficient for the Worker + D1 + R2)
- [ ] Cloudflare account ID (Dashboard → top-right account switcher → copy ID)
- [ ] A Cloudflare API token with Worker + D1 + R2 + Secret permissions (see step 2)
- [ ] Two D1 databases: `<your-app>-production` and `<your-app>-staging`
- [ ] Two R2 buckets: `<your-app>-logs` and `<your-app>-logs-staging`
- [ ] A custom domain configured in Cloudflare DNS **OR** use the free `*.workers.dev` subdomain
- [ ] A GitHub organization you administer (the App will be installed on it)
- [ ] A GitHub App registered in that org or your personal account (step 4)
- [ ] Node 20 and `npm` installed locally
- [ ] Wrangler CLI available via `npx` (no global install required; `wrangler ^3.99.0` is in `worker/devDependencies`)

**Prerequisites — local tools:**

```bash
node --version   # must be 20.x
npm --version    # comes with Node
npx wrangler --version   # pulls from worker/node_modules after npm ci
```

---

## 1. Fork & clone

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/<YOUR_ORG>/<YOUR_FORK>.git
cd <YOUR_FORK>
cd worker && npm ci && cd ..
```

The wrangler config file (`wrangler.toml`) lives at the **repo root**, not inside `worker/`.
All `wrangler` commands below pass `--config ../wrangler.toml` when run from `worker/`.

---

## 2. Cloudflare resources

### 2a. Get your account ID

```bash
# After logging in to the Cloudflare dashboard:
# Dashboard → top-right → "Account Home" → copy the Account ID shown in the URL or sidebar
# Format: 32 hex characters, e.g. b5e90be971920ce406f7b679c4f1cd33
export CLOUDFLARE_ACCOUNT_ID=<YOUR_ACCOUNT_ID>
```

> **Why this matters:** the Cloudflare API token used for deployment may have access to
> multiple accounts. Wrangler requires `CLOUDFLARE_ACCOUNT_ID` to be set or it returns
> a 403 when running `d1 migrations apply --remote` or `d1 execute --remote`. Export it
> in every shell session where you run wrangler commands.

### 2b. Create a Cloudflare API token

Dashboard → My Profile → API Tokens → Create Token → Custom Token:

| Permission | Resource | Access |
|---|---|---|
| Account / Workers Scripts | All accounts | Edit |
| Account / D1 | All accounts | Edit |
| Account / R2 Storage | All accounts | Edit |
| Zone / Workers Routes | All zones (or specific zone) | Edit |

Save the token — you will add it as `CF_API_TOKEN` in GitHub repo secrets (step 6).

### 2c. Create D1 databases

```bash
cd worker

# Production database
npx wrangler d1 create <YOUR_APP>-production --config ../wrangler.toml
# Note the output: database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# Staging database
npx wrangler d1 create <YOUR_APP>-staging --config ../wrangler.toml
# Note the output: database_id = "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
```

### 2d. Create R2 buckets

```bash
cd worker

# Production audit log bucket
npx wrangler r2 bucket create <YOUR_APP>-logs --config ../wrangler.toml

# Staging audit log bucket
npx wrangler r2 bucket create <YOUR_APP>-logs-staging --config ../wrangler.toml
```

---

## 3. Edit wrangler.toml

Replace the Roxabi-specific values with your own. Fields to change:

```toml
# Top-level Worker name (prod)
name = "<YOUR_APP>"                        # was: "roxabi-live"

# Custom domain — remove this block if using workers.dev instead:
routes = [
  { pattern = "<YOUR_DOMAIN>", custom_domain = true },
]
# If using workers.dev (no custom domain), replace with:
# workers_dev = true
# routes = []

# Prod D1 binding
[[d1_databases]]
binding        = "DB"
database_name  = "<YOUR_APP>-production"  # was: "roxabi-live-production"
database_id    = "<PROD_DB_ID>"           # captured in step 2c
migrations_dir = "worker/migrations"

# Prod R2 bucket
[[r2_buckets]]
binding     = "LOGS"
bucket_name = "<YOUR_APP>-logs"           # was: "roxabi-live-logs"

# Staging env — Worker name
[env.staging]
name = "<YOUR_APP>-staging"               # was: "roxabi-live-staging"
workers_dev = true
routes = []    # KEEP THIS — see note below

# Staging D1 binding
[[env.staging.d1_databases]]
binding        = "DB"
database_name  = "<YOUR_APP>-staging"     # was: "roxabi-live-staging"
database_id    = "<STAGING_DB_ID>"        # captured in step 2c
migrations_dir = "worker/migrations"

# Staging R2 bucket
[[env.staging.r2_buckets]]
binding     = "LOGS"
bucket_name = "<YOUR_APP>-logs-staging"   # was: "roxabi-live-logs-staging"
```

> **routes=[] gotcha (staging):** `routes` is an inheritable wrangler key. Without
> `routes = []` in `[env.staging]`, a staging deploy would inherit the top-level custom
> domain entry and bind your production domain to the staging Worker. Always keep
> `routes = []` in the staging env block. This is distinct from `[[d1_databases]]` and
> `[[r2_buckets]]`, which are NOT inherited and must be repeated per env.

---

## 4. Register the GitHub App

### 4a. Create the App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App (or use your org's settings page for an org-owned App).

**Fill in:**

| Field | Value |
|---|---|
| GitHub App name | `<YOUR_APP>` (must be unique on GitHub) |
| Homepage URL | `https://<YOUR_DOMAIN>` |
| Webhook URL | `https://<YOUR_DOMAIN>/webhook/github` |
| Webhook secret | A strong random string — **save it** as `GITHUB_WEBHOOK_SECRET` |

**Permissions (Repository):**

| Permission | Level |
|---|---|
| Issues | Read |
| Metadata | Read (mandatory) |
| Pull requests | Read |

**Permissions (Organization):**

| Permission | Level |
|---|---|
| Members | Read |

**Subscribe to events:**

- `issues`
- `sub_issues`
- `issue_comment` (optional — for future use)
- `pull_request`

**OAuth settings:**

| Field | Value |
|---|---|
| Callback URL | `https://<YOUR_DOMAIN>/oauth/callback` |
| Expire user authorization tokens | Yes (recommended) |
| Request user authorization (OAuth) during installation | Yes |

**After creation — note:**

- **App ID** (numeric, shown on the App settings page) → `GITHUB_APP_ID`
- **Client ID** (shown on the App settings page) → `GITHUB_APP_CLIENT_ID`

**Generate a Client Secret:**

App settings → Generate a new client secret → save as `GITHUB_APP_CLIENT_SECRET`.

**Generate a Private Key:**

App settings → Private keys → Generate a private key → downloads a `.pem` file.

Convert to base64-encoded PKCS#8 DER (the format the Worker expects):

```bash
# Convert PEM RSA key to PKCS#8 DER, then base64-encode it:
openssl pkcs8 -topk8 -inform PEM -outform DER -nocrypt \
  -in <downloaded-key>.pem \
  | base64 -w 0
# Copy the single-line base64 output → GITHUB_APP_PRIVATE_KEY
```

**Generate a Webhook Secret for the App-level webhook** (distinct from the org webhook):

```bash
openssl rand -hex 32
# Save this as GITHUB_APP_WEBHOOK_SECRET
```

**Generate the AES-GCM DEK for install token encryption:**

```bash
openssl rand -base64 32
# Save this as INSTALL_TOKEN_KEY (exactly 32 bytes decoded = 256-bit AES key)
```

### 4b. Install the App on your org

GitHub App settings → Install App → select your organization → Install.

After installation, the App is assigned an **installation ID** (visible in the URL:
`/organizations/<org>/settings/installations/<installation_id>`).

The Worker discovers and stores this automatically via the OAuth flow (first `/login` visit
seeds the tenant). No manual seeding is required.

> **Install URL pattern** (if you need to send users to install): 
> `https://github.com/apps/<YOUR_APP_SLUG>/installations/new`
> Replace `<YOUR_APP_SLUG>` with the slugified App name GitHub assigned.

---

## 5. Set Worker secrets

Run these from the `worker/` directory. All commands pass `--config ../wrangler.toml`.
Export `CLOUDFLARE_ACCOUNT_ID` before running.

```bash
cd worker
export CLOUDFLARE_ACCOUNT_ID=<YOUR_ACCOUNT_ID>
```

### Required secrets — set for BOTH prod and staging

For each secret, run the command once without `--env staging` (prod) and once with
`--env staging` (staging). Use the same value for both unless you have separate Apps.

```bash
# Org-level webhook HMAC secret (must match the Webhook secret set in step 4a)
printf %s '<GITHUB_WEBHOOK_SECRET>' \
  | npx wrangler secret put GITHUB_WEBHOOK_SECRET --config ../wrangler.toml
printf %s '<GITHUB_WEBHOOK_SECRET>' \
  | npx wrangler secret put GITHUB_WEBHOOK_SECRET --env staging --config ../wrangler.toml

# GitHub App numeric ID
printf %s '<GITHUB_APP_ID>' \
  | npx wrangler secret put GITHUB_APP_ID --config ../wrangler.toml
printf %s '<GITHUB_APP_ID>' \
  | npx wrangler secret put GITHUB_APP_ID --env staging --config ../wrangler.toml

# GitHub App OAuth client ID
printf %s '<GITHUB_APP_CLIENT_ID>' \
  | npx wrangler secret put GITHUB_APP_CLIENT_ID --config ../wrangler.toml
printf %s '<GITHUB_APP_CLIENT_ID>' \
  | npx wrangler secret put GITHUB_APP_CLIENT_ID --env staging --config ../wrangler.toml

# GitHub App OAuth client secret
printf %s '<GITHUB_APP_CLIENT_SECRET>' \
  | npx wrangler secret put GITHUB_APP_CLIENT_SECRET --config ../wrangler.toml
printf %s '<GITHUB_APP_CLIENT_SECRET>' \
  | npx wrangler secret put GITHUB_APP_CLIENT_SECRET --env staging --config ../wrangler.toml

# GitHub App RSA private key (base64 PKCS#8 DER from step 4a)
printf %s '<GITHUB_APP_PRIVATE_KEY>' \
  | npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config ../wrangler.toml
printf %s '<GITHUB_APP_PRIVATE_KEY>' \
  | npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging --config ../wrangler.toml

# App-level webhook secret (from step 4a — distinct from org webhook secret).
# Note: the live POST /webhook/github handler verifies HMAC against GITHUB_WEBHOOK_SECRET
# (org-level, above), NOT this GITHUB_APP_WEBHOOK_SECRET. This one is present in the Env
# interface for completeness but is not read on the request path; set it anyway for parity.
printf %s '<GITHUB_APP_WEBHOOK_SECRET>' \
  | npx wrangler secret put GITHUB_APP_WEBHOOK_SECRET --config ../wrangler.toml
printf %s '<GITHUB_APP_WEBHOOK_SECRET>' \
  | npx wrangler secret put GITHUB_APP_WEBHOOK_SECRET --env staging --config ../wrangler.toml

# AES-GCM DEK for encrypting install tokens at rest (base64, 32 bytes, from step 4a)
printf %s '<INSTALL_TOKEN_KEY>' \
  | npx wrangler secret put INSTALL_TOKEN_KEY --config ../wrangler.toml
printf %s '<INSTALL_TOKEN_KEY>' \
  | npx wrangler secret put INSTALL_TOKEN_KEY --env staging --config ../wrangler.toml

# GitHub org slug to sync (e.g. "MyOrg") — treated as a secret in practice
printf %s '<YOUR_GITHUB_ORG>' \
  | npx wrangler secret put GITHUB_ORG --config ../wrangler.toml
printf %s '<YOUR_GITHUB_ORG>' \
  | npx wrangler secret put GITHUB_ORG --env staging --config ../wrangler.toml
```

### Optional secrets

```bash
# Bearer token for POST /admin/sync defense-in-depth gate.
# If unset, the Worker-level gate is disabled (CF Access alone guards /admin/*).
printf %s '<YOUR_ADMIN_TOKEN>' \
  | npx wrangler secret put ADMIN_TOKEN --config ../wrangler.toml
printf %s '<YOUR_ADMIN_TOKEN>' \
  | npx wrangler secret put ADMIN_TOKEN --env staging --config ../wrangler.toml

# Webhook URL for sync circuit-breaker halt/auth-failure alerts.
# If unset, no external notification is sent.
printf %s '<YOUR_NOTIFY_URL>' \
  | npx wrangler secret put NOTIFY_URL --config ../wrangler.toml
printf %s '<YOUR_NOTIFY_URL>' \
  | npx wrangler secret put NOTIFY_URL --env staging --config ../wrangler.toml
```

**Verify secrets are set:**

```bash
npx wrangler secret list --config ../wrangler.toml
npx wrangler secret list --env staging --config ../wrangler.toml
```

---

## 6. CI repo secrets

Set these in GitHub: repo → Settings → Secrets and variables → Actions → New repository secret.

| Secret name | Value | Purpose |
|---|---|---|
| `CF_API_TOKEN` | Cloudflare API token from step 2b | `wrangler deploy` + D1 migrations |
| `CLOUDFLARE_ACCOUNT_ID` | Your 32-char account ID | Required — token may see multiple accounts |
| `GH_APP_ID` | GitHub App numeric ID | Post-deploy injection as `GITHUB_APP_ID` Worker secret |
| `GH_APP_PRIVATE_KEY` | base64 PKCS#8 DER private key | Post-deploy injection as `GITHUB_APP_PRIVATE_KEY` |
| `GH_APP_WEBHOOK_SECRET` | App webhook secret | Post-deploy injection as `GITHUB_APP_WEBHOOK_SECRET` |
| `GH_INSTALL_TOKEN_KEY` | base64 AES-GCM DEK | Post-deploy injection as `INSTALL_TOKEN_KEY` |

> **Why `GH_APP_*` instead of `GITHUB_APP_*`?** GitHub Actions forbids repository secret
> names that start with `GITHUB_` (returns 422 on create). The CI workflow maps
> `GH_APP_*` → `GITHUB_APP_*` Worker secrets in a post-deploy injection step.
> Only these four (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`,
> `INSTALL_TOKEN_KEY`) are injected by CI. The remaining Worker secrets —
> `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_ORG`,
> and the optional `ADMIN_TOKEN` / `NOTIFY_URL` — are **not** injected by CI; set them
> manually via `wrangler secret put` (step 5) or add your own injection steps.

Once `CF_API_TOKEN` is set, every push to `staging` or `main` automatically:
1. Applies D1 migrations
2. Deploys the Worker
3. Injects the four App secrets listed above

---

## 7. Apply migrations

### Via CI (recommended)

Push to `staging` triggers the `deploy` job, which applies migrations automatically before
deploying. Push to `main` for production.

### Manually

```bash
cd worker
export CLOUDFLARE_ACCOUNT_ID=<YOUR_ACCOUNT_ID>

# Staging
npx wrangler d1 migrations apply DB --env staging --remote --config ../wrangler.toml

# Production
npx wrangler d1 migrations apply DB --remote --config ../wrangler.toml
```

Migrations are applied in order:

```
0001_initial.sql
0002_repos.sql
0003_data_version.sql
0004_tenancy_auth.sql
0005_sync_slot_seed.sql
0006_sync_started_at_seed.sql
0007_repo_access_is_private.sql
0008_tenant_not_null.sql
```

Wrangler tracks applied migrations and skips already-applied ones — safe to re-run.

---

## 8. Deploy

### Via CI (recommended)

```bash
git push origin staging   # deploys to staging Worker
git push origin main      # deploys to production Worker
```

The `deploy` job is a no-op if `CF_API_TOKEN` is not set — it logs a notice and exits
green, so CI is safe to enable before credentials are provisioned.

### Manual deploy

```bash
cd worker
export CLOUDFLARE_ACCOUNT_ID=<YOUR_ACCOUNT_ID>
export CLOUDFLARE_API_TOKEN=<YOUR_CF_API_TOKEN>

# Staging
npx wrangler deploy --env staging --config ../wrangler.toml

# Production
npx wrangler deploy --config ../wrangler.toml
```

---

## 9. First run & verify

### Health check

```bash
# Replace with your Worker URL (workers.dev or custom domain):
curl https://<YOUR_DOMAIN>/health
# Expected: 200 JSON with issue count (0 before first sync)

curl https://<YOUR_DOMAIN>/api/version
# Expected: 200 JSON with data_version timestamp
```

### Sign in

1. Open `https://<YOUR_DOMAIN>` in a browser.
2. The frontend auth gate redirects to `/login`.
3. Authorize the GitHub App → OAuth callback sets the `__Host-session` cookie.
4. If your App is not yet installed on any org, GitHub redirects you to the install page
   (`https://github.com/apps/<YOUR_APP_SLUG>/installations/new`). Install it, then return.
5. The dashboard loads — issues and graph are empty until after the first sync.

### Trigger a sync

The cron runs hourly at minute 0 (`0 * * * *`). To trigger immediately:

```bash
# Requires ADMIN_TOKEN to be set (step 5):
curl -X POST https://<YOUR_DOMAIN>/admin/sync \
  -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>"
# Expected: 200 (or 202) — sync queued/started
```

If `ADMIN_TOKEN` is not set and you have Cloudflare Access on `/admin/*`, authenticate
via the Access OTP challenge first (browser flow or `cf-access-*` service token).

After the sync completes, refresh the dashboard — issues and the dependency graph appear.

---

## 10. Auth model

The app uses **GitHub App OAuth for all user-facing auth**. Visiting `/login` starts
the OAuth flow; the callback at `/oauth/callback` exchanges the code for a GitHub token,
resolves the user's org installations, creates a D1 session, and sets a `__Host-session`
cookie (HttpOnly; Secure; SameSite=Strict; 8-hour TTL). All `/api/*` routes require a
valid session (the `requireSession` middleware returns 401 if the cookie is absent or
expired). No personal data leaves the Worker except what GitHub provides in the OAuth
response.

`/admin/*` has an **additional** layer: an `ADMIN_TOKEN` Bearer check in the Worker
(defense-in-depth). You may also place Cloudflare Access Email-OTP in front of
`/admin/*` at the edge for a second factor. The `/webhook/github` route has a CF Access
Bypass (if Access is configured) so that GitHub can reach it; the Worker validates
every webhook request via HMAC-SHA256 (`X-Hub-Signature-256`, `GITHUB_WEBHOOK_SECRET`).

For CF Access setup on `/admin/*` see [docs/s7-access-cutover.md](s7-access-cutover.md).

---

## 11. Troubleshooting

### 403 on `wrangler d1 migrations apply --remote`

The API token sees more than one Cloudflare account. Export `CLOUDFLARE_ACCOUNT_ID`
before running any remote wrangler command:

```bash
export CLOUDFLARE_ACCOUNT_ID=<YOUR_ACCOUNT_ID>
```

### Graph is empty after first login

The graph is built from synced data. Either wait for the hourly cron (fires at `:00`) or
trigger a manual sync via `POST /admin/sync`. After sync, reload the dashboard.

`is_private` values for repos default to `1` (fail-closed, migration 0007). The hourly
sync corrects these from the GitHub API. After the first successful sync, private/public
status will be accurate.

### Webhook returns 401 or signature failure

The `GITHUB_WEBHOOK_SECRET` set in the Worker must exactly match the webhook secret
configured on the GitHub org webhook (or App webhook). Trailing newlines in the secret
break HMAC verification — use `printf %s '<secret>'` (not `echo`) when setting the
secret:

```bash
printf %s '<GITHUB_WEBHOOK_SECRET>' \
  | npx wrangler secret put GITHUB_WEBHOOK_SECRET --config ../wrangler.toml
```

Verify the secret is set:

```bash
npx wrangler secret list --config ../wrangler.toml
# Should show GITHUB_WEBHOOK_SECRET in the list
```

### `routes` on staging accidentally binds prod domain

If a staging deploy claims your production domain, the `routes = []` line is missing from
`[env.staging]` in `wrangler.toml`. Add it and redeploy staging. See step 3.

### Dashboard shows "No organizations found" after login

The GitHub App is not installed on any org the authenticated user has access to. Go to
`https://github.com/apps/<YOUR_APP_SLUG>/installations/new` and install it.

### Session cookie not set (infinite redirect loop)

The `__Host-session` cookie requires `Secure` + `Path=/` + no `Domain` attribute. These
are set by the Worker automatically but only work over HTTPS. Ensure your custom domain
has TLS configured, or use the `*.workers.dev` URL (always HTTPS).

### Local dev

```bash
cd worker
npm ci

# Create worker/.dev.vars with your secrets (do not commit this file):
# GITHUB_WEBHOOK_SECRET=...
# GITHUB_APP_ID=...
# GITHUB_APP_CLIENT_ID=...
# GITHUB_APP_CLIENT_SECRET=...
# GITHUB_APP_PRIVATE_KEY=...
# GITHUB_APP_WEBHOOK_SECRET=...
# INSTALL_TOKEN_KEY=...
# GITHUB_ORG=...

npx wrangler dev   # uses --config ../wrangler.toml (set in package.json dev script)
# → http://localhost:8787
```

Wrangler dev automatically creates a local D1 preview database — no remote D1 is used.
