# Contributing

## Dev environment setup

**Prerequisites:**
- [Bun](https://bun.sh) ≥ 1.1 — `curl -fsSL https://bun.sh/install | bash`
- [Docker](https://docs.docker.com/get-docker/) — for local PostgreSQL
- [GitHub CLI](https://cli.github.com) — `gh auth login` with your GitHub account

```bash
# 1. Clone and install
git clone https://github.com/Roxabi/roxabi-dashboard.git
cd roxabi-dashboard
bun install           # also installs Lefthook git hooks

# 2. Configure environment
cp .env.example .env  # fill in DB_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET

# 3. Start the database and run migrations
docker compose up -d
cd apps/api && bun run db:migrate

# 4. Start the dev servers
bun dev               # starts web + api concurrently via TurboRepo
```

Open `http://localhost:3000` — sign in with GitHub OAuth.

## Workflow

All development uses **worktrees**. `main` is production, `staging` is the integration branch.

```bash
git worktree add ../roxabi-XXX -b feat/XXX-slug staging
cd ../roxabi-XXX && cp .env.example .env && bun install
cd apps/api && bun run db:branch:create --force XXX
```

```
worktree branch → PR → staging → (promote) → main
```

1. Create a worktree from `staging` (see above)
2. Implement, commit, push
3. Open a PR targeting `staging`
4. Pass CI (lint, typecheck, tests)
5. Merge — never code directly on `main` or `staging`

Exception: XS changes (single file, no risk) can go directly on `staging` after confirmation.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/) — enforced by Commitlint (Lefthook):

```
feat(web): add billing dashboard page
fix(api): handle null tenant in auth guard
chore: bump bun to 1.3.10
test(api): cover subscription renewal edge case
refactor(ui): extract DataTable component
```

- Types: `feat|fix|refactor|docs|style|test|chore|ci|perf`
- Scope: `web`, `api`, `ui`, `types`, `config`, `ci`
- Always include `Co-Authored-By` when pair-programming with Claude

## PR conventions

- Title = Conventional Commits format
- Link the issue: `Closes #N`
- One logical change per PR
- All checks must pass before merge

## Code style

```bash
bun run lint              # Biome lint — must pass
bun run format            # Biome format — auto-fix
bun run typecheck         # TypeScript — must pass
bun run test              # Vitest (not `bun test`) — must pass
bun run test:e2e          # Playwright e2e
```

Style: single quotes, no semicolons, trailing commas (es5), 2-space indent, 100-char width.

Lefthook hooks: pre-commit (Biome), commit-msg (Commitlint), pre-push (lint + typecheck + tests).

## Testing

- Unit tests: Vitest — run with `bun run test` (never `bun test`, that uses the Bun runner)
- E2E tests: Playwright — run with `bun run test:e2e`
- Coverage: `bun run test:coverage`

## Code review expectations

Reviews use [Conventional Comments](https://conventionalcomments.org/). Labels signal intent:

| Label | Meaning |
|-------|---------|
| `suggestion:` | Optional improvement — author decides |
| `nitpick:` | Minor style point — low priority |
| `question:` | Seeking understanding, not blocking |
| `issue:` | Must be resolved before merge |
| `praise:` | Positive signal — no action needed |

**Reviewer checklist:** correctness, security boundaries, test coverage, Conventional Commits format on the PR title.

**Author expectations:** respond to every `issue:` before requesting re-review. Non-blocking comments can be resolved after merge if noted.

## Project structure

See [README.md](README.md) for the full project tree. TurboRepo orchestrates builds; each app/package has its own `package.json`.
