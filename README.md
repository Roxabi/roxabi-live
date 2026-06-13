# Roxabi Live

**Operations cockpit for the Roxabi GitHub org — issue status, dependency graphs, and real-time sync.**

| Table View | List View | Graph View |
|:---:|:---:|:---:|
| ![Table](docs/images/table-view.png) | ![List](docs/images/list-view.png) | ![Graph](docs/images/graph-view.png) |

Roxabi Live pulls GitHub issues from the entire org into a [Cloudflare D1](https://developers.cloudflare.com/d1/) database and serves a multi-view dashboard at **[live.roxabi.dev](https://live.roxabi.dev)**. It tracks parent/child relationships and blockers, applies real-time updates via a GitHub org webhook, and re-syncs hourly via a Cron Trigger — all on a single Cloudflare Worker.

## Why

GitHub Projects and the default issue list give no cross-repo dependency view. Roxabi Live solves three specific gaps:

- **No pivot matrix** — GitHub has no milestone × lane overview across repos.
- **No dependency graph** — blocker and parent/child chains are invisible in the default UI.
- **No single corpus** — querying across repos requires multiple API calls with no local cache.

## Quick Start

Roxabi Live runs as a **Cloudflare Worker** at **[live.roxabi.dev](https://live.roxabi.dev)** (behind Cloudflare Access) — nothing to install to use it.

Local development:

```bash
git clone https://github.com/Roxabi/roxabi-live.git
cd roxabi-live/worker
npm ci
npx wrangler dev          # local Worker + D1 → http://localhost:8787
```

Deploys are CI-driven: push to `staging` → staging Worker; push to `main` → production (`live.roxabi.dev`).

## How It Works

```mermaid
flowchart LR
    CRON[Cron Trigger\n0 * * * *]
    GH[GitHub Org\nGraphQL API]
    W[CF Worker\nHono]
    DB[(D1\nroxabi-live-production)]
    R2[(R2\nroxabi-live-logs)]
    FE[Dashboard\nlive.roxabi.dev]
    WH[GitHub Webhook\nPOST /webhook/github]

    CRON -->|hourly scheduled| W
    GH -->|GraphQL| W
    W -->|upsert| DB
    DB -->|read| W
    W -->|JSON + static ASSETS| FE
    WH -->|HMAC-gated events| W
    W -->|per-run audit| R2
```

**Sync flow:**
1. A Cron Trigger (`0 * * * *`) invokes the Worker's `scheduled` handler hourly; `POST /admin/sync` triggers it out-of-band.
2. The Worker fetches issues via GitHub GraphQL — `subIssues`, `parent`, `blockedBy`, `blocking` fields — and upserts into D1 (tables: `issues`, `edges`, `repos`, `sync_state`).
3. The Worker serves the corpus over a JSON API; the static frontend (ASSETS binding) builds the views client-side.
4. The GitHub org webhook (`POST /webhook/github`, HMAC-verified) applies incremental updates in real time; each sync run writes a JSON audit to R2.

## Features

| Category | Feature |
|---|---|
| **Views** | Pivot matrix (milestones x lanes), flat list, SVG dependency graph |
| **Filters** | Multi-select: repo, milestone, priority, status; full-text search |
| **Dependencies** | Parent/child edges + blocker edges; status propagation (blocked/ready/done) |
| **Sync** | GitHub GraphQL sync; hourly Cron Trigger; real-time webhook updates |
| **Theme** | Light/dark toggle |
| **Storage** | Cloudflare D1 (serverless SQLite) + R2 per-run audit log |

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | DB reachability + issue count |
| `/api/version` | GET | Build/version info |
| `/api/issues` | GET | List issues (`repo`, `state`, `label`, `limit`, `offset` query params) |
| `/api/issues/{key}` | GET | Single issue by key, e.g. `Roxabi/lyra#123` |
| `/api/graph` | GET | Full dependency graph JSON (nodes + edges) |
| `/admin/sync` | POST | Out-of-band sync trigger (`Authorization: Bearer <ADMIN_TOKEN>`) |
| `/webhook/github` | POST | GitHub webhook receiver (HMAC-verified) |
| `/` | Static | Dep-graph dashboard (served via ASSETS) |

## Configuration

Bindings live in [`wrangler.toml`](wrangler.toml); secrets are set per-environment via `wrangler secret put`.

| Binding / Secret | Type | Description |
|---|---|---|
| `DB` | D1 | Issue corpus (`roxabi-live-production` / `roxabi-live-staging`) |
| `ASSETS` | Static | Serves `frontend/` |
| `LOGS` | R2 | Per-run sync audit (`roxabi-live-logs`) |
| `GITHUB_TOKEN` | secret | GitHub GraphQL auth |
| `GITHUB_ORG` | var | Org to sync |
| `GITHUB_WEBHOOK_SECRET` | secret | HMAC verification for `/webhook/github` |
| `ADMIN_TOKEN` | secret (optional) | Bearer gate for `/admin/*` |
| Cron | trigger | `0 * * * *` — hourly sync |

```bash
# set a secret (prod, then staging)
printf %s '<value>' | wrangler secret put GITHUB_TOKEN
printf %s '<value>' | wrangler secret put GITHUB_TOKEN --env staging
```

## Plugins

This repo also hosts the **`roxabi-issues`** Claude Code plugin (`plugins/roxabi-issues/`), relocated from `dev-core` — issue triage that pairs with the cockpit.

```bash
claude plugin marketplace add Roxabi/roxabi-live
claude plugin install roxabi-issues
```

The `issue-triage` skill (invoked `roxabi-issues:issue-triage`) sets labels (size / priority / lane / type) and manages blocked-by dependencies and parent/child sub-issues on GitHub issues — **labels + native relations only, no Projects V2 board** (the cockpit owns the read/dashboard side). Self-contained bun project.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
