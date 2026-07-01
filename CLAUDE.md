@.claude/stack.yml

# CLAUDE.md — Instructions for Claude Code

Let:
  P := CLAUDE.md path

## Project

**Roxabi Live** — operations cockpit (Cloudflare Worker + D1, TypeScript)
- Prod: Cloudflare Worker `roxabi-live` at **https://live.roxabi.dev**; **/admin/* behind Cloudflare Access (Email-OTP, mickael@bouly.io); public app gated by app-level sessions (#141, S7 #150) — cutover DONE (verified 2026-06-16): Access gates /admin (OTP) + /webhook (bypass) only, no catch-all; public app on Worker `requireSession`. See docs/s7-access-cutover.md**
- Data: D1 `roxabi-live-production` (replaces `~/.roxabi/corpus.db` / aiosqlite)
- Sync: GitHub GraphQL via `fetch()` in `apps/api/src/sync/`, driven by Cron Trigger `0 0 * * *` (daily full reconcile, #80) + real-time GitHub org webhook → `POST /webhook/github` (HMAC-gated; Access Bypass on `/webhook/*`)
- Frontend: React SPA at `apps/app` (`app.live.roxabi.dev`); the app worker proxies API/auth to the api worker via a service binding (same-origin). Marketing = `apps/marketing` (Astro) at the apex `live.roxabi.dev`
- `/admin/*` gated by `ADMIN_TOKEN` secret (defense-in-depth, #123) in addition to edge Access
- M₁ (roxabituwer) **decommissioned 2026-06-08**: `live.service` stopped+disabled, Tailscale Funnel retired, `~/.roxabi/corpus.db` archived

→ `docs/ARCHITECTURE.md`

## Plugins

`plugins/roxabi-issues/` — Claude Code plugin (own `.claude-plugin/marketplace.json`), relocated from dev-core 2026-06-09. Skill `issue-triage` (invoked `roxabi-issues:issue-triage`): set labels (size/priority/lane/type) + manage blocked-by deps + parent/child sub-issues on GitHub issues. **Labels + native relations only — no ProjectV2 board** (board read is the cockpit's job). Self-contained bun project (`bun run typecheck|test`). Registered in `roxabi-plugins/.claude-plugin/external-registry.json`.

## TL;DR

- Entry: `/dev #N` → tier (S/F-lite/F-full) → lifecycle
- ¬`--force` | ¬`--hard` | ¬`--amend`

## Key files

**Worker (prod — primary)**

| File | Role |
|---|---|
| `apps/api/src/index.ts` | Worker entry point (`fetch` + `scheduled` handlers) |
| `apps/api/src/router.ts` | Request routing |
| `apps/api/src/types.ts` | `Env` interface + shared types |
| `apps/api/src/api/issues.ts` | `GET /api/issues`, `GET /api/issues/:key` |
| `apps/api/src/api/graph.ts` | `GET /api/graph` (optional `?status=ready,blocked`, `?closed_under_open_epic=1`) |
| `apps/api/src/graph/status.ts` | Graph status compute + server-side filter |
| `apps/api/src/api/admin.ts` | `POST /admin/sync` (ADMIN_TOKEN-gated) |
| `apps/api/src/api/version.ts` | `GET /api/version` |
| `apps/api/src/sync/sync.ts` | Daily reconcile orchestrator (`runSync`) + public facade re-exports |
| `apps/api/src/sync/constants.ts` | Pagination/windowing constants (MAX_PAGES/WINDOW/NUM_SLOTS) |
| `apps/api/src/sync/label-vocab.ts` | Label vocab + key helpers (extractFromLabels/canonicalKey/collectEdges) |
| `apps/api/src/sync/upsert.ts` | Issue upsert SQL + prepareIssueUpsert (zk title redaction) |
| `apps/api/src/sync/control.ts` | batchChunked + sync_control helpers (lock/halt/auth-failures) |
| `apps/api/src/sync/repo-issues.ts` | Per-repo issue sync (standalone ISSUES_QUERY) |
| `apps/api/src/sync/repo-branches.ts` | Branch sync (has_active_branch) |
| `apps/api/src/sync/repo-prs.ts` | PR-state sync (applyPrState/UPSERT_PR_STATE_SQL) |
| `apps/api/src/sync/bundle.ts` | Bundled per-repo fetch (issues+refs+PRs) — primary path |
| `apps/api/src/sync/edges.ts` | Edge flush (pass 2) + closed-hop stub backfill |
| `apps/api/src/sync/audit.ts` | Per-run audit summary (R2 + Workers Logs) |
| `apps/api/src/sync/tenants.ts` | Phase-1 per-tenant repo discovery |
| `apps/api/src/sync/graphql.ts` | GitHub GraphQL client (`fetch()`) |
| `apps/api/src/sync/queries.ts` | GraphQL query strings |
| `apps/api/src/sync/parse.ts` | Issue/edge parsing |
| `apps/api/src/webhook/handlers.ts` | Webhook dispatch entry (`webhookRoute`) + tenant routing gate |
| `apps/api/src/webhook/handlers-issues.ts` | Data handlers (issues/issue_dependencies/sub_issues) |
| `apps/api/src/webhook/handlers-ref.ts` | Ref/PR/milestone handlers (create/delete/pull_request/milestone) |
| `apps/api/src/webhook/handlers-app.ts` | App install-lifecycle handlers (installation/installation_repositories) |
| `apps/api/src/webhook/handlers-access.ts` | Resource/access handlers (repository/member/membership) |
| `apps/api/src/webhook/handlers-app-helpers.ts` | Shared payload-shape helpers for handlers-app/handlers-access |
| `apps/api/src/webhook/tenant.ts` | Tenant lookup (`installation_id`/`account_login` → `tenants`) |
| `apps/api/src/webhook/hmac.ts` | HMAC verification |
| `apps/api/src/webhook/mutations.ts` | D1 write helpers (issue/edge/PR/milestone corpus) |
| `apps/api/src/webhook/mutations-app.ts` | D1 write helpers (App install-lifecycle: tenant/repo/cache/session) |
| `apps/api/migrations/` | D1 schema migrations |
| `apps/api/wrangler.toml` | API worker config (bindings, Cron, route `api.live.roxabi.dev`, envs) |
| `apps/app/` | React SPA (Vite) — served at `app.live.roxabi.dev`; `worker.ts` proxies API/auth to apps/api |
| `biome.json` | Biome lint + format config (repo root; scopes `apps/api/src` + `apps/app/src`) |
| `artifacts/` | Frames, specs, plans (dev-core) |

## Package layout

**Monorepo (bun workspaces — `apps/*`, `packages/*`)**

```
apps/
  api/                # Hono API worker (moved from worker/) — api.live.roxabi.dev
    src/              # index.ts (fetch+scheduled), router, api/, sync/, webhook/
    migrations/       # D1 schema
    wrangler.toml     # api worker config (route api.live.roxabi.dev)
  app/                # React SPA — app.live.roxabi.dev
    worker.ts         # edge worker: SPA ASSETS + proxy /api,/login,/oauth,… → api (service binding)
    wrangler.deploy.jsonc
  marketing/          # Astro SSG — apex live.roxabi.dev (CF Pages)
packages/
  shared/             # @roxabi-live/shared — API types + graph/dims/layout helpers
frontend/             # LEGACY vanilla shell (sign-in/dashboard HTML) — LIVE, git-tracked; wired as the ASSETS binding of the apps/api worker (apps/api/wrangler.toml [assets] directory=../../frontend). Permanent until an explicit cleanup PR drops [assets] + the /dashboard,/sign-in routes — do not delete on the strength of this comment alone
```

**Plugin (issue mgmt — relocated from dev-core)**

```
.claude-plugin/marketplace.json   # single-plugin marketplace
plugins/roxabi-issues/            # roxabi-issues:issue-triage (bun; labels + native relations)
```

## Corpus sync — edge algorithm

GitHub issue relationships map to D1 `edges` table with specific `kind` values (algorithm identical to pre-CF; implementation moved to `apps/api/src/sync/sync.ts` + `apps/api/src/sync/parse.ts`):

| Relationship | GraphQL field | Edge direction | `kind` |
|--------------|---------------|----------------|--------|
| Parent → child | `subIssues` | `src=parent, dst=child` | `parent` |
| Child → parent | `parent` | `src=parent, dst=child` | `parent` |
| Blocks | `blockedBy`/`blocking` | `src=blocker, dst=blocked` | `blocks` |

**Edge semantics:**
- `parent`: `src` is the parent issue, `dst` is a sub-issue. Parent must complete before children can proceed.
- `blocks`: `src` blocks `dst`. If `src` is open, `dst` is "blocked"; if `src` is closed, `dst` is "ready".

**Sync flow** (`apps/api/src/sync/sync.ts`):
1. Fetch issues via GraphQL with `subIssues`, `parent`, `blockedBy`, `blocking` fields
2. For each issue: upsert parent edges + blocks edges (deletes only edges of same `kind`)
3. Write per-run audit to R2 bucket `roxabi-live-logs`

**Frontend status computation** (`frontend/` → `state.js`, served via ASSETS binding):
```js
// Any edge where this node is dst → src blocks it
if (node.state === 'closed') return 'done';
const openBlocker = blockers.some(e => nodesByKey.get(e.src)?.state === 'open');
return openBlocker ? 'blocked' : 'ready';
```

## Conventions

- EN for docs/code/commits
- Lint/format: **Biome** — `bunx biome check apps/api/src apps/app/src` (check) / `--write` (fix); enforced in CI (`api` job) + pre-commit
- Commits: Conventional (`feat:`, `fix:`, `chore:`)
- Issues: `/dev #N`

## CLAUDE.md hygiene

File/rename → update P immediately

| P | Scope |
|---|---|
| `CLAUDE.md` | project root |

Rules: add/delete/move → update P | new `apps/api/src/` or `apps/app/src/` subdir → update Key files table

## Deploy pattern

**Cloudflare git-connected deploy (enishu model — CF pulls GitHub, GHA = CI only)**

| Target | Mechanism | SSOT |
|---|---|---|
| API (`api*.live.roxabi.dev`) | Workers Builds | `infra/workers-builds.json` |
| App (`app*.live.roxabi.dev`) | Pages + thin proxy Worker | `infra/pages-app*.json`, `apps/app/wrangler.deploy.jsonc` |
| Marketing (`live.roxabi.dev`, `marketing-staging…`) | Pages | `infra/pages-marketing*.json` |

Setup once:

```bash
source scripts/bw-cloudflare-live-build-env.sh
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_BUILDS_ADMIN_TOKEN"
bun run setup:cloudflare-deploy   # API Workers Builds + Pages build settings
bun run migrate:pages-model       # one-time cutover if fronts still on Workers Builds
bun run verify:cloudflare
```

| Branch | Deploy | URL |
|---|---|---|
| `staging` | Workers Builds | `api-staging.live.roxabi.dev` |
| `staging` | Pages | `app-staging.live.roxabi.dev`, `marketing-staging.live.roxabi.dev` |
| `main` | Workers Builds | `api.live.roxabi.dev` |
| `main` | Pages | `app.live.roxabi.dev`, `live.roxabi.dev` |

After `worker.ts` changes: `bun --filter @roxabi-live/app deploy:worker` (prod) / `deploy:worker:staging`.

Workers Builds deploy token: `roxabi-live-build` (user API token `roxabi-live-workers-build`). Register: `bash scripts/run-live-build-token-setup.sh`.

Break-glass API: `source scripts/bw-cloudflare-live-build-env.sh` → `bash scripts/deploy-{staging,production}.sh`

Secrets (set once on the api worker; `CLOUDFLARE_ACCOUNT_ID` required — token sees 2 accounts):
```bash
cd apps/api
printf %s '<value>' | bunx wrangler secret put SECRET_NAME              # prod
printf %s '<value>' | bunx wrangler secret put SECRET_NAME --env staging
```

Local worker dev:
```bash
bun install && cd apps/api && bunx wrangler dev   # api worker
# SPA: cd apps/app && bun run dev
```

**M₁ / systemd — decommissioned 2026-06-08**

`live.service` stopped+disabled. Legacy Python app removed from repo (2026-06-20); Worker + `frontend/` are the only runtime.
