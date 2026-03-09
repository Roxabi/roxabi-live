@.claude/stack.yml

# Roxabi Dashboard

Hosted, multi-user web dashboard for the Roxabi team. Replaces the local `dev-core` issues dashboard (currently in `roxabi-plugins`) with a deployed web app accessible from any device.

**See `vision.md` for full product vision and architecture decisions.**

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
