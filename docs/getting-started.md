# Getting Started — Local Development

This guide covers running **roxabi-live** locally as a Cloudflare Worker. For production and self-hosted deployment, see [docs/DEPLOY.md](DEPLOY.md).

## Prerequisites

- **Node.js 20** — verify with `node --version` (should print `v20.x`)
- **npm** — bundled with Node; no global wrangler install required

No Python, no `uv`, no system-level dependencies beyond Node 20.

## Clone and Install

```bash
git clone https://github.com/<YOUR_ORG>/<YOUR_FORK>.git
# <!-- TODO: replace with your fork URL -->
cd roxabi-live
cd worker && npm ci
```

## Local Secrets

Wrangler reads secrets from `worker/.dev.vars` automatically during `wrangler dev`. Create the file — it is gitignored and must never be committed:

```ini
# worker/.dev.vars
GITHUB_WEBHOOK_SECRET=<your-org-level-webhook-secret>
GITHUB_APP_ID=<your-app-numeric-id>
GITHUB_APP_CLIENT_ID=<your-app-oauth-client-id>
GITHUB_APP_CLIENT_SECRET=<your-app-oauth-client-secret>
GITHUB_APP_PRIVATE_KEY=<base64-encoded-pkcs8-der-rsa-private-key>
GITHUB_APP_WEBHOOK_SECRET=<your-app-level-webhook-secret>
INSTALL_TOKEN_KEY=<base64-encoded-32-byte-aes-gcm-key>
GITHUB_ORG=<your-github-org-slug>
ADMIN_TOKEN=<optional-bearer-token-for-admin-sync>
NOTIFY_URL=<optional-alert-webhook-url>
```

### Which secrets you actually need

| Goal | Required secrets |
|---|---|
| Browse `/health`, `/api/version`, static frontend — no auth | None — wrangler dev works with an empty `.dev.vars` |
| Exercise the OAuth login flow end-to-end | `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_ORG` |
| Receive and verify org webhooks locally | `GITHUB_WEBHOOK_SECRET` (plus a tunnel to expose `localhost:8787`) |
| Encrypt/decrypt install tokens | `INSTALL_TOKEN_KEY` |
| Trigger manual sync via `POST /admin/sync` | `ADMIN_TOKEN` (omitting it disables the Worker-level Bearer check; CF Access guards prod) |

> For most contributors, read-only local dev without any secrets is sufficient. The production deployment is the reference deployment for auth flows.

### Where to obtain each value

| Secret | How to obtain |
|---|---|
| `GITHUB_APP_ID` | GitHub App settings page → **App ID** (numeric) |
| `GITHUB_APP_CLIENT_ID` | GitHub App settings page → **Client ID** |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App settings page → **Generate a new client secret** |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App settings → **Generate a private key** → convert to PKCS#8 DER → `base64 -w0` |
| `GITHUB_APP_WEBHOOK_SECRET` | GitHub App settings → **Webhook secret** (App-level, distinct from org webhook) |
| `GITHUB_WEBHOOK_SECRET` | GitHub org → Settings → Webhooks → your webhook entry → **Secret** |
| `INSTALL_TOKEN_KEY` | Generate locally: `openssl rand -base64 32` |
| `GITHUB_ORG` | Your GitHub org slug (e.g. `acme`) |
| `ADMIN_TOKEN` | Any opaque string; generate with `openssl rand -hex 32` |
| `NOTIFY_URL` | Optional — any webhook URL for circuit-breaker alerts (e.g. Discord incoming webhook) |

## Run the Dev Server

```bash
cd worker && npx wrangler dev
```

The Worker starts at **http://localhost:8787**. Wrangler provisions a local D1 preview automatically — no external database setup is needed.

Verify the setup:

| Endpoint | Auth | What to expect |
|---|---|---|
| `GET /health` | public | `{"status":"ok","issues":<count>}` |
| `GET /api/version` | public | build/version JSON |
| `GET /login` | public | redirects to GitHub OAuth (requires App secrets) |

## Apply Migrations Locally

On first run the local D1 preview is empty. Apply all migrations once:

```bash
cd worker && npx wrangler d1 migrations apply DB --local --config ../wrangler.toml
```

Subsequent `wrangler dev` runs reuse the persisted local DB state.

## Production / Self-Hosting

See [docs/DEPLOY.md](DEPLOY.md) for:

- Cloudflare account and Worker setup
- D1 database and R2 bucket provisioning
- GitHub App creation, wrangler secret injection, and CI repo secrets
- `wrangler deploy` flows for staging and production
- Cloudflare Access configuration for `/admin/*`

## Legacy Note

The pre-2026-06 Python/FastAPI app is decommissioned and removed from the repo (2026-06-20). Runtime is Worker + `frontend/` only. `uv sync --group dev` installs license-check tooling, not an application server.
