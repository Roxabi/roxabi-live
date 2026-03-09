# Vision — Roxabi Dashboard

> **From local dev tool to hosted team command center.**

## The Problem

The current issues dashboard (shipped inside the `dev-core` plugin) is a powerful local tool — but it's locked to one machine, one GitHub token, and one developer at a time. Every team member has to set it up independently, configure their own `.env`, and run it on their own machine. There's no shared state, no team-level view, and no way to access it from a phone, a meeting, or a browser tab.

## The Vision

**Roxabi Dashboard is a hosted, multi-user web application** that gives the entire Roxabi team a live, unified view of every project's health — issues, PRs, CI status, and Vercel deployments — from any device, at any time.

It takes everything the local dashboard does well (real-time GitHub data, dependency graphs, field updates, multi-project workspace) and makes it a first-class product: authenticated, persistent, shareable, and always on.

---

## Who Uses It

**Internally, for the Roxabi team.** Not a public SaaS (yet). Users are:

- **Developers** — track their issues, unblock dependencies, see CI status
- **Tech leads** — get a cross-repo view of what's in progress, what's blocked, what's ready for review
- **Product** — monitor priorities and roadmap without needing GitHub fluency

---

## Core Features (v1)

### Multi-project Workspace
Unified view across all Roxabi repos. Each project gets a tab. A global "All" view aggregates everything. Roadmap tab for cross-repo priorities.

### Live Issue Board
Real-time GitHub issues with Status, Size, Priority fields — editable directly from the UI (right-click or inline). Dependency graph shows what's blocked and what unblocks it. Sub-issues nested under parents.

### PR & CI Status
Pull requests with review state, CI checks, and Vercel preview links. Branch CI status. GitHub Actions workflow runs. All in one place.

### Vercel Deployments
Current production and preview deployments per project, with build step status and direct links.

### Team Auth
Sign in with GitHub OAuth. Each user connects their own GitHub account — no shared PAT, no `.env` gymnastics. Better Auth handles sessions, refresh tokens, and org membership.

### Persistent Workspace
Workspace config (which projects to show, field IDs, Vercel links) stored in PostgreSQL per user — not in a local JSON file. Survives machine changes, syncs across devices.

---

## What Changes vs. the Local Dashboard

| Local CLI Dashboard | Roxabi Dashboard |
|---|---|
| Bun HTTP server, no framework | TanStack Start (React 19) + NestJS |
| Vanilla JS + CSS-in-JS | React components + Tailwind v4 + Radix UI |
| PAT in `.env` per machine | GitHub OAuth per user (Better Auth) |
| `~/.roxabi-vault/workspace.json` | PostgreSQL workspace table per user |
| 60s poll, in-process cache | NestJS background job + DB cache (respects rate limits) |
| SSE from local Bun server | NestJS SSE endpoint |
| Single user | Multi-user, org-aware |
| No deployment | Vercel (main → prod, staging → preview) |

---

## Tech Stack

Built on `roxabi_boilerplate` — fork it, strip what we don't need, wire in the dashboard.

| Layer | Choice | Reason |
|---|---|---|
| Frontend | TanStack Start + React 19 | Already in boilerplate, SSR, file-based routing |
| UI | Radix UI + Tailwind v4 + `@repo/ui` | Consistent with Roxabi design system |
| Backend | NestJS + Fastify | Already in boilerplate, clean module structure |
| Database | PostgreSQL + Drizzle | Workspace persistence, GitHub API cache |
| Auth | Better Auth (GitHub OAuth) | Replace PAT with per-user OAuth tokens |
| Real-time | NestJS SSE | Same pattern as current dashboard, just in NestJS |
| Deployment | Vercel | Already configured |
| Monorepo | Bun + TurboRepo | Matches boilerplate |

**What we strip from the boilerplate:** i18n (Paraglide), email flows, consent banner, organization management, admin panel. We can add them back later if needed — better to start lean.

**What we keep from the boilerplate:** Auth, RBAC basics, PostgreSQL + Drizzle, React + Tailwind + Radix, NestJS structure, Vitest + Playwright, CI/CD workflows.

---

## Migration Plan

The current dashboard's core logic ports cleanly:

| Source file (roxabi-plugins) | Destination |
|---|---|
| `lib/fetch.ts` + `github-adapter.ts` | `apps/api/src/github/github.service.ts` |
| `lib/types.ts` | `packages/types/src/github.ts` |
| `lib/graph.ts` | `apps/web/src/components/dependency-graph/` |
| `lib/components.ts` + `page.ts` | React components under `apps/web/src/components/dashboard/` |
| Right-click field update flow | React context menu + React Query mutation → NestJS endpoint |
| SSE `/api/events` | NestJS `@Sse()` endpoint in `GithubController` |
| `workspace.json` | PostgreSQL `workspaces` table, per user |

The GitHub GraphQL queries are **copy-paste ready** — they don't change.

---

## GitHub Data Model

```
User
  └── Workspace (per user, stored in DB)
        └── WorkspaceProject[]
              ├── repo (owner/repo)
              ├── projectId (PVT_...)
              ├── fieldIds (status, size, priority)
              ├── vercelProjects[]
              └── localPath (optional, for branch/worktree info)
```

GitHub API calls are made **server-side** using the user's stored OAuth token. Responses are cached in PostgreSQL with a TTL (default 60s), refreshed by a background NestJS scheduler. SSE notifies connected clients on cache refresh.

---

## Non-Goals (v1)

- **Not a public product** — internal Roxabi use only for now
- **No write operations beyond field updates** — creating issues, closing PRs etc. stays in GitHub
- **No mobile-specific UI** — responsive enough to be usable, not optimized
- **No notifications / alerting** — view only, no push alerts
- **No custom dashboards / widgets** — fixed layout matching current dashboard

---

## Success Criteria

- Any Roxabi team member can open the dashboard in a browser and see live project status within 2 seconds of logging in
- Field updates (status, size, priority) reflect in GitHub within 5 seconds
- No per-machine setup — GitHub OAuth handles everything
- Dashboard stays current without manual refresh (SSE live updates)
- Works reliably at the Roxabi org scale (~10 repos, ~5 concurrent users)
