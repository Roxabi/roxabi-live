# Monorepo cutover — go-live runbook (human steps)

The code side of the cutover is on PR #271 (`feat/phase1-monorepo`). Architecture =
**Option Y (same-origin via service binding)**: the browser only ever talks to
`app.live.roxabi.dev`; the app worker proxies API/auth traffic to the api worker
internally. No CORS, no cross-origin cookie, no client base-URL config.

Topology after cutover:

| Host | Target | Source |
|---|---|---|
| `live.roxabi.dev` (apex) | Marketing (Astro) | CF **Pages**, git-connected → `apps/marketing` |
| `app.live.roxabi.dev` | React SPA + proxy | Worker `roxabi-live-app` → `apps/app` (`worker.ts`) |
| `api.live.roxabi.dev` | Hono API + webhook + cron | Worker `roxabi-live` → `apps/api` |

## What the code already does

- `git mv worker/ → apps/api/` (bun member `@roxabi-live/api`), self-contained
  `apps/api/wrangler.toml` (route `api.live.roxabi.dev`, D1 `DB`, R2 `LOGS`).
- `apps/app/worker.ts` proxies `/api,/login,/oauth,/auth,/logout,/install,/admin,/health`
  to the api worker via the `API` service binding; everything else → SPA ASSETS.
- Post-OAuth/auth landings retargeted `/dashboard` → `/` (the React index is the cockpit).
- CI, `scripts/deploy-*.sh`, `infra/workers-builds.json`, `tools/qg.conf`, `.claude/stack.yml`,
  `.pre-commit-config.yaml`, `CLAUDE.md` repointed `worker/` → `apps/api`.

## Human steps (cannot be automated) — do in order

1. **Merge PR #271** to `staging`, validate, then `/promote` to `main`.

2. **CF Pages — marketing @ apex.** Dashboard → Pages → Create project → connect
   `Roxabi/roxabi-live`, branch `main`, build `bun --filter @roxabi-live/marketing build`,
   output `apps/marketing/dist`, root `/`. Add custom domain `live.roxabi.dev`.

3. **Reconfigure Workers Builds triggers** (or run `bun run setup:workers-builds`):
   - `roxabi-live` + `roxabi-live-staging`: build `bun install --frozen-lockfile`,
     deploy `bash scripts/deploy-{production,staging}.sh` (now `apps/api`).
   - **Create** `roxabi-live-app`: build `bun install --frozen-lockfile && bun --filter @roxabi-live/app build`,
     deploy `cd apps/app && bunx wrangler deploy --config wrangler.deploy.jsonc`.
   - Deploy order: **api first** (so the `API` service binding resolves), then app.

4. **DNS / custom domains.** Add custom domains `app.live.roxabi.dev` (→ `roxabi-live-app`)
   and `api.live.roxabi.dev` (→ `roxabi-live`). The apex moves to the Pages project (step 2).

5. **CF Access (#150).** Add Access apps for the new hosts:
   - `app.live.roxabi.dev/admin/*` → Email OTP (mirrors current `/admin`).
   - `api.live.roxabi.dev/*` → protect, **Bypass on `/webhook/*`** (GitHub posts server→server).
   - The public SPA is gated by app-level `requireSession`, not edge Access.

6. **GitHub App settings** (the App that drives auth + webhooks):
   - OAuth **Callback URL** → `https://app.live.roxabi.dev/oauth/callback`
   - **Setup URL** → `https://app.live.roxabi.dev/install/complete`
   - **Webhook URL** → `https://api.live.roxabi.dev/webhook/github`

7. **Secrets** on the api worker (already set on `roxabi-live`; re-verify after the move):
   `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `INSTALL_TOKEN_KEY`, … via
   `cd apps/api && bunx wrangler secret put NAME [--env staging]`.

8. **ZK re-login.** The wrapping key is account-bound (Argon2id over the passphrase),
   NOT origin-bound → users do a one-time re-login + re-unlock. **No data loss.**

## Pre-go-live integration test (recommended)

Local unit coverage is green (api 797 + app 46 vitest, both `wrangler --dry-run` valid).
Before flipping DNS, run the live 2-worker path on a CF **preview**: deploy `roxabi-live`
(api) + `roxabi-live-app` (app) to preview URLs, then exercise sign-in → OAuth bounce →
`/api/me` → ZK enroll/unlock → decrypt against the real service-binding proxy.

## Tracked follow-ups (not blockers)

- Drop the dead `apps/api` legacy-shell routes (`/dashboard`, `/sign-in`, `/sign-up`,
  `dashboard-route.ts`, `auth-page-route.ts`) + the `[assets]` binding once the SPA is
  confirmed live; then delete `frontend/`.
- `apps/marketing` `astro check` i18n literal-type debt (pre-existing; gated via `build`).
- `roxabi-live-app` **staging** trigger + its `API` binding → `roxabi-live-staging`.
