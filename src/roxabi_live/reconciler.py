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
import sqlite3
from typing import cast

from roxabi_live.config import Settings
from roxabi_live.corpus import sync as corpus_sync

log = logging.getLogger(__name__)


_AUTH_FAILURE_THRESHOLD = 2
_auth_failures: int = 0
_halted: asyncio.Event = asyncio.Event()
_state_lock: asyncio.Lock = asyncio.Lock()


def _is_auth_error(exc: BaseException) -> bool:
    """True when exc looks like a GitHub 401/403 credential failure.

    Excludes GitHub secondary rate-limit 403s (self-resolving, not an auth
    problem) by inspecting the response body / PyGithub exception data.
    """
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(exc, "status", None)
    if status not in (401, 403):
        return False
    # 403 may be rate limit — check body
    if status == 403:
        text = ""
        if response is not None:
            text = getattr(response, "text", "") or ""
        data: object = getattr(exc, "data", None)
        if isinstance(data, dict):
            typed_data = cast("dict[str, object]", data)
            msg = typed_data.get("message", "")
            text += " " + (str(msg) if msg is not None else "")
        if "secondary rate limit" in text.lower() or "rate limit" in text.lower():
            return False
    return True


async def run_once(settings: Settings) -> None:
    """Run a single corpus sync cycle.

    Opens a fresh DB connection, calls corpus_sync.run_sync, then closes the
    connection.  All exceptions are caught and logged — this function never
    raises so that callers (e.g. hourly_loop) remain alive through transient
    failures.

    Auth-halt: two consecutive 401/403 errors set _halted and emit a
    CRITICAL log.  Transient errors (OSError, non-auth HTTP errors) do not
    increment the auth-failure counter.  A successful sync resets the counter.
    """
    global _auth_failures
    if _halted.is_set():
        return
    try:
        conn = sqlite3.connect(settings.corpus_db_path)
        try:
            await asyncio.to_thread(corpus_sync.run_sync, conn, settings.github_org)
        finally:
            conn.close()
        async with _state_lock:
            _auth_failures = 0
    except Exception as exc:
        if _is_auth_error(exc):
            async with _state_lock:
                _auth_failures += 1
                should_halt = _auth_failures >= _AUTH_FAILURE_THRESHOLD
                failures = _auth_failures
            if should_halt and not _halted.is_set():
                _halted.set()
                log.critical(
                    "reconciler halted: %d consecutive auth failures",
                    failures,
                )
            else:
                log.warning(
                    "reconciler auth error %d/%d",
                    failures,
                    _AUTH_FAILURE_THRESHOLD,
                )
            return
        log.exception("reconciler run_once failed")


def hourly_loop(settings: Settings) -> asyncio.Task[None]:
    """Start a background task that calls run_once on a fixed interval.

    Args:
        settings: Application settings providing the sync interval.

    Returns:
        The running :class:`asyncio.Task`.  Cancel it to stop the loop; the
        task will raise :exc:`asyncio.CancelledError` on await after
        cancellation.  The task may also exit normally if the reconciler is
        halted due to consecutive auth failures.
    """
    interval_seconds = settings.corpus_sync_interval_seconds

    async def _loop() -> None:
        while not _halted.is_set():
            await asyncio.sleep(interval_seconds)
            if _halted.is_set():
                break
            await run_once(settings)

    return asyncio.create_task(_loop())
