"""Corpus reconciler — periodic sync loop for roxabi_live.

Wraps the synchronous corpus.sync.run_sync in an async-friendly interface and
provides a long-running hourly loop suitable for background task execution.

Auth-halt behaviour: two consecutive GitHub 401/403 errors cause the loop to
exit permanently and emit a CRITICAL log.  Transient errors (OSError, non-auth
HTTP errors) do not increment the auth-failure counter.  A successful sync
resets the counter to zero.

Also exposes TriggerHeal protocol and make_trigger_heal factory for DI into
the webhook router (decoupling the router from this module directly).
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import datetime, timezone
from typing import Protocol, cast
from weakref import WeakSet

import aiosqlite

from roxabi_live.config import Settings
from roxabi_live.corpus import sync as corpus_sync

log = logging.getLogger(__name__)


_AUTH_FAILURE_THRESHOLD = 2
_auth_failures: int = 0
_halted: asyncio.Event = asyncio.Event()
_state_lock: asyncio.Lock = asyncio.Lock()


class TriggerHeal(Protocol):
    """Protocol for the heal-trigger callable injected into the webhook router.

    Implementations check sync_state staleness for the given repo and, if
    stale, schedule a background corpus sync task.
    """

    async def __call__(self, repo: str, conn: aiosqlite.Connection) -> None: ...


def _log_exc(task: asyncio.Task[None]) -> None:
    """Done-callback: log any exception raised by a background task.

    The cancelled-guard is required because `Task.exception()` *raises*
    `CancelledError` on cancelled tasks (not returns it); without the
    guard, normal shutdown would propagate CancelledError into the
    callback and crash silently.
    """
    exc = task.exception() if not task.cancelled() else None
    if exc is not None:
        log.error("background heal task raised an exception", exc_info=exc)


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
    def _sync() -> dict[str, int]:
        conn = sqlite3.connect(settings.corpus_db_path)
        try:
            return corpus_sync.run_sync(conn, settings.github_org)
        finally:
            conn.close()

    try:
        await asyncio.to_thread(_sync)
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


def make_trigger_heal(
    settings: Settings,
    background_tasks: WeakSet[asyncio.Task[None]],
) -> TriggerHeal:
    """Factory: build a TriggerHeal closure capturing settings + the WeakSet.

    The returned callable:
    1. Checks sync_state staleness (>1h or missing) for the repo.
    2. If stale, schedules asyncio.create_task(run_once(settings)).
    3. Registers the task in background_tasks WeakSet.
    4. Attaches _log_exc as a done-callback to surface exceptions in logs.

    Args:
        settings: App settings (db path, org, interval).
        background_tasks: WeakSet owned by app.state; populated so lifespan
            can cancel all tracked tasks on shutdown.

    Returns:
        An async callable matching the TriggerHeal protocol.
    """

    async def _trigger_heal(repo: str, conn: aiosqlite.Connection) -> None:
        cur = await conn.execute(
            "SELECT last_synced_at FROM sync_state WHERE repo = ?", (repo,)
        )
        row = await cur.fetchone()
        now = datetime.now(timezone.utc)
        stale = True
        if row is not None:
            raw = row[0]
            last = datetime.fromisoformat(raw) if isinstance(raw, str) else raw
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            stale = (now - last).total_seconds() > settings.corpus_sync_interval_seconds
        if stale:
            task: asyncio.Task[None] = asyncio.create_task(run_once(settings))
            background_tasks.add(task)
            task.add_done_callback(_log_exc)

    return _trigger_heal  # type: ignore[return-value]
