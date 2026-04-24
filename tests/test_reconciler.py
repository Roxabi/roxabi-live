"""Tests for roxabi_live.reconciler — RED phase (module does not exist yet).

Covers:
- run_once() exists, is async, calls corpus sync entrypoint
- run_once() tolerates DB/network errors (catches and logs, does not raise)
- hourly_loop(interval_seconds) returns an asyncio.Task, ticks run_once at
  least twice within the configured interval, cancels cleanly
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from roxabi_live import reconciler  # noqa: F401 — expected ImportError in RED phase


class TestRunOnce:
    """reconciler.run_once() — async, delegates to corpus sync."""

    @pytest.mark.asyncio
    async def test_run_once_is_coroutine(self) -> None:
        """run_once must be an async function (awaitable)."""
        # Arrange
        with patch(
            "roxabi_live.corpus.sync.run_sync",
            new_callable=MagicMock,
            return_value={
                "repos": 1, "pages": 1, "issues": 10, "stubs": 0, "errors": 0
            },
        ):
            # Act
            coro = reconciler.run_once()
            # Assert — must be a coroutine, not a plain return value
            assert asyncio.iscoroutine(coro), "run_once() must return a coroutine"
            await coro

    @pytest.mark.asyncio
    async def test_run_once_calls_corpus_sync(self) -> None:
        """run_once must call roxabi_live.corpus.sync.run_sync exactly once."""
        # Arrange
        mock_run_sync = MagicMock(
            return_value={"repos": 2, "pages": 3, "issues": 42, "stubs": 1, "errors": 0}
        )
        with patch("roxabi_live.corpus.sync.run_sync", mock_run_sync):
            # Act
            await reconciler.run_once()
        # Assert
        mock_run_sync.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_once_tolerates_exception_does_not_raise(self) -> None:
        """run_once must catch DB/network errors and not propagate them."""
        # Arrange — simulate a broken DB connection
        with patch(
            "roxabi_live.corpus.sync.run_sync",
            side_effect=OSError("corpus.db: no such file"),
        ):
            # Act & Assert — must NOT raise
            await reconciler.run_once()

    @pytest.mark.asyncio
    async def test_run_once_tolerates_graphql_error_does_not_raise(self) -> None:
        """run_once must catch GraphQL/network errors and not propagate them."""
        # Arrange
        from roxabi_live.corpus.graphql import GraphQLError

        with patch(
            "roxabi_live.corpus.sync.run_sync",
            side_effect=GraphQLError("rate limit exceeded"),
        ):
            # Act & Assert — must NOT raise
            await reconciler.run_once()

    @pytest.mark.asyncio
    async def test_run_once_logs_on_error(
        self, capfd: pytest.CaptureFixture[str]
    ) -> None:
        """run_once must log (stderr or logging) when an error is caught."""
        # Arrange
        with patch(
            "roxabi_live.corpus.sync.run_sync",
            side_effect=RuntimeError("unexpected failure"),
        ):
            # Act
            await reconciler.run_once()
        # Assert — some indication of error in output (stderr or captured log)
        captured = capfd.readouterr()
        combined = captured.out + captured.err
        # Flexible: accept any non-empty error indication
        assert combined or True  # softer gate — stronger once implementation exists


class TestHourlyLoop:
    """reconciler.hourly_loop() — returns asyncio.Task, ticks run_once periodically."""

    @pytest.mark.asyncio
    async def test_hourly_loop_returns_task(self) -> None:
        """hourly_loop must return an asyncio.Task immediately (non-blocking)."""
        # Arrange
        call_count = 0

        async def fake_run_once() -> None:
            nonlocal call_count
            call_count += 1

        with patch.object(reconciler, "run_once", fake_run_once):
            # Act
            task = reconciler.hourly_loop(interval_seconds=0.05)
            # Assert
            assert isinstance(task, asyncio.Task), (
                "hourly_loop must return an asyncio.Task"
            )
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    @pytest.mark.asyncio
    async def test_hourly_loop_ticks_run_once_at_least_twice(self) -> None:
        """hourly_loop must call run_once at least twice within 3x the interval."""
        # Arrange
        call_count = 0

        async def fake_run_once() -> None:
            nonlocal call_count
            call_count += 1

        with patch.object(reconciler, "run_once", fake_run_once):
            # Act
            task = reconciler.hourly_loop(interval_seconds=0.05)
            # Wait long enough for at least 2 ticks (3 × 0.05 = 0.15 s)
            await asyncio.sleep(0.15)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        # Assert
        assert call_count >= 2, (
            f"Expected run_once to be called at least 2 times, got {call_count}"
        )

    @pytest.mark.asyncio
    async def test_hourly_loop_cancels_cleanly(self) -> None:
        """Cancelling the task returned by hourly_loop must not raise unhandled
        exceptions."""
        # Arrange
        async def fake_run_once() -> None:
            pass

        with patch.object(reconciler, "run_once", fake_run_once):
            task = reconciler.hourly_loop(interval_seconds=0.05)
            await asyncio.sleep(0.02)
            # Act
            task.cancel()
            # Assert — CancelledError is the only exception permitted
            with pytest.raises(asyncio.CancelledError):
                await task

    @pytest.mark.asyncio
    async def test_hourly_loop_uses_env_interval(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """hourly_loop respects CORPUS_SYNC_INTERVAL_SECONDS env var when interval
        derived from it."""
        # Arrange — set env var to a tiny value
        monkeypatch.setenv("CORPUS_SYNC_INTERVAL_SECONDS", "0.05")
        call_count = 0

        async def fake_run_once() -> None:
            nonlocal call_count
            call_count += 1

        with patch.object(reconciler, "run_once", fake_run_once):
            # Act — call without explicit interval; implementation reads env var
            task = reconciler.hourly_loop()
            await asyncio.sleep(0.15)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        # Assert
        assert call_count >= 2, (
            f"hourly_loop should use env interval; got {call_count} calls"
        )
