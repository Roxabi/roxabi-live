@.claude/stack.yml
@~/.claude/shared/global-patterns.md

# CLAUDE.md — Instructions for Claude Code

Let:
  P := CLAUDE.md path

## Project

**Roxabi Live** — operations cockpit (Cloudflare Worker + D1, TypeScript)
- Prod: Cloudflare Worker `roxabi-live` at **https://live.roxabi.dev** behind Cloudflare Access (Email-OTP, mickael@bouly.io)
- Data: D1 `roxabi-live-production` (replaces `~/.roxabi/corpus.db` / aiosqlite)
- Sync: GitHub GraphQL via `fetch()` in `worker/src/sync/`, driven by Cron Trigger `0 * * * *` + real-time GitHub org webhook → `POST /webhook/github` (HMAC-gated; Access Bypass on `/webhook/*`)
- Frontend: static dep-graph assets served via Worker ASSETS binding (`frontend/`)
- `/admin/*` gated by `ADMIN_TOKEN` secret (defense-in-depth, #123) in addition to edge Access
- M₁ (roxabituwer) **decommissioned 2026-06-08**: `live.service` stopped+disabled, Tailscale Funnel retired, `~/.roxabi/corpus.db` archived

→ `docs/ARCHITECTURE.md` (to be created)

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
| `worker/src/api/graph.ts` | `GET /api/graph` |
| `worker/src/api/admin.ts` | `POST /admin/sync` (ADMIN_TOKEN-gated) |
| `worker/src/api/version.ts` | `GET /api/version` |
| `worker/src/sync/sync.ts` | Hourly sync orchestrator + R2 audit write |
| `worker/src/sync/graphql.ts` | GitHub GraphQL client (`fetch()`) |
| `worker/src/sync/queries.ts` | GraphQL query strings |
| `worker/src/sync/parse.ts` | Issue/edge parsing |
| `worker/src/webhook/handlers.ts` | Webhook dispatch (issues/deps/sub_issues) |
| `worker/src/webhook/hmac.ts` | HMAC verification |
| `worker/src/webhook/mutations.ts` | D1 write helpers |
| `worker/migrations/` | D1 schema migrations |
| `wrangler.toml` | Worker config (bindings, Cron, routes, environments) |
| `frontend/` | Static HTML/JS/CSS served via ASSETS binding |
| `artifacts/` | Frames, specs, plans (dev-core) |

**Legacy Python app (pre-CF, M₁-era — decommissioned 2026-06-08, code kept for reference)**

| File | Role |
|---|---|
| `src/roxabi_live/app.py` | ~~FastAPI application factory~~ |
| `src/roxabi_live/__main__.py` | ~~uvicorn entry point~~ |
| `src/roxabi_live/corpus/` | ~~Issue sync GraphQL → `~/.roxabi/corpus.db`~~ |
| `src/roxabi_live/dep_graph/v1/` | ~~Legacy CLI renderer (frozen)~~ |
| `src/roxabi_live/dep_graph/v5/` | ~~Matrix + graph HTML renderer (frozen)~~ |
| `src/roxabi_live/dep_graph/v6/` | ~~API-first renderer~~ |
| `src/roxabi_live/reconciler.py` | ~~Hourly corpus sync heal loop~~ |
| `src/roxabi_live/api/issues.py` | ~~`GET /api/issues`~~ |
| `src/roxabi_live/webhook/` | ~~GitHub webhook handlers~~ |
| `deploy/systemd/live.service` | ~~systemd user unit (M₁ boot)~~ |
| `.env.example` | Env var reference (legacy Python env; CF secrets via `wrangler secret put`) |

## Dep-graph versions

| Version | Status | Entry |
|---|---|---|
| v1 | frozen (legacy CLI — decommissioned) | `dep-graph` script |
| v5 | frozen (static HTML build — decommissioned) | `dep-graph-v5` script |
| v6 | **primary** — served by CF Worker ASSETS | `GET /api/graph` · Worker ASSETS binding |

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

**Legacy Python app (decommissioned 2026-06-08)**

```
src/roxabi_live/
  __init__.py
  __main__.py     # uvicorn entry
  app.py          # FastAPI() + /health
tests/
  test_health.py
```

Module name: `roxabi_live` (underscore). CLI: `roxabi-live` (hyphen). ¬running in prod.

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

`live.service` stopped+disabled. `uv run roxabi-live` (M₂ dev server) no longer reflects prod.
Legacy log dir: `~/.local/state/roxabi-live/logs/` (archived on M₁).
