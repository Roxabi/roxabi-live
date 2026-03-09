# Roadmap & Migration Plan

> Porting the local `dev-core` issues dashboard to a hosted web app built on `roxabi_boilerplate`.

## Phases Overview

```
Phase 0 — Foundation       Fork boilerplate, strip, configure
Phase 1 — Auth & Workspace  GitHub OAuth, user workspace CRUD
Phase 2 — Data Layer        GitHub API integration in NestJS
Phase 3 — Dashboard UI      Port HTML components → React
Phase 4 — Real-time         SSE live updates
Phase 5 — Field Updates     Right-click / inline edits
Phase 6 — Graph & Advanced  Dependency graph, Vercel, CI status
Phase 7 — Polish & Ship     E2E tests, perf, production deploy
```

---

## Phase 0 — Foundation

**Goal:** Working monorepo with boilerplate stripped to the essentials.

**Sequence:**

1. Fork `roxabi_boilerplate` into `roxabi-dashboard`
2. Strip unused boilerplate features:
   - Remove i18n (Paraglide, locale routing, translation files)
   - Remove email flows (templates, Nodemailer, Resend)
   - Remove consent banner / GDPR module
   - Remove organization management (can add back later)
   - Remove admin panel
3. Rename apps (`apps/web`, `apps/api`) — keep as-is
4. Update root `package.json`, `turbo.json`, workspace names
5. Verify `bun run dev` starts cleanly (web + api)
6. Set up `.env` with DB connection, GitHub OAuth app credentials
7. Run DB migrations (Drizzle)

**Dependencies:** None. Starting point.

**Output:** Clean monorepo, `bun run dev` green, DB connected.

---

## Phase 1 — Auth & Workspace

**Goal:** Users can log in with GitHub OAuth and manage their workspace (which repos/projects to watch).

**Sequence:**

