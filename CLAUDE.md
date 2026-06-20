@.claude/stack.yml
@~/.claude/shared/global-patterns.md

# CLAUDE.md — Instructions for Claude Code

Let:
  P := CLAUDE.md path

## Project

**Roxabi Live** — operations cockpit (Cloudflare Worker + D1, TypeScript)
- Prod: Cloudflare Worker `roxabi-live` at **https://live.roxabi.dev**; **/admin/* behind Cloudflare Access (Email-OTP, mickael@bouly.io); public app gated by app-level sessions (#141, S7 #150) — cutover DONE (verified 2026-06-16): Access gates /admin (OTP) + /webhook (bypass) only, no catch-all; public app on Worker `requireSession`. See docs/s7-access-cutover.md**
- Data: D1 `roxabi-live-production` (replaces `~/.roxabi/corpus.db` / aiosqlite)
- Sync: GitHub GraphQL via `fetch()` in `worker/src/sync/`, driven by Cron Trigger `0 0 * * *` (daily full reconcile, #80) + real-time GitHub org webhook → `POST /webhook/github` (HMAC-gated; Access Bypass on `/webhook/*`)
- Frontend: static dep-graph assets served via Worker ASSETS binding (`frontend/`)
- `/admin/*` gated by `ADMIN_TOKEN` secret (defense-in-depth, #123) in addition to edge Access
- M₁ (roxabituwer) **decommissioned 2026-06-08**: `live.service` stopped+disabled, Tailscale Funnel retired, `~/.roxabi/corpus.db` archived

→ `docs/ARCHITECTURE.md`

## Plugins

`plugins/roxabi-issues/` — Claude Code plugin (own `.claude-plugin/marketplace.json`), relocated from dev-core 2026-06-09. Skill `issue-triage` (invoked `roxabi-issues:issue-triage`): set labels (size/priority/lane/type) + manage blocked-by deps + parent/child sub-issues on GitHub issues. **Labels + native relations only — no ProjectV2 board** (board read is the cockpit's job). Self-contained bun project (`bun run typecheck|test`). Registered in `roxabi-plugins/.claude-plugin/external-registry.json`.

## TL;DR

- Entry: `/dev #N` → tier (S/F-lite/F-full) → lifecycle
- Decisions → global-patterns.md
- ¬`--force` | ¬`--hard` | ¬`--amend`

## Key files

**Worker (prod — primary)**

| File | Role |
|---|---|
| `worker/src/index.ts` | Worker entry point (`fetch` + `scheduled` handlers) |
| `worker/src/router.ts` | Request routing |
| `worker/src/types.ts` | `Env` interface + shared types |
| `worker/src/api/issues.ts` | `GET /api/issues`, `GET /api/issues/:key` |
| `worker/src/api/graph.ts` | `GET /api/graph` (optional `?status=ready,blocked`, `?closed_under_open_epic=1`) |
| `worker/src/graph/status.ts` | Graph status compute + server-side filter |
| `worker/src/api/admin.ts` | `POST /admin/sync` (ADMIN_TOKEN-gated) |
| `worker/src/api/version.ts` | `GET /api/version` |
| `worker/src/sync/sync.ts` | Daily reconcile orchestrator (`runSync`) + public facade re-exports |
| `worker/src/sync/constants.ts` | Pagination/windowing constants (MAX_PAGES/WINDOW/NUM_SLOTS) |
| `worker/src/sync/label-vocab.ts` | Label vocab + key helpers (extractFromLabels/canonicalKey/collectEdges) |
| `worker/src/sync/upsert.ts` | Issue upsert SQL + prepareIssueUpsert (zk title redaction) |
| `worker/src/sync/control.ts` | batchChunked + sync_control helpers (lock/halt/auth-failures) |
| `worker/src/sync/repo-issues.ts` | Per-repo issue sync (standalone ISSUES_QUERY) |
| `worker/src/sync/repo-branches.ts` | Branch sync (has_active_branch) |
| `worker/src/sync/repo-prs.ts` | PR-state sync (applyPrState/UPSERT_PR_STATE_SQL) |
| `worker/src/sync/bundle.ts` | Bundled per-repo fetch (issues+refs+PRs) — primary path |
| `worker/src/sync/edges.ts` | Edge flush (pass 2) + closed-hop stub backfill |
| `worker/src/sync/audit.ts` | Per-run audit summary (R2 + Workers Logs) |
| `worker/src/sync/tenants.ts` | Phase-1 per-tenant repo discovery |
| `worker/src/sync/graphql.ts` | GitHub GraphQL client (`fetch()`) |
| `worker/src/sync/queries.ts` | GraphQL query strings |
| `worker/src/sync/parse.ts` | Issue/edge parsing |
| `worker/src/webhook/handlers.ts` | Webhook dispatch entry (`webhookRoute`) + tenant routing gate |
| `worker/src/webhook/handlers-issues.ts` | Data handlers (issues/issue_dependencies/sub_issues) |
| `worker/src/webhook/handlers-ref.ts` | Ref/PR/milestone handlers (create/delete/pull_request/milestone) |
| `worker/src/webhook/handlers-app.ts` | App install-lifecycle handlers (installation/installation_repositories) |
| `worker/src/webhook/handlers-access.ts` | Resource/access handlers (repository/member/membership) |
| `worker/src/webhook/handlers-app-helpers.ts` | Shared payload-shape helpers for handlers-app/handlers-access |
| `worker/src/webhook/tenant.ts` | Tenant lookup (`installation_id`/`account_login` → `tenants`) |
| `worker/src/webhook/hmac.ts` | HMAC verification |
| `worker/src/webhook/mutations.ts` | D1 write helpers (issue/edge/PR/milestone corpus) |
| `worker/src/webhook/mutations-app.ts` | D1 write helpers (App install-lifecycle: tenant/repo/cache/session) |
| `worker/migrations/` | D1 schema migrations |
| `wrangler.toml` | Worker config (bindings, Cron, routes, environments) |
| `frontend/` | Static HTML/JS/CSS served via ASSETS binding |
| `biome.json` | Biome lint + format config (repo root; scopes `worker/src` + `frontend`) |
| `artifacts/` | Frames, specs, plans (dev-core) |

## Package layout

**Worker (active)**

```
worker/
  src/
    index.ts        # fetch + scheduled entry
    router.ts
    types.ts
    api/            # issues, graph, admin, version
    sync/           # sync, graphql, queries, parse
    webhook/        # handlers, hmac, mutations
  migrations/
wrangler.toml       # repo root — binds both envs
frontend/           # served via ASSETS binding
```

**Plugin (issue mgmt — relocated from dev-core)**

```
.claude-plugin/marketplace.json   # single-plugin marketplace
plugins/roxabi-issues/            # roxabi-issues:issue-triage (bun; labels + native relations)
```

## Corpus sync — edge algorithm

GitHub issue relationships map to D1 `edges` table with specific `kind` values (algorithm identical to pre-CF; implementation moved to `worker/src/sync/sync.ts` + `worker/src/sync/parse.ts`):

| Relationship | GraphQL field | Edge direction | `kind` |
|--------------|---------------|----------------|--------|
| Parent → child | `subIssues` | `src=parent, dst=child` | `parent` |
| Child → parent | `parent` | `src=parent, dst=child` | `parent` |
| Blocks | `blockedBy`/`blocking` | `src=blocker, dst=blocked` | `blocks` |

**Edge semantics:**
- `parent`: `src` is the parent issue, `dst` is a sub-issue. Parent must complete before children can proceed.
- `blocks`: `src` blocks `dst`. If `src` is open, `dst` is "blocked"; if `src` is closed, `dst` is "ready".

**Sync flow** (`worker/src/sync/sync.ts`):
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
- Lint/format: **Biome** — `cd worker && npm run lint` (check) / `npm run format` (write); enforced in CI (`worker` job) + pre-commit
- Commits: Conventional (`feat:`, `fix:`, `chore:`)
- Issues: `/dev #N`

## CLAUDE.md hygiene

File/rename → update P immediately

| P | Scope |
|---|---|
| `CLAUDE.md` | project root |

Rules: add/delete/move → update P | new `worker/src/` subdir → update Key files table

## Deploy pattern

**Prod (Cloudflare — CI-driven)**

Push to `main` → CI `deploy` job → `wrangler deploy` (binds `live.roxabi.dev` via top-level `routes` in `wrangler.toml`).
Push to `staging` → `wrangler deploy --env staging`.

Secrets (set once; `CLOUDFLARE_ACCOUNT_ID` required — token sees 2 accounts):
```bash
# prod
printf %s '<value>' | wrangler secret put SECRET_NAME
# staging
printf %s '<value>' | wrangler secret put SECRET_NAME --env staging
```

Local worker dev:
```bash
cd worker && npm ci && npx wrangler dev
```

**M₁ / systemd — decommissioned 2026-06-08**

`live.service` stopped+disabled. Legacy Python app removed from repo (2026-06-20); Worker + `frontend/` are the only runtime.
