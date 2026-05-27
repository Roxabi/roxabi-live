"""Tests for task tracking + lifespan shutdown — T13 [RED].

Covers SC14 (heal task exception logged via done_callback) and
SC15 (shutdown cancels sleeping heal task within 1s).
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from weakref import WeakSet

import pytest

from roxabi_live.config import Settings
from roxabi_live.reconciler import make_trigger_heal

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _settings(tmp_path: Path | None = None) -> Settings:
    db = tmp_path / "corpus.db" if tmp_path else Path("/tmp/corpus_lifecycle.db")
    return Settings(
        corpus_db_path=db,
        github_org="Roxabi",
        github_webhook_secret="",
        corpus_sync_interval_seconds=3600.0,
    )


# Minimal in-memory sync_state table for trigger_heal to query
_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS sync_state (
    repo            TEXT PRIMARY KEY,
    last_cursor     TEXT,
    last_synced_at  TEXT
);
"""


# ---------------------------------------------------------------------------
# SC14 — exception in heal task is logged via done_callback
# ---------------------------------------------------------------------------


class TestHealTaskExceptionLogged:
    """make_trigger_heal schedules tasks; done_callback logs exceptions (SC14)."""

    @pytest.mark.asyncio
    async def test_heal_task_exception_captured_in_logs(
        self, caplog: pytest.LogCaptureFixture, tmp_path: Path
    ) -> None:
        """A heal task that raises an exception has it captured by the done_callback.

        The exception must appear in caplog at ERROR level (not silently dropped).
        """
        import aiosqlite

        s = _settings(tmp_path)
        bg_tasks: WeakSet[asyncio.Task[None]] = WeakSet()
        trigger_heal = make_trigger_heal(s, bg_tasks)

        # Monkey-patch run_repo_once to raise inside the scheduled task
        import roxabi_live.reconciler as rec_module

        original_run_repo_once = rec_module.run_repo_once

        async def _bad_run_repo_once(settings: Settings, repo: str) -> None:
            raise RuntimeError("heal task blew up")

        rec_module.run_repo_once = _bad_run_repo_once  # type: ignore[assignment]

        try:
            async with aiosqlite.connect(":memory:") as conn:
                await conn.executescript(_SCHEMA_SQL)
                # No sync_state row → stale → heal scheduled
                with caplog.at_level(logging.ERROR, logger="roxabi_live.reconciler"):
                    await trigger_heal("Roxabi/lyra", conn)
                    # Let the event loop run the task to completion
                    await asyncio.sleep(0.05)
        finally:
            rec_module.run_repo_once = original_run_repo_once  # type: ignore[assignment]

        error_records = [
            r
            for r in caplog.records
            if r.levelno >= logging.ERROR and "heal task" in r.getMessage().lower()
        ]
        assert error_records, (
            f"Expected an ERROR log for heal task exception. Records: {caplog.records}"
        )

    @pytest.mark.asyncio
    async def test_task_registered_in_weakset(self, tmp_path: Path) -> None:
        """make_trigger_heal adds the scheduled task to background_tasks WeakSet."""
        from unittest.mock import AsyncMock, patch

        import aiosqlite

        s = _settings(tmp_path)
        bg_tasks: WeakSet[asyncio.Task[None]] = WeakSet()
        trigger_heal = make_trigger_heal(s, bg_tasks)

        with patch(
            "roxabi_live.reconciler.run_repo_once", AsyncMock(return_value=None)
        ):
            async with aiosqlite.connect(":memory:") as conn:
                await conn.executescript(_SCHEMA_SQL)
                # No sync_state row → stale → task created
                await trigger_heal("Roxabi/lyra", conn)

                tasks = list(bg_tasks)
                assert len(tasks) >= 1, (
                    "Expected at least one task in background_tasks WeakSet"
                )
                assert all(isinstance(t, asyncio.Task) for t in tasks)
                # Drain
                await asyncio.gather(*tasks, return_exceptions=True)


# ---------------------------------------------------------------------------
# SC15 — lifespan shutdown cancels sleeping heal task within 1s
# ---------------------------------------------------------------------------


