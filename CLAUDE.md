@.claude/stack.yml

# Roxabi Dashboard

Hosted, multi-user web dashboard for the Roxabi team. Replaces the local `dev-core` issues dashboard (currently in `roxabi-plugins`) with a deployed web app accessible from any device.

**See `vision.md` for full product vision and architecture decisions.**

## TL;DR

- **Project:** Roxabi Dashboard
- **Before work:** Use `/dev #N` as the single entry point — it determines tier (S / F-lite / F-full) and drives the full lifecycle
- **Decisions:** summarize context → numbered options + recommendation → wait for reply (see [Decision Protocol](#decision-protocol))
- **Never** commit without asking, push without request, or use `--force`/`--hard`/`--amend`
- **Always** use appropriate skill even without slash command

## Project Overview

Real-time GitHub project management dashboard for the Roxabi team. Vision → [vision.md](vision.md).

**Style:** single quotes, no semicolons, trailing commas (es5), 2-space indent, 100-char width

```bash
cp .env.example .env && bun install && bun run db:up && bun run dev  # web:3000 api:4000 email:3001
```

```
apps/web   @repo/web    TanStack Start + Vite + Tailwind v4
apps/api   @repo/api    NestJS + Fastify + Drizzle ORM
apps/docs  @repo/docs   Fumadocs (Next.js) — standalone docs site, port 3002
packages/  ui(@repo/ui) types(@repo/types) config(@repo/config) email vitest-config playwright-config
```

## Commands

| Task | Command | Notes |
|------|---------|-------|
| Dev | `bun run dev` | web:3000, api:4000, email:3001, nitro:42069 |
| Build | `bun run build` | TurboRepo-cached |
| Lint / fix | `bun run lint` / `lint:fix` | Biome |
| Format | `bun run format` | Biome |
| Typecheck | `bun run typecheck` | All packages |
| Test | `bun run test` | Vitest (¬`bun test`) |
| Test watch / coverage / e2e | `test:watch` / `test:coverage` / `test:e2e` | |
| Affected only | `typecheck:affected` / `test:affected` | Changed vs main |
| Kill ports | `bun run dev:clean` | Orphaned 42069/4000/3000/3001 |
| DB up/down | `db:up` / `db:down` | Docker Postgres 16 |
| DB generate/migrate/reset/seed | `db:generate` / `db:migrate` / `db:reset` / `db:seed` | |
| DB branch | `cd apps/api && bun run db:branch:create --force XXX` | Per-worktree |
| Clean | `bun run clean` / `clean:cache` | Artifacts / caches |
| i18n | `bun run i18n:check` | Translation completeness |
| Env check | `bun run env:check` | .env ↔ .env.example |
| MDX check | `bun run mdx:check` | Frontmatter, JSX, links |
| Custom lint | `bun run lint:custom` | DRIZZLE injection + @repo/types boundary |
| License | `bun run license:check` | Dependency licenses |
| Docs | `bun run docs` | Runs apps/docs (port 3002) |
| Dashboard | `/issues` skill | Issue dashboard (plugin-provided) |

## Critical Rules

### 1. Dev Process

**Entry point: `/dev #N`** — single command that scans artifacts, shows progress, and delegates to the right phase skill. Full spec → [dev-process.mdx](docs/processes/dev-process.mdx).

| Tier | Criteria | Phases |
|------|----------|--------|
| **S** | ≤3 files, no arch, no risk | triage → implement → pr → validate → review → fix* → promote* → cleanup* |
| **F-lite** | Clear scope, single domain | Frame → spec → plan → implement → verify → ship |
| **F-full** | New arch, unclear reqs, >2 domains | Frame → analyze → spec → plan → implement → verify → ship |

`*` = conditional (runs only if applicable — e.g., fix runs only if review produces findings)

Phases: **Frame** (problem) → **Shape** (spec) → **Build** (code) → **Verify** (review) → **Ship** (release).

### 2. Decision Protocol

Never use `AskUserQuestion`. For all decisions, choices (≥2 options), approach proposals:

1. **Summarize** — why / root cause / current behavior / target / path to reach it
2. **Propose** — numbered options, one marked as recommended
3. **Explain** — why the recommended option is recommended

Then wait for reply.

### Git

Format: `<type>(<scope>): <desc>` + `Co-Authored-By: Claude <model> <noreply@anthropic.com>`
Types: feat|fix|refactor|docs|style|test|chore|ci|perf
Never push without request. Never force/hard/amend. Hook fail → fix + NEW commit.

## What This Is

A real-time GitHub project management dashboard:
- Live issues, PRs, CI status, Vercel deployments across all Roxabi repos
- Multi-user auth via GitHub OAuth (no per-machine PAT setup)
- Persistent workspace config in PostgreSQL (not a local JSON file)
- SSE live updates, field edits (status/size/priority) from the UI

## What This Is NOT

- Not a public SaaS (internal Roxabi use only, v1)
- Not a replacement for GitHub — no issue creation, PR management, etc.
- Not yet built — stack TBD, currently in architecture/vision phase

## Origin

Forked from `roxabi_boilerplate` (TanStack Start + NestJS + PostgreSQL + Better Auth + Tailwind v4). Core GitHub data logic ported from `roxabi-plugins/plugins/dev-core/skills/issues/`.

## Key References

- `vision.md` — Product vision, feature set, migration plan from local dashboard
- `../roxabi-plugins/plugins/dev-core/skills/issues/` — Current local dashboard to port
- `../roxabi_boilerplate/` — Base stack to fork from

## Stack (planned)

- **Frontend:** TanStack Start + React 19 + Radix UI + Tailwind v4
- **Backend:** NestJS + Fastify
- **Database:** PostgreSQL + Drizzle ORM
- **Auth:** Better Auth (GitHub OAuth)
- **Real-time:** NestJS SSE
- **Deploy:** Vercel (main → prod, staging → preview)
- **Monorepo:** Bun + TurboRepo

## Gotchas

- `bun test` ≠ `bun run test` — former = Bun runner (CPU spin), latter = Vitest. Hook blocks it.
- `turbo.jsonc` ¬`turbo.json` — JSONC with comments.
- Node ≥24, Bun 1.3.9 = pkg manager.
- Orphaned ports → `bun run dev:clean`.
- Biome upgrade → sync `$schema` version in `biome.json`.
- Sub-issues: `addSubIssue` GraphQL mutation, ¬markdown checklists. Use `/issue-triage --parent`.
- Post-rebase: `bun install` before push if new build steps added.
- `gh pr edit --add-label` broken (Projects Classic deprecation) → use `gh api repos/:owner/:repo/issues/:number/labels -f "labels[]=<label>"`.
- `gh pr view --json` has no `merged` field → use `mergedAt` (null = not merged).
- `@repo/types` import boundary: `apps/web` must not import `@repo/types/api`, `apps/api` must not import `@repo/types/ui`. Enforced by `bun run lint:custom`.
- Domain gotchas → [apps/api/CLAUDE.md](apps/api/CLAUDE.md) and [apps/web/CLAUDE.md](apps/web/CLAUDE.md).

## Reference

| Topic | Path |
|-------|------|
| Getting started | [getting-started.mdx](docs/getting-started.mdx) |
| Config | [configuration.mdx](docs/configuration.mdx) |
| Dev process | [dev-process.mdx](docs/processes/dev-process.mdx) |
| Issues | [issue-management.mdx](docs/processes/issue-management.mdx) |
| Architecture | [docs/architecture/](docs/architecture/) |
| FE / BE / Test / Review | [frontend-patterns](docs/standards/frontend-patterns.mdx) / [backend-patterns](docs/standards/backend-patterns.mdx) / [testing](docs/standards/testing.mdx) / [code-review](docs/standards/code-review.mdx) |
| Contributing | [contributing.mdx](docs/contributing.mdx) |
| Deploy / Auth / Agents | [deployment](docs/guides/deployment.mdx) / [authentication](docs/guides/authentication.mdx) / [agent-teams](docs/guides/agent-teams.mdx) |
| Vision | [vision.mdx](docs/product/vision.mdx) |
| Frames / Analyses / Specs / Plans | [artifacts/frames/](artifacts/frames/) / [artifacts/analyses/](artifacts/analyses/) / [artifacts/specs/](artifacts/specs/) / [artifacts/plans/](artifacts/plans/) |

**Deploy:** `main` → Vercel prod. `staging` → preview. Details in [apps/web/CLAUDE.md](apps/web/CLAUDE.md) and [apps/api/CLAUDE.md](apps/api/CLAUDE.md).

**Hooks (Claude Code):** Biome auto-format (PostToolUse) | Security warn (PreToolUse) | `bun test` blocker (PreToolUse)
**Hooks (Git/Lefthook):** pre-commit (Biome) | commit-msg (Commitlint) | pre-push (lint+typecheck+tests+i18n+license)
