@.claude/stack.yml
@~/.claude/shared/global-patterns.md

# CLAUDE.md — Instructions for Claude Code

Let:
  P := CLAUDE.md path

## Project

**Roxabi Live** — operations cockpit (FastAPI + aiosqlite + Tailscale Funnel)
- Exposes `~/.roxabi/corpus.db` via live HTTP API (`GET /api/*`)
- Receives GitHub org webhooks at `POST /webhook/github` (HMAC-gated)
- Frontend: static HTML/JS (dep-graph tab first, see spec #866)
- Public via Tailscale Funnel on M₁ at `https://roxabituwer.goose-logarithm.ts.net/` (cloudflared setup deferred pending `roxabi.dev` zone migration from OVH)

→ `docs/ARCHITECTURE.md` (to be created)

## TL;DR

- Entry: `/dev #N` → tier (S/F-lite/F-full) → lifecycle
- Decisions → global-patterns.md
- ¬`--force` | ¬`--hard` | ¬`--amend`

## Key files

| File | Role |
|---|---|
| `src/roxabi_live/app.py` | FastAPI application factory |
| `src/roxabi_live/__main__.py` | uvicorn entry point |
| `src/roxabi_live/corpus/` | Issue sync GraphQL → `~/.roxabi/corpus.db` (migrated from lyra) |
| `src/roxabi_live/dep_graph/v1/` | Legacy CLI renderer (frozen) |
| `src/roxabi_live/dep_graph/v5/` | Matrix + graph HTML renderer (frozen) |
| `src/roxabi_live/dep_graph/v6/` | API-first renderer → `GET /api/graph` |
| `src/roxabi_live/reconciler.py` | Hourly corpus sync heal loop + startup one-shot |
| `src/roxabi_live/api/issues.py` | `GET /api/issues`, `GET /api/issues/:key` |
| `src/roxabi_live/webhook/` | GitHub webhook handlers (HMAC verify + issues/deps/sub_issues dispatch) |
| `deploy/supervisor/supervisord.conf` | supervisord config |
| `deploy/supervisor/conf.d/` | per-program supervisor units |
| `frontend/` | Static HTML/JS/CSS (dep-graph tab + future tabs) |
| `artifacts/` | Frames, specs, plans (dev-core) |
| `.env.example` | Env var reference (CORPUS_DB_PATH, GITHUB_WEBHOOK_SECRET, …) |

## Dep-graph versions

| Version | Status | Entry |
|---|---|---|
| v1 | frozen (legacy CLI) | `dep-graph` script |
| v5 | frozen (static HTML build) | `dep-graph-v5` script · `GET /dep-graph/` (auto-rebuild when corpus.db newer) |
| v6 | **primary** — API-first | `GET /api/graph` · `dep-graph-v6` CLI (debug) |

## Package layout

```
src/roxabi_live/
  __init__.py
  __main__.py     # uvicorn entry
  app.py          # FastAPI() + /health
tests/
  test_health.py
```

Module name: `roxabi_live` (underscore). CLI: `roxabi-live` (hyphen).

## Corpus sync — edge algorithm

GitHub issue relationships map to `corpus.db` edges table with specific `kind` values:

| Relationship | GraphQL field | Edge direction | `kind` |
|--------------|---------------|----------------|--------|
| Parent → child | `subIssues` | `src=parent, dst=child` | `parent` |
| Child → parent | `parent` | `src=parent, dst=child` | `parent` |
| Blocks | `blockedBy`/`blocking` | `src=blocker, dst=blocked` | `blocks` |

**Edge semantics:**
- `parent`: `src` is the parent issue, `dst` is a sub-issue. Parent must complete before children can proceed.
- `blocks`: `src` blocks `dst`. If `src` is open, `dst` is "blocked"; if `src` is closed, `dst` is "ready".

**Sync flow** (`src/roxabi_live/corpus/sync.py`):
1. Fetch issues via GraphQL with `subIssues`, `parent`, `blockedBy`, `blocking` fields
2. For each issue:
   - `upsert_edges(conn, key, parents, children, kind="parent")` — parents point to this issue, this issue points to children
   - `upsert_edges(conn, key, blocked_by, blocking, kind="blocks")` — blockers point to this issue, this issue points to blockees
3. `upsert_edges` deletes only edges of the same `kind` for the issue, allowing multiple edge types per issue

**Frontend status computation** (`src/roxabi_live/dep_graph/v6/frontend/state.js`):
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

Rules: add/delete/move → update P | new `src/roxabi_live/` subdir → nearest P (¬nested)

## Supervisor pattern

`deploy/supervisor/conf.d/` — one `.conf` file per program.
`autostart=false` on M₂ (dev); `autorestart=true` on M₁ (prod).
Log dir: `~/.local/state/roxabi-live/logs/`

Programs added per spec slice:
- Slice 3: `live.conf` (FastAPI + uvicorn) — installed on M₁ as `~/projects/conf.d/live.conf`, program name `live`
- Slice 2: `cloudflared.conf` (tunnel daemon) — not deployed; Tailscale Funnel used instead on M₁
