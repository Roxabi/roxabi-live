# Roxabi Live — Monorepo

Status: **cutover complete** (v0.22.0+, PR #271 merged). Production runs the three-host topology modeled on [roxabi-links / enishu](https://github.com/Roxabi/roxabi-links).

## Production topology

| Host | Target | Deploy |
|------|--------|--------|
| `live.roxabi.dev` (apex) | Marketing (Astro) | CF Pages → `apps/marketing` |
| `app.live.roxabi.dev` | React SPA + API proxy | Worker `roxabi-live-app` → `apps/app` |
| `api.live.roxabi.dev` | Hono API + webhook + cron | Worker `roxabi-live` → `apps/api` |

The browser only talks to `app.live.roxabi.dev`. The app worker proxies `/api`, `/login`, `/oauth`, `/auth`, `/logout`, `/install`, `/admin`, `/health` to the API worker via a **service binding** (same-origin, no CORS).

Runbook for the human cutover steps: [docs/cutover-monorepo.md](docs/cutover-monorepo.md).

## Repo layout

```
package.json            bun workspaces ["apps/*","packages/*"]
apps/
  api/                  @roxabi-live/api — Hono Worker, D1, sync, webhooks
  app/                  @roxabi-live/app — React 19 SPA + edge proxy (worker.ts)
  marketing/            @roxabi-live/marketing — Astro SSG, FR/EN landing
packages/
  shared/               @roxabi-live/shared — API types, graph helpers, brand tokens
brand/                  Shared CSS design system (consumed by marketing + app)
frontend/               Legacy vanilla shell — still ASSETS-bound on API worker (cleanup pending)
plugins/
  roxabi-issues/        issue-triage skill (bun, self-contained tests)
```

## Deploy model (Enishu)

Cloudflare git-connected deploy; GitHub Actions = **CI only** (no CD).

| Target | Mechanism | SSOT |
|--------|-----------|------|
| API | Workers Builds | `infra/workers-builds.json` |
| App | Pages + thin proxy Worker | `infra/pages-app*.json`, `apps/app/wrangler.deploy.jsonc` |
| Marketing | Pages | `infra/pages-marketing*.json` |

```bash
bun run setup:cloudflare-deploy
bun run verify:cloudflare
```

See [CLAUDE.md](CLAUDE.md) for branch → URL mapping and break-glass deploy scripts.

## CI

`.github/workflows/ci.yml` — jobs: `ci` (tools/license), `api` (Biome + vitest), `app` (typecheck + vitest + marketing Astro build), `plugin` (issue-triage tests).

## Brand sharing

- **CSS layer** → `brand/` at repo root. Marketing and app `@import brand/styles.css`.
- **TS layer** → `packages/shared/src/brand.ts` mirrors hex values for code paths that cannot read CSS vars.

## Legacy note

The pre-2026-06 Python/FastAPI app and `worker/` directory are removed. `frontend/` remains temporarily as ASSETS on the API worker until an explicit cleanup PR drops it.