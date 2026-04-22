SHELL := /bin/bash -o pipefail

SUPERVISOR_DIR := deploy/supervisor

.PHONY: install lint typecheck test format dashboard start stop status logs

# ── Dev ───────────────────────────────────────────────────────────────────────

install:           ## Install all dependencies
	uv sync --group dev

lint:              ## Run ruff linter
	uv run ruff check .

typecheck:         ## Run pyright type checker
	uv run pyright

test:              ## Run pytest
	uv run pytest

format:            ## Auto-format with ruff
	uv run ruff format . && uv run ruff check --fix .

# ── Supervisor ────────────────────────────────────────────────────────────────

start:             ## Start supervisord (programs stay stopped)
	bash $(SUPERVISOR_DIR)/start.sh

start-all:         ## Start supervisord + all programs
	bash $(SUPERVISOR_DIR)/start.sh --all

stop:              ## Stop all programs (supervisord stays running)
	bash $(SUPERVISOR_DIR)/supervisorctl.sh stop all || true

status:            ## Show supervisor program status
	bash $(SUPERVISOR_DIR)/supervisorctl.sh status || true

logs:              ## Tail supervisord log
	tail -f "$$HOME/.local/state/roxabi-dashboard/logs/supervisord.log"
