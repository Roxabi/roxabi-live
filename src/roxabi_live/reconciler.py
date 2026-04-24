"""Corpus reconciler — periodic sync loop for roxabi_live.

Wraps the synchronous corpus.sync.run_sync in an async-friendly interface and
provides a long-running hourly loop suitable for background task execution.

Auth-halt behaviour: two consecutive GitHub 401/403 errors cause the loop to
exit permanently and emit a CRITICAL log.  Transient errors (OSError, non-auth
HTTP errors) do not increment the auth-failure counter.  A successful sync
resets the counter to zero.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from pathlib import Path

from roxabi_live.corpus import sync as corpus_sync

log = logging.getLogger(__name__)

_DEFAULT_INTERVAL = 3600.0
_DEFAULT_DB_PATH = Path.home() / ".roxabi" / "corpus.db"
_DEFAULT_ORG = "Roxabi"

_AUTH_FAILURE_THRESHOLD = 2
_auth_failures: int = 0
_halted: bool = False


def _db_path() -> Path:
    return Path(os.environ.get("CORPUS_DB_PATH", _DEFAULT_DB_PATH))


def _org() -> str:
    return os.environ.get("GITHUB_ORG", _DEFAULT_ORG)


def _is_auth_error(exc: BaseException) -> bool:
    """True when exc looks like a GitHub 401/403."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status in (401, 403):
        return True
    status = getattr(exc, "status", None)  # PyGithub GithubException
    return status in (401, 403)


async def run_once() -> None:
    """Run a single corpus sync cycle.

    Opens a fresh DB connection, calls corpus_sync.run_sync, then closes the
    connection.  All exceptions are caught and logged — this function never
    raises so that callers (e.g. hourly_loop) remain alive through transient
    failures.

    Auth-halt: two consecutive 401/403 errors set _halted=True and emit a
    CRITICAL log.  Transient errors (OSError, non-auth HTTP errors) do not
    increment the auth-failure counter.  A successful sync resets the counter.
    """
    global _auth_failures, _halted
    if _halted:
        return
    try:
        db = _db_path()
        org = _org()
        conn = sqlite3.connect(db)
        try:
            await asyncio.to_thread(corpus_sync.run_sync, conn, org)
        finally:
            conn.close()
        _auth_failures = 0
    except Exception as exc:
        if _is_auth_error(exc):
            _auth_failures += 1
            if _auth_failures >= _AUTH_FAILURE_THRESHOLD:
                _halted = True
                log.critical(
                    "reconciler halted: %d consecutive auth failures",
                    _auth_failures,
                )
                return
        log.exception("reconciler run_once failed")


def hourly_loop(interval_seconds: float | None = None) -> asyncio.Task[None]:
    """Start a background task that calls run_once on a fixed interval.

    Args:
        interval_seconds: Tick interval in seconds.  When *None* the value is
            read from the ``CORPUS_SYNC_INTERVAL_SECONDS`` environment variable,
            falling back to ``3600`` if the variable is unset or empty.

    Returns:
        The running :class:`asyncio.Task`.  Cancel it to stop the loop; the
        task will raise :exc:`asyncio.CancelledError` on await after
        cancellation.  The task may also exit normally if the reconciler is
        halted due to consecutive auth failures.
    """
    if interval_seconds is None:
        raw = os.environ.get("CORPUS_SYNC_INTERVAL_SECONDS", "")
        interval_seconds = float(raw) if raw else _DEFAULT_INTERVAL

    async def _loop() -> None:
        while not _halted:
            await asyncio.sleep(interval_seconds)  # type: ignore[arg-type]
            if _halted:
                break
            await run_once()
            if _halted:
                break

    return asyncio.create_task(_loop())
