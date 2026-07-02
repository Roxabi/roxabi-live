# Getting Started — Local Development

This guide covers running **roxabi-live** locally. For production and self-hosted deployment, see [docs/DEPLOY.md](DEPLOY.md).

## Prerequisites

- **Bun 1.3+** — `bun --version`
- **Node 22+** — required by the root `package.json` engines field

No Python runtime is needed for the app itself. `uv sync --group dev` installs license-check and pre-commit tooling only.

## Clone and Install

```bash
git clone https://github.com/Roxabi/roxabi-live.git
cd roxabi-live
bun install
```

## Local Secrets

Wrangler reads secrets from `apps/api/.dev.vars` during `wrangler dev`. Create the file — it is gitignored:

```ini
# apps/api/.dev.vars
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
| Browse `/health`, `/api/version` — no auth | None — wrangler dev works with an empty `.dev.vars` |
| Exercise OAuth end-to-end | `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_ORG` |
| Receive org webhooks locally | `GITHUB_WEBHOOK_SECRET` + tunnel to expose `localhost:8787` |
| Encrypt/decrypt install tokens | `INSTALL_TOKEN_KEY` |
| Trigger `POST /admin/sync` | `ADMIN_TOKEN` |

> For most contributors, read-only local dev without secrets is sufficient.

### Where to obtain each value

| Secret | How to obtain |
|---|---|
| `GITHUB_APP_ID` | GitHub App settings → **App ID** (numeric) |
| `GITHUB_APP_CLIENT_ID` | GitHub App settings → **Client ID** |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App settings → **Generate a new client secret** |
| `GITHUB_APP_PRIVATE_KEY` | Generate private key → PKCS#8 DER → `base64 -w0` |
| `GITHUB_APP_WEBHOOK_SECRET` | GitHub App settings → **Webhook secret** |
| `GITHUB_WEBHOOK_SECRET` | GitHub org webhook entry → **Secret** |
| `INSTALL_TOKEN_KEY` | `openssl rand -base64 32` |
| `GITHUB_ORG` | Your GitHub org slug |
| `ADMIN_TOKEN` | `openssl rand -hex 32` (optional) |

Full self-hosting steps: [docs/DEPLOY.md](DEPLOY.md).

## Run the Dev Servers

**API worker** (Hono, D1 preview, port 8787):

```bash
cd apps/api && bunx wrangler dev
```

**React SPA** (proxies API in dev):

```bash
cd apps/app && bun run dev
```

**Marketing** (optional):

```bash
bun run dev:marketing
```

Verify the API:

| Endpoint | Auth | What to expect |
|---|---|---|
| `GET /health` | public | `{"status":"ok","issues":<count>}` |
| `GET /api/version` | public | build/version JSON |
| `GET /login` | public | redirects to GitHub OAuth (requires App secrets) |

## Apply Migrations Locally

On first run the local D1 preview is empty:

```bash
cd apps/api && bunx wrangler d1 migrations apply DB --local
```

## Monorepo Layout

| Path | Role |
|------|------|
| `apps/api` | API worker — sync, webhooks, auth, D1 |
| `apps/app` | React SPA + edge proxy worker |
| `apps/marketing` | Astro landing site |
| `packages/shared` | Shared TypeScript types |
| `plugins/roxabi-issues` | `issue-triage` Claude Code skill |
| `frontend/` | Legacy vanilla shell (still ASSETS-bound on API worker) |

## Agent workflow

To use Roxabi Live with coding agents, see [docs/agent-workflow.md](agent-workflow.md) and install the `roxabi-issues` plugin.

## Production / Self-Hosting

See [docs/DEPLOY.md](DEPLOY.md) for Cloudflare setup, GitHub App configuration, and deploy automation.