class TestLifespanShutdownCancelsHealTasks:
    """app.py lifespan exit cancels all background_tasks and awaits them (SC15)."""

    @pytest.mark.asyncio
    async def test_sleeping_heal_task_cancelled_on_shutdown(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Lifespan shutdown with one sleeping heal task completes within 1s.

        Verifies SC15: no 'Task was destroyed but it is pending' warning.
        """
        import warnings

        db_path = tmp_path / "corpus.db"
        monkeypatch.setenv("CORPUS_DB_PATH", str(db_path))
        monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "secret")

        # Create a DB with the minimal schema so bootstrap works
        from roxabi_live.corpus.schema import bootstrap

        bootstrap(db_path)

        long_running_task_started = asyncio.Event()

        async def _long_running(settings: Settings) -> None:
            long_running_task_started.set()
            await asyncio.sleep(60)  # much longer than 1s timeout

        # Patch run_once at the module level before app is loaded
        import roxabi_live.reconciler as rec_module

        original = rec_module.run_once

        async def _fast_run_once(settings: Settings) -> None:
            pass  # startup call: fast

        rec_module.run_once = _fast_run_once  # type: ignore[assignment]

        try:
            import time

            from fastapi import FastAPI

            from roxabi_live.app import lifespan

            test_app = FastAPI(lifespan=lifespan)

            # Run lifespan startup
            shutdown_start: float = 0.0
            shutdown_elapsed: float = 0.0
            try:
                async with lifespan(test_app):
                    # Now switch run_once to the long-running version so
                    # the next trigger_heal call spawns a long task
                    rec_module.run_once = _long_running  # type: ignore[assignment]

                    # Manually inject a sleeping task into background_tasks
                    async def _sleeping() -> None:
                        await asyncio.sleep(60)

                    task: asyncio.Task[None] = asyncio.create_task(_sleeping())
                    test_app.state.background_tasks.add(task)
                    shutdown_start = time.monotonic()
            finally:
                shutdown_elapsed = time.monotonic() - shutdown_start

            # SC15: lifespan exit must cancel the sleeping task in <1s
            assert shutdown_elapsed < 1.0, (
                f"Lifespan shutdown took {shutdown_elapsed:.2f}s; SC15 budget is 1s"
            )
            # Task must be done (cancelled) — not still pending
            assert task.done(), "Expected heal task to be done after lifespan shutdown"
            assert task.cancelled(), (
                "Expected heal task to be cancelled, not completed normally"
            )

            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always")
                del task
                # Give GC a chance
                await asyncio.sleep(0)
            pending_warnings = [
                x for x in w if "Task was destroyed but it is pending" in str(x.message)
            ]
            assert not pending_warnings, (
                f"Pending task warning on shutdown: {pending_warnings}"
            )
        finally:
            rec_module.run_once = original  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Dedup / single-repo path / flag-cleared-after
# ---------------------------------------------------------------------------


class TestTriggerHealDedup:
    """make_trigger_heal schedules at most one task when _sync_in_flight is True."""

    @pytest.mark.asyncio
    async def test_dedup_concurrent_triggers(self, tmp_path: Path) -> None:
        """Two concurrent stale trigger_heal calls only schedule ONE task."""
        from unittest.mock import patch

        import aiosqlite

        import roxabi_live.reconciler as rec_module

        s = _settings(tmp_path)
        bg_tasks: WeakSet[asyncio.Task[None]] = WeakSet()
        trigger_heal = make_trigger_heal(s, bg_tasks)

        call_count = 0

        async def slow_run_repo_once(settings: Settings, repo: str) -> None:
            nonlocal call_count
            call_count += 1
            await asyncio.sleep(0.05)  # hold the in-flight flag

        with patch.object(rec_module, "run_repo_once", slow_run_repo_once):
            async with aiosqlite.connect(":memory:") as conn:
                await conn.executescript(_SCHEMA_SQL)
                # No sync_state row → both calls see stale state
                await asyncio.gather(
                    trigger_heal("Roxabi/foo", conn),
                    trigger_heal("Roxabi/foo", conn),
                )
                # Drain tasks
                tasks = list(bg_tasks)
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)

        assert call_count == 1, (
            f"Expected exactly 1 run_repo_once call (dedup); got {call_count}"
        )

    @pytest.mark.asyncio
    async def test_single_repo_path_not_run_once(self, tmp_path: Path) -> None:
        """trigger_heal schedules run_repo_once, NOT run_once."""
        from unittest.mock import AsyncMock, patch

        import aiosqlite

        import roxabi_live.reconciler as rec_module

        s = _settings(tmp_path)
        bg_tasks: WeakSet[asyncio.Task[None]] = WeakSet()
        trigger_heal = make_trigger_heal(s, bg_tasks)

        run_once_mock = AsyncMock()
        run_repo_once_mock = AsyncMock()

        with (
            patch.object(rec_module, "run_once", run_once_mock),
            patch.object(rec_module, "run_repo_once", run_repo_once_mock),
        ):
            async with aiosqlite.connect(":memory:") as conn:
                await conn.executescript(_SCHEMA_SQL)
                await trigger_heal("Roxabi/lyra", conn)
                tasks = list(bg_tasks)
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)

        run_once_mock.assert_not_called()
        run_repo_once_mock.assert_called_once()

    @pytest.mark.asyncio
    async def test_flag_cleared_after_task_completes(self, tmp_path: Path) -> None:
        """After the heal task finishes, _sync_in_flight is False so a new stale trigger
        can spawn a fresh task."""
        from unittest.mock import patch

        import aiosqlite

        import roxabi_live.reconciler as rec_module

        s = _settings(tmp_path)
        bg_tasks: WeakSet[asyncio.Task[None]] = WeakSet()
        trigger_heal = make_trigger_heal(s, bg_tasks)

        call_count = 0

        async def counting_run_repo_once(settings: Settings, repo: str) -> None:
            nonlocal call_count
            call_count += 1

        with patch.object(rec_module, "run_repo_once", counting_run_repo_once):
            async with aiosqlite.connect(":memory:") as conn:
                await conn.executescript(_SCHEMA_SQL)
                # First trigger
                await trigger_heal("Roxabi/lyra", conn)
                tasks = list(bg_tasks)
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)

                # Flag must be cleared now
                assert not rec_module._sync_in_flight  # type: ignore[attr-defined]

                # Second trigger on still-stale state should spawn a new task
                await trigger_heal("Roxabi/lyra", conn)
                tasks2 = list(bg_tasks)
                if tasks2:
                    await asyncio.gather(*tasks2, return_exceptions=True)

        assert call_count == 2, (
            f"Expected 2 run_repo_once calls (flag cleared between); got {call_count}"
        )
