# Contributing

## Dev Environment

```bash
git clone https://github.com/Roxabi/roxabi-live.git
cd roxabi-live
bun install
uv sync --group dev   # license check + pre-commit only
```

Install pre-commit hooks:

```bash
uv run pre-commit install
```

## Running Locally

```bash
# API worker (port 8787)
cd apps/api && bunx wrangler dev

# React SPA (separate terminal)
cd apps/app && bun run dev

# Marketing site
bun run dev:marketing
```

Optional secrets: `apps/api/.dev.vars` (see [docs/getting-started.md](docs/getting-started.md)).

## Running Tests

```bash
bun install
bun --filter @roxabi-live/api test
bun --filter @roxabi-live/app test
bun --filter @roxabi-live/shared typecheck
cd plugins/roxabi-issues && bun test
bun run test:e2e   # Playwright (requires running stack)
```

## Code Style

```bash
bunx biome check apps/api/src apps/app/src
bunx biome check --write apps/api/src apps/app/src
uv run ruff check tools
```

Biome is enforced in CI (`api` job) and pre-commit. Key constraints:

- Max file length: 300 SLOC for `apps/api/src/**/*.ts` (see `tools/file_exemptions.txt`).
- Secrets via `wrangler secret put` — never commit tokens.

## Commit Format

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

Types: `feat` | `fix` | `refactor` | `docs` | `style` | `test` | `chore` | `ci` | `perf`

## PR Process

- Target branch: `staging`.
- Merge strategy: **merge commit** (no squash, no rebase).
- Keep PRs focused — one feature or fix per PR.
- Title must follow Conventional Commits format (enforced by CI).
- All CI checks must pass: api tests, app tests, Biome, license check, secret scan.

## Code Review

- Reviewers check correctness, tenant isolation, and auth boundaries on API/app worker changes.
- Functional Worker/frontend changes must include or update tests.
- Doc changes (`.md`) do not require tests.