1. **GitHub OAuth** (Better Auth already supports it)
   - Register GitHub OAuth app (Settings → Developer settings)
   - Wire `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in `.env`
   - Store GitHub access token in Better Auth session/account table
   - Verify token refresh flow

2. **Workspace DB schema** (Drizzle)
   ```
   workspaces
     id, userId, createdAt, updatedAt

   workspace_projects
     id, workspaceId, repo, projectId, label, type,
     statusFieldId, col2FieldId, col3FieldId,
     statusOptions (jsonb), col2Options (jsonb), col3Options (jsonb),
     vercelProjects (jsonb), localPath, sortOrder
   ```

3. **Workspace API** (NestJS `WorkspaceModule`)
   - `GET /workspace` — fetch user's workspace + projects
   - `POST /workspace/projects` — add project
   - `DELETE /workspace/projects/:id` — remove project
   - `PATCH /workspace/projects/:id` — update (order, label, etc.)

4. **Workspace UI** (TanStack Start)
   - Settings / onboarding page: add first project
   - Project list with add/remove
   - GitHub project board selector (calls GitHub API to list PVT boards user has access to)

**Dependencies:** Phase 0 complete, GitHub OAuth app created.

**Ports from current dashboard:**
- `workspace-helpers.ts` → Drizzle queries in `WorkspaceService`
- `config-helpers.ts` → `WorkspaceProjectMapper` util

---

## Phase 2 — GitHub Data Layer

**Goal:** NestJS can fetch, cache, and serve GitHub project data for a user's workspace.

**Sequence:**

1. **GitHub service** (`apps/api/src/github/`)
   - Port `github-adapter.ts` GraphQL queries verbatim
   - Port `fetch.ts` aggregation logic into `GithubService`
   - Auth: inject user's GitHub OAuth token from session
   - Types: move `lib/types.ts` → `packages/types/src/github.ts`

2. **Cache layer** (PostgreSQL)
   ```
   github_cache
     id, workspaceProjectId, cacheKey, data (jsonb),
     fetchedAt, ttlSeconds, stale
   ```
   - Cache per-project, TTL 60s (configurable)
   - `GithubCacheService` with get/set/invalidate

3. **Background refresh** (NestJS `ScheduleModule`)
   - Cron job: refresh all workspace projects every 60s
   - Respects GitHub API rate limits (check `X-RateLimit-Remaining`)
   - Mark cache as `stale` on fetch failure (serve stale, don't 500)

4. **Dashboard API endpoint**
   - `GET /dashboard/:workspaceId` — returns aggregated data (issues, PRs, CI, deployments) for all projects in workspace
   - Reads from cache; triggers background refresh if stale

**Dependencies:** Phase 1 complete (need user token from auth session).

**Ports from current dashboard:**
- `lib/fetch.ts` → `GithubService.fetchProject()`
- `lib/github-adapter.ts` → `GithubAdapter` (copy GraphQL queries directly)
- `lib/types.ts` → `packages/types/src/github.ts`
- `lib/config.ts` → NestJS `ConfigService`

---

## Phase 3 — Dashboard UI (Core)

**Goal:** Static React dashboard rendering issues, PRs, and CI status from the API.

**Sequence:**

1. **Route structure** (TanStack Router)
   ```
   /                  → redirect to /dashboard
   /login             → GitHub OAuth sign-in page
   /dashboard         → main dashboard (default workspace)
   /dashboard/:tab    → per-project tab
   /settings          → workspace management
   ```

2. **Data fetching** (React Query)
   - `useDashboard(workspaceId)` hook → `GET /dashboard/:workspaceId`
   - Polling fallback (60s) if SSE not yet wired (Phase 4)

3. **Tab bar component**
   - "All" tab + per-project tabs
   - Optional "Roadmap" tab
   - "+ Add project" button → settings flow

4. **Issues table** (port `lib/components.ts` → React)
   - Columns: #, Title, Status, Size, Priority, Block Status, Dependencies
   - Color-coded badges (status/priority)
   - Sub-issues nested (tree structure)
   - "Show more" collapse (default 8 visible)

5. **PR section** (port from `components.ts`)
   - Status, CI checks, diff stats (+/-), review decision badge

6. **CI / Workflow runs section**
   - Branch CI status, expandable workflow checks

**Dependencies:** Phase 2 complete (API returning real data).

**Ports from current dashboard:**
- `lib/components.ts` row renderers → React components
- `lib/page.ts` layout + sections → route component + layout
- `lib/page-styles.ts` CSS → Tailwind classes + `@repo/ui` components

---

## Phase 4 — Real-time (SSE)

**Goal:** Dashboard auto-updates without refresh when GitHub data changes.

**Sequence:**

1. **NestJS SSE endpoint**
   - `GET /dashboard/:workspaceId/events` — `@Sse()` controller method
   - Emits `{ type: 'refresh' }` event whenever cache is updated
   - Heartbeat every 30s to keep connection alive

2. **React SSE hook**
   - `useDashboardEvents(workspaceId)` → `EventSource` connection
   - On `refresh` event: invalidate React Query cache → auto-refetch
   - Reconnect on drop (exponential backoff)

3. **Selective DOM patching** (optional optimization)
   - For v1, full refetch is fine
   - Later: diff-based update to preserve scroll position / expanded state

**Dependencies:** Phase 3 complete.

**Ports from current dashboard:**
- SSE server logic in `dashboard.ts` → NestJS `@Sse()` + `Subject` from RxJS
- Client-side `EventSource` setup in `page.ts` → `useDashboardEvents` hook

---

## Phase 5 — Field Updates

**Goal:** Users can update issue Status / Size / Priority directly from the dashboard.

**Sequence:**

1. **Update API** (NestJS)
   - `POST /github/update` — port `lib/update.ts` into `GithubService.updateField()`
   - Validates field ID + option ID against workspace project schema
   - Calls GitHub GraphQL mutation
   - Invalidates cache for that project → triggers SSE refresh

2. **Context menu** (React)
   - Right-click on issue row → context menu with field options
   - Read available options from workspace project field schema
   - Optimistic update in React Query while mutation in flight
   - Toast on success / error

3. **Project add/remove**
   - Right-click → "Add to project" / "Remove from project"
   - `POST /github/project-item` → GitHub REST API

**Dependencies:** Phase 3 (UI) + Phase 4 (SSE invalidation on update).

**Ports from current dashboard:**
- `lib/update.ts` → `GithubService.updateField()`
- Right-click context menu JS in `page.ts` → React context menu component (Radix `DropdownMenu`)

---

## Phase 6 — Dependency Graph & Vercel

**Goal:** Dependency graph visualization + Vercel deployment status.

**Sequence:**

1. **Dependency graph** (React)
   - Port `lib/graph.ts` layout algorithm as-is (pure function, no DOM dependency)
   - Render with SVG or a lightweight graph lib (D3 / `@xyflow/react`)
   - Show root-level blocking relationships
   - Click to expand issue details

2. **Vercel deployments**
   - Add `VERCEL_TOKEN` per workspace project (stored encrypted in DB)
   - Port Vercel API calls from `lib/fetch.ts` into `VercelService`
   - Display: current deployment, build steps, preview link, production link

3. **Branches & worktrees** (optional for v1)
   - Requires access to local Git — only works if server runs on same machine
   - Likely skip for v1 (not meaningful for a hosted app)

**Dependencies:** Phase 3 UI complete.

**Ports from current dashboard:**
- `lib/graph.ts` → `apps/web/src/components/dependency-graph/layout.ts` (copy verbatim)
- Vercel fetch logic in `lib/fetch.ts` → `VercelService`

---

## Phase 7 — Polish & Ship

**Goal:** Production-ready, tested, deployed.

**Sequence:**

1. Vitest unit tests for `GithubService`, `WorkspaceService`, cache logic
2. Playwright E2E: login flow, dashboard load, field update
3. Performance: check React Query caching, avoid unnecessary re-renders
4. Error states: stale cache banner, GitHub API errors, auth token expiry
5. Empty state: onboarding flow for new users with no workspace
6. Vercel production deploy (`main` branch → prod)
7. Update `README.md` with setup instructions

---

## Dependency Graph (Phases)

```
Phase 0 (Foundation)
  └── Phase 1 (Auth & Workspace)
        └── Phase 2 (GitHub Data Layer)
              └── Phase 3 (Dashboard UI)
                    ├── Phase 4 (Real-time SSE)
                    │     └── Phase 5 (Field Updates)
                    ├── Phase 5 (Field Updates)
                    └── Phase 6 (Graph & Vercel)
                          └── Phase 7 (Polish & Ship)
