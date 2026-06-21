SHELL := /bin/bash -o pipefail

.PHONY: install lint test format license

install:             ## install repo tooling (license check, pre-commit)
	uv sync --group dev

lint:                ## run ruff on tools/
	uv run ruff check tools

format:              ## auto-format tools/ with ruff
	uv run ruff format tools && uv run ruff check --fix tools

license:             ## verify Python dev dependency licenses
	uv run tools/license_check.py

test:                ## run Worker + frontend test suites
	cd worker && npm test
	cd frontend && npm test