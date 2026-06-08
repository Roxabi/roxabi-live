# Contributing

## Dev Environment

```bash
git clone https://github.com/Roxabi/roxabi-live.git
cd roxabi-live
make install        # uv sync --group dev
cp .env.example .env
```

Install pre-commit hooks:

```bash
uv run pre-commit install
```

## Running Tests

```bash
make test           # pytest (unit only, no integration markers)
```

Integration tests (require local `corpus.db` fixture):

```bash
uv run pytest -m integration
```

## Code Style

```bash
make lint           # ruff check
make format         # ruff format + ruff check --fix
make typecheck      # pyright (strict mode)
```

All three must pass before opening a PR. The pre-commit config enforces `ruff` and `pyright` on commit.

Key constraints:
- Python 3.12, strict pyright, ruff with complexity + arg-count rules.
- Max file length: 300 lines (`src/**/*.py`). Max folder size: 12 files (`src/**`). See `tools/file_exemptions.txt` and `tools/folder_exemptions.txt` for exemptions.
- Legacy v1/v5 dep_graph code is frozen — do not modify it.

## Commit Format

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

Types: `feat` | `fix` | `refactor` | `docs` | `style` | `test` | `chore` | `ci` | `perf`

Examples:
```
feat(api): add pagination to /api/issues
fix(webhook): handle missing sub_issues field
chore(deps): bump fastapi to 0.116
```

## PR Process

- Target branch: `staging`.
- Merge strategy: **merge commit** (no squash, no rebase).
- Keep PRs focused — one feature or fix per PR.
- Title must follow Conventional Commits format (enforced by CI).
- All CI checks must pass: lint, typecheck, tests, secret scan.

## Code Review

- Reviewers check correctness, type safety, and adherence to file/folder size limits.
- Functional changes to `corpus/` or `webhook/` must include or update tests.
- Doc changes (`.md`) do not require tests.
