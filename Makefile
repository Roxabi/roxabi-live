SHELL := /bin/bash -o pipefail

SUPERVISOR_HUB ?= $(HOME)/projects
HUB_SERVICES   := live
-include $(SUPERVISOR_HUB)/hub.mk

# Fallback SVC_CMD parsing when hub.mk is not present (e.g. prod).
ifndef SVC_CMD
ifneq (,$(filter $(HUB_SERVICES),$(firstword $(MAKECMDGOALS))))
  SVC_CMD := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
  ifneq (,$(SVC_CMD))
    $(eval $(SVC_CMD):;@:)
  endif
endif
endif

.PHONY: install lint typecheck test format live sync full-sync register

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

# ── Service control (supervisor-managed FastAPI + corpus sync) ───────────────
# Actions:
#   (empty)  alias of `start`
#   start    start the FastAPI server via supervisor
#   stop     stop the server
#   status   supervisor status for program:live
#   reload   restart the server
#   logs     tail live.log
#   errlogs  tail live_error.log
#   sync     run corpus sync against GitHub (one-shot; --repo OWNER/NAME to scope)

live:
	$(ensure_hub)
	@_cmd="$(firstword $(SVC_CMD))"; \
	case "$$_cmd" in \
		sync)   uv run roxabi-corpus sync $(wordlist 2,$(words $(SVC_CMD)),$(SVC_CMD)) && uv run dep-graph-v5 --active graph ;; \
		status) $(HUB_SVC) live status || true ;; \
		"")     uv run roxabi-corpus sync && uv run dep-graph-v5 --active graph && $(HUB_SVC) live start ;; \
		*)      $(HUB_SVC) live $(SVC_CMD) ;; \
	esac

# Top-level `sync` target — needed so `make live sync` works from the hub
# root (hub dispatcher routes non-supervisor actions as standalone targets).
sync:                ## sync corpus with GitHub (alias for `make live sync`)
	uv run roxabi-corpus sync $(ARGS) && uv run dep-graph-v5 --active graph

full-sync:           ## full sync (clear sync_state, re-fetch all issues)
	sqlite3 $(HOME)/.roxabi/corpus.db "DELETE FROM sync_state"
	uv run roxabi-corpus sync && uv run dep-graph-v5 --active graph

# ── Registration ─────────────────────────────────────────────────────────────

register:            ## register roxabi-live with the supervisor hub
	@echo "Registering roxabi-live with supervisor hub at $(SUPERVISOR_HUB)..."
	@$(HUB_GEN_MK) roxabi-live "$(abspath .)" live
	$(call hub-link-conf,live,deploy/supervisor/conf.d/live.conf)
	@mkdir -p "$(HOME)/.local/state/roxabi-live/logs"
	$(hub_reread)
	@echo ""
	@echo "Done. Use: make live | make live sync | make live status | make live stop"
