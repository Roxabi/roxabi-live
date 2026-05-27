SHELL := /bin/bash -o pipefail

.PHONY: install lint typecheck test format sync full-sync

# ── Dev ──────────────────────────────────────────────────────────────────────

install:             ## install all dependencies
	uv sync --group dev

lint:                ## run ruff linter
	uv run ruff check .

typecheck:           ## run pyright type checker
	uv run pyright

test:                ## run pytest
	uv run pytest

format:              ## auto-format with ruff
	uv run ruff format . && uv run ruff check --fix .

# ── Corpus sync ───────────────────────────────────────────────────────────────

sync:                ## sync corpus with GitHub
	uv run roxabi-corpus sync $(ARGS)

full-sync:           ## full sync (clear sync_state, re-fetch all issues)
	sqlite3 $(HOME)/.roxabi/corpus.db "DELETE FROM sync_state"
	uv run roxabi-corpus sync
