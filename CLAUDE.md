@.claude/stack.yml
@~/.claude/shared/global-patterns.md

# CLAUDE.md — Instructions for Claude Code

Let:
  P := CLAUDE.md path

## Project

**Roxabi Dashboard** — operations cockpit (FastAPI + aiosqlite + cloudflared)
- Exposes `~/.roxabi/corpus.db` via live HTTP API (`GET /api/*`)
- Receives GitHub org webhooks for near-real-time updates
- Frontend: static HTML/JS (dep-graph tab first, see spec #866)
- Public via cloudflared tunnel at `dashboard.roxabi.dev`

→ `docs/ARCHITECTURE.md` (to be created)

## TL;DR

- Entry: `/dev #N` → tier (S/F-lite/F-full) → lifecycle
- Decisions → global-patterns.md
- ¬`--force` | ¬`--hard` | ¬`--amend`

## Key files

| File | Role |
|---|---|
| `src/roxabi_dashboard/app.py` | FastAPI application factory |
| `src/roxabi_dashboard/__main__.py` | uvicorn entry point |
| `deploy/supervisor/supervisord.conf` | supervisord config |
| `deploy/supervisor/conf.d/` | per-program supervisor units |
| `frontend/` | Static HTML/JS/CSS (dep-graph tab + future tabs) |
| `artifacts/` | Frames, specs, plans (dev-core) |
| `.env.example` | Env var reference (CORPUS_DB_PATH, GITHUB_WEBHOOK_SECRET, …) |

## Package layout

```
src/roxabi_dashboard/
  __init__.py
  __main__.py     # uvicorn entry
  app.py          # FastAPI() + /health
tests/
  test_health.py
```

Module name: `roxabi_dashboard` (underscore). CLI: `roxabi-dashboard` (hyphen).

## Conventions

- EN for docs/code/commits
- Commits: Conventional (`feat:`, `fix:`, `chore:`)
- Issues: `/dev #N`

## CLAUDE.md hygiene

File/rename → update P immediately

| P | Scope |
|---|---|
| `CLAUDE.md` | project root |

Rules: add/delete/move → update P | new `src/roxabi_dashboard/` subdir → nearest P (¬nested)

## Supervisor pattern

`deploy/supervisor/conf.d/` — one `.conf` file per program.
`autostart=false` on M₂ (dev); `autorestart=true` on M₁ (prod).
Log dir: `~/.local/state/roxabi-dashboard/logs/`

Programs added per spec slice:
- Slice 3: `dashboard.conf` (FastAPI + uvicorn)
- Slice 2: `cloudflared.conf` (tunnel daemon)