```

Phases 4, 5, and 6 can be parallelized once Phase 3 is done.

---

## Files to Port (Checklist)

### From `roxabi-plugins/plugins/dev-core/skills/issues/lib/`

| File | Destination | Notes |
|---|---|---|
| `types.ts` | `packages/types/src/github.ts` | Copy verbatim |
| `github-adapter.ts` | `apps/api/src/github/github-adapter.ts` | Copy GraphQL queries verbatim, inject auth token |
| `fetch.ts` | `apps/api/src/github/github.service.ts` | Port aggregation logic |
| `update.ts` | `apps/api/src/github/github.service.ts` | Add as `updateField()` method |
| `graph.ts` | `apps/web/src/components/dependency-graph/layout.ts` | Copy verbatim (pure function) |
| `components.ts` | `apps/web/src/components/dashboard/` | Port to React components |
| `page.ts` | `apps/web/src/routes/dashboard.tsx` | Port layout + sections |
| `page-styles.ts` | Tailwind classes | Translate to Tailwind, discard |
| `config.ts` | NestJS `ConfigService` | Use env vars |
| `table-formatter.ts` | Discard | CLI-only, not needed |

### From `roxabi-plugins/plugins/dev-core/skills/shared/adapters/`

| File | Destination | Notes |
|---|---|---|
| `workspace-helpers.ts` | `apps/api/src/workspace/workspace.service.ts` | Replace file I/O with Drizzle queries |
| `config-helpers.ts` | `apps/api/src/workspace/workspace.mapper.ts` | Port field mapping logic |

---

## Open Questions

1. **Multi-workspace:** One workspace per user, or can users have multiple named workspaces? (Keep it simple for v1: one per user)
2. **GitHub token scope:** Which OAuth scopes does the dashboard need? (`read:org`, `repo`, `project` at minimum)
3. **Rate limiting strategy:** Cache per-project or per-API-call? Per-project is simpler and sufficient.
4. **Vercel token:** Per-user OAuth or per-project PAT stored in settings? PAT is simpler for v1.
5. **Branch/worktree section:** Skip entirely for v1 (requires local Git access, not meaningful for hosted app)?
