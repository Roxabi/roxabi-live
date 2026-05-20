"""Tests for roxabi_live.reconciler — RED phase (module does not exist yet).

Covers:
- run_once(settings) exists, is async, calls corpus sync entrypoint
- run_once(settings) tolerates DB/network errors (catches and logs, does not raise)
- hourly_loop(settings) returns an asyncio.Task, ticks run_once at
  least twice within the configured interval, cancels cleanly
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests.exceptions

from roxabi_live import reconciler  # noqa: F401 — expected ImportError in RED phase
from roxabi_live.config import Settings


def _settings(tmp_path: Path | None = None) -> Settings:
    """Build a minimal Settings for tests."""
    db = tmp_path / "corpus.db" if tmp_path else Path("/tmp/corpus_test.db")
    return Settings(
        corpus_db_path=db,
        github_org="Roxabi",
        github_webhook_secret="",
        corpus_sync_interval_seconds=3600.0,
    )


def _make_http_error(status_code: int) -> requests.exceptions.HTTPError:
    """Build a requests.exceptions.HTTPError with a fake response."""
    exc = requests.exceptions.HTTPError("HTTP error")
    exc.response = MagicMock(status_code=status_code)
    return exc


def _success_dict() -> dict[str, int]:
    return {"repos": 1, "pages": 1, "issues": 10, "stubs": 0, "errors": 0}


class TestRunOnce:
    """reconciler.run_once(settings) — async, delegates to corpus sync."""

    @pytest.mark.asyncio
    async def test_run_once_is_coroutine(self) -> None:
        """run_once must be an async function (awaitable)."""
        # Arrange
        s = _settings()
        with patch(
            "roxabi_live.corpus.sync.run_sync",
            new_callable=MagicMock,
            return_value={
                "repos": 1,
                "pages": 1,
                "issues": 10,
                "stubs": 0,
                "errors": 0,
            },
        ):
            # Act
            coro = reconciler.run_once(s)
            # Assert — must be a coroutine, not a plain return value
            assert asyncio.iscoroutine(coro), "run_once() must return a coroutine"
            await coro

    @pytest.mark.asyncio
    async def test_run_once_calls_corpus_sync(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """run_once must call roxabi_live.corpus.sync.run_sync exactly once."""
        s = _settings(tmp_path)
        mock_run_sync = MagicMock(
            return_value={"repos": 2, "pages": 3, "issues": 42, "stubs": 1, "errors": 0}
        )
        with patch("roxabi_live.corpus.sync.run_sync", mock_run_sync):
            await reconciler.run_once(s)
        mock_run_sync.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_once_tolerates_exception_does_not_raise(self) -> None:
        """run_once must catch DB/network errors and not propagate them."""
        s = _settings()
        with patch(
            "roxabi_live.corpus.sync.run_sync",
            side_effect=OSError("corpus.db: no such file"),
        ):
            await reconciler.run_once(s)

    @pytest.mark.asyncio
    async def test_run_once_tolerates_graphql_error_does_not_raise(self) -> None:
        """run_once must catch GraphQL/network errors and not propagate them."""
        from roxabi_live.corpus.graphql import GraphQLError

        s = _settings()
        with patch(
            "roxabi_live.corpus.sync.run_sync",
            side_effect=GraphQLError("rate limit exceeded"),
        ):
            await reconciler.run_once(s)

    @pytest.mark.asyncio
    async def test_run_once_logs_on_error(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """run_once must log at ERROR level when an error is caught."""
        s = _settings()
        with caplog.at_level(logging.ERROR, logger="roxabi_live.reconciler"):
            with patch(
                "roxabi_live.corpus.sync.run_sync",
                side_effect=RuntimeError("unexpected failure"),
            ):
                await reconciler.run_once(s)
        assert any(rec.levelno == logging.ERROR for rec in caplog.records)


class TestHourlyLoop:
    """hourly_loop(settings) returns an asyncio.Task that ticks run_once."""

    @pytest.mark.asyncio
    async def test_hourly_loop_returns_task(self) -> None:
        """hourly_loop must return an asyncio.Task immediately (non-blocking)."""
        call_count = 0

        async def fake_run_once(s: Settings) -> None:
            nonlocal call_count
            call_count += 1

        s = Settings(
            corpus_db_path=Path("/tmp/test.db"),
            github_org="Roxabi",
            github_webhook_secret="",
            corpus_sync_interval_seconds=0.05,
        )
        with patch.object(reconciler, "run_once", fake_run_once):
            task = reconciler.hourly_loop(s)
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
        call_count = 0

        async def fake_run_once(s: Settings) -> None:
            nonlocal call_count
            call_count += 1

        s = Settings(
            corpus_db_path=Path("/tmp/test.db"),
            github_org="Roxabi",
            github_webhook_secret="",
            corpus_sync_interval_seconds=0.05,
        )
        with patch.object(reconciler, "run_once", fake_run_once):
            task = reconciler.hourly_loop(s)
            await asyncio.sleep(0.15)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        assert call_count >= 2, (
            f"Expected run_once to be called at least 2 times, got {call_count}"
        )

    @pytest.mark.asyncio
    async def test_hourly_loop_cancels_cleanly(self) -> None:
        """Cancelling the task returned by hourly_loop must not raise unhandled
        exceptions."""

        # Arrange
        async def fake_run_once(s: Settings) -> None:
            pass

        s = Settings(
            corpus_db_path=Path("/tmp/test.db"),
            github_org="Roxabi",
            github_webhook_secret="",
            corpus_sync_interval_seconds=0.05,
        )
        with patch.object(reconciler, "run_once", fake_run_once):
            task = reconciler.hourly_loop(s)
            await asyncio.sleep(0.02)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    @pytest.mark.asyncio
    async def test_hourly_loop_uses_settings_interval(self) -> None:
        """hourly_loop uses the interval from Settings."""
        call_count = 0

        async def fake_run_once(s: Settings) -> None:
            nonlocal call_count
            call_count += 1

        s = Settings(
            corpus_db_path=Path("/tmp/test.db"),
            github_org="Roxabi",
            github_webhook_secret="",
            corpus_sync_interval_seconds=0.05,
        )
        with patch.object(reconciler, "run_once", fake_run_once):
            task = reconciler.hourly_loop(s)
            await asyncio.sleep(0.15)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        assert call_count >= 2, (
            f"hourly_loop should use settings interval; got {call_count} calls"
        )


class TestAuthHalt:
    """reconciler.hourly_loop() — auth-aware halt on consecutive 401/403 errors."""

    @pytest.mark.asyncio
    async def test_two_consecutive_auth_errors_halt_loop(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Two consecutive 401 errors from run_sync must exit hourly_loop and emit
        a CRITICAL log mentioning 'halt' or 'auth'."""
        # Arrange
        monkeypatch.setenv("CORPUS_DB_PATH", str(tmp_path / "corpus.db"))
        err_401 = _make_http_error(401)
        with caplog.at_level(logging.CRITICAL, logger="roxabi_live.reconciler"):
            with patch(
                "roxabi_live.corpus.sync.run_sync",
                side_effect=[err_401, err_401],
            ):
                # Act — hourly_loop should exit on its own (not require cancellation)
                task = reconciler.hourly_loop(
                    Settings(
                        corpus_db_path=tmp_path / "corpus.db",
                        github_org="Roxabi",
                        github_webhook_secret="",
                        corpus_sync_interval_seconds=0.01,
                    )
                )
                await asyncio.wait_for(task, timeout=1.0)

        # Assert — task completed without TimeoutError/CancelledError
        assert task.done() and not task.cancelled()
        critical_records = [
            r
            for r in caplog.records
            if r.levelno == logging.CRITICAL
            and r.name == "roxabi_live.reconciler"
            and ("halt" in r.message.lower() or "auth" in r.message.lower())
        ]
        assert critical_records, (
            "Expected a CRITICAL log mentioning 'halt' or 'auth' on "
            f"roxabi_live.reconciler; got records: {caplog.records}"
        )

    @pytest.mark.asyncio
    async def test_single_auth_error_then_success_resets_counter(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A single 401 followed by successful syncs must reset _auth_failures to 0
        and keep _halted False."""
        # Arrange
        monkeypatch.setenv("CORPUS_DB_PATH", str(tmp_path / "corpus.db"))
        err_401 = _make_http_error(401)
        with patch(
            "roxabi_live.corpus.sync.run_sync",
            side_effect=[err_401, _success_dict(), _success_dict()],
        ):
            # Act — allow a few ticks
            task = reconciler.hourly_loop(
                Settings(
                    corpus_db_path=tmp_path / "corpus.db",
                    github_org="Roxabi",
                    github_webhook_secret="",
                    corpus_sync_interval_seconds=0.01,
                )
            )
            await asyncio.sleep(0.08)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        # Assert — counter reset, loop not halted
        failures = reconciler._auth_failures  # type: ignore[attr-defined]
        assert failures == 0, (
            f"Expected _auth_failures == 0 after success, got {failures}"
        )
        assert not reconciler._halted.is_set()  # type: ignore[attr-defined]

    @pytest.mark.asyncio
    async def test_transient_oserror_does_not_increment_counter(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Transient OSErrors must NOT increment _auth_failures and must NOT halt
        the loop."""
        # Arrange
        monkeypatch.setenv("CORPUS_DB_PATH", str(tmp_path / "corpus.db"))
        with patch(
            "roxabi_live.corpus.sync.run_sync",
            side_effect=[OSError("connection reset"), OSError("connection reset")],
        ):
            # Act — allow two ticks
            task = reconciler.hourly_loop(
                Settings(
                    corpus_db_path=tmp_path / "corpus.db",
                    github_org="Roxabi",
                    github_webhook_secret="",
                    corpus_sync_interval_seconds=0.01,
                )
            )
            await asyncio.sleep(0.05)

        # Assert — counter untouched, loop still running
        assert reconciler._auth_failures == 0  # type: ignore[attr-defined]
        assert not reconciler._halted.is_set()  # type: ignore[attr-defined]
        assert not task.done(), "Loop must still be running after transient OSErrors"

        # Cleanup
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    @pytest.mark.asyncio
    async def test_403_also_counts_as_auth(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Two consecutive 403 errors must halt the loop the same way as 401s."""
        # Arrange
        monkeypatch.setenv("CORPUS_DB_PATH", str(tmp_path / "corpus.db"))
        err_403 = _make_http_error(403)
        with caplog.at_level(logging.CRITICAL, logger="roxabi_live.reconciler"):
            with patch(
                "roxabi_live.corpus.sync.run_sync",
                side_effect=[err_403, err_403],
            ):
                # Act
                task = reconciler.hourly_loop(
                    Settings(
                        corpus_db_path=tmp_path / "corpus.db",
                        github_org="Roxabi",
                        github_webhook_secret="",
                        corpus_sync_interval_seconds=0.01,
                    )
                )
                await asyncio.wait_for(task, timeout=1.0)

        # Assert — same halt behaviour as 401
        assert task.done() and not task.cancelled()
        critical_records = [
            r
            for r in caplog.records
            if r.levelno == logging.CRITICAL
            and r.name == "roxabi_live.reconciler"
            and ("halt" in r.message.lower() or "auth" in r.message.lower())
        ]
        assert critical_records, (
            "Expected a CRITICAL log mentioning 'halt' or 'auth' for 403 errors; "
            f"got records: {caplog.records}"
        )


class TestRunRepoOnce:
    """reconciler.run_repo_once(settings, repo) — single-repo webhook-driven heal."""

    @pytest.mark.asyncio
    async def test_happy_path_calls_run_single_repo_sync(self, tmp_path: Path) -> None:
        """run_repo_once calls corpus_sync.run_single_repo_sync exactly once."""
        s = _settings(tmp_path)
        mock_fn = MagicMock(return_value={"pages": 1, "issues": 5})
        with patch("roxabi_live.corpus.sync.run_single_repo_sync", mock_fn):
            await reconciler.run_repo_once(s, "Roxabi/lyra")
        mock_fn.assert_called_once()
        args = mock_fn.call_args
        # second positional arg is repo
        assert args[0][1] == "Roxabi/lyra"

    @pytest.mark.asyncio
    async def test_auth_halt_after_two_consecutive_errors(
        self,
        tmp_path: Path,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Two consecutive 401 errors via run_repo_once must set _halted and emit
        CRITICAL."""
        s = _settings(tmp_path)
        err_401 = _make_http_error(401)
        with caplog.at_level(logging.CRITICAL, logger="roxabi_live.reconciler"):
            with patch(
                "roxabi_live.corpus.sync.run_single_repo_sync",
                side_effect=err_401,
            ):
                await reconciler.run_repo_once(s, "Roxabi/lyra")
                await reconciler.run_repo_once(s, "Roxabi/lyra")

        assert reconciler._halted.is_set()  # type: ignore[attr-defined]
        critical_records = [
            r
            for r in caplog.records
            if r.levelno == logging.CRITICAL
            and ("halt" in r.message.lower() or "auth" in r.message.lower())
        ]
        assert critical_records, f"Expected CRITICAL log; got: {caplog.records}"

    @pytest.mark.asyncio
    async def test_success_resets_auth_failures(self, tmp_path: Path) -> None:
        """A successful run_repo_once resets _auth_failures to 0."""
        s = _settings(tmp_path)
        err_401 = _make_http_error(401)
        # One failure then success
        with patch(
            "roxabi_live.corpus.sync.run_single_repo_sync",
            side_effect=[err_401, {"pages": 1, "issues": 3}],
        ):
            await reconciler.run_repo_once(s, "Roxabi/lyra")
            await reconciler.run_repo_once(s, "Roxabi/lyra")

        assert reconciler._auth_failures == 0  # type: ignore[attr-defined]
        assert not reconciler._halted.is_set()  # type: ignore[attr-defined]
