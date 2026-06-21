# Contributing

## Dev Environment

```bash
git clone https://github.com/Roxabi/roxabi-live.git
cd roxabi-live
cd worker && npm ci
cd ../frontend && npm ci
uv sync --group dev   # license check + pre-commit only
```

Install pre-commit hooks:

```bash
uv run pre-commit install
```

## Running Tests

```bash
cd worker && npm test
cd frontend && npm test
```

Or from the repo root: `make test`

## Code Style

```bash
cd worker && npm run lint && npm run typecheck
cd frontend && npm test
uv run ruff check tools
```

Worker and frontend use **Biome** (`biome.json` at repo root). Pre-commit runs Biome, TruffleHog, license check, and worker typecheck on push.

Key constraints:
- Max file length: 300 SLOC for `worker/src/**/*.ts` (see `tools/file_exemptions.txt`).
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
- All CI checks must pass: worker tests, frontend tests, Biome, license check, secret scan.

## Code Review

- Reviewers check correctness, tenant isolation, and auth boundaries on Worker changes.
- Functional Worker/frontend changes must include or update tests.
- Doc changes (`.md`) do not require tests.