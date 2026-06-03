"""Test that lifespan startup does NOT block on the reconciler corpus sync.

SC-89: run_once must be scheduled as a background task; if startup awaited it
directly, a slow/hanging sync would delay all traffic for up to ~16s per restart.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI

import roxabi_live.reconciler as rec_module
from roxabi_live.app import lifespan
from roxabi_live.corpus.schema import bootstrap


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "corpus.db"
    bootstrap(path)
    return path


@pytest.mark.asyncio
async def test_startup_does_not_block_on_run_once(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Lifespan startup completes without waiting for run_once to finish.

    Patches run_once with a coroutine that sets a "started" flag then blocks
    forever on an Event. If startup awaited run_once, the lifespan context
    manager would never yield and this test would hang (caught by the implicit
    asyncio timeout on the test runner).
    """
    monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "test-secret")

    sync_started = asyncio.Event()
    sync_proceed = asyncio.Event()

    async def _blocking_run_once(settings: object) -> None:
        sync_started.set()
        # Block until the test releases us so cleanup works cleanly.
        await sync_proceed.wait()

    monkeypatch.setattr(rec_module, "run_once", _blocking_run_once)

    test_app = FastAPI(lifespan=lifespan)

    try:
        async with lifespan(test_app):
            # If we reach here, startup did NOT block — the lifespan yielded
            # before _blocking_run_once finished (which it hasn't yet).

            # Deterministically wait for the background task to start — no
            # fixed sleep (flaky under load). If startup had awaited run_once
            # this point is never reached; the wait_for guards against a hang.
            await asyncio.wait_for(sync_started.wait(), timeout=5.0)
            assert sync_started.is_set(), (
                "run_once was never started — startup_sync task was not scheduled"
            )

            # The background task should be tracked in app.state.background_tasks.
            tracked = list(test_app.state.background_tasks)
            assert any(isinstance(t, asyncio.Task) for t in tracked), (
                "startup_sync task not found in app.state.background_tasks"
            )

            # Release the blocked coroutine before exiting lifespan so the
            # finally block can cancel+gather it cleanly.
            sync_proceed.set()
    finally:
        # Safety net: ensure the event is set so no dangling coroutine lingers.
        sync_proceed.set()
