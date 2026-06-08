"""FastAPI application factory."""

import asyncio
import logging
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator
from weakref import WeakSet

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from roxabi_live import reconciler
from roxabi_live.api.issues import router as issues_router
from roxabi_live.config import Settings, get_settings
from roxabi_live.corpus import schema as corpus_schema
from roxabi_live.dep_graph.v5.serve import router as dep_graph_v5_router
from roxabi_live.dep_graph.v6.repos import router as repos_router
from roxabi_live.dep_graph.v6.routes import router as dep_graph_v6_router
from roxabi_live.webhook.router import router as webhook_router

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    settings = Settings.from_env()
    app.state.settings = settings
    if not settings.github_webhook_secret:
        log.critical(
            "GITHUB_WEBHOOK_SECRET is empty — /webhook/github will return 503 "
            "for every request. Set the env var to enable webhook ingestion."
        )
    bg_tasks: WeakSet[asyncio.Task[None]] = WeakSet()
    app.state.background_tasks = bg_tasks
    app.state.trigger_heal = reconciler.make_trigger_heal(settings, bg_tasks)

    # Apply pending schema migrations before accepting traffic so endpoints
    # never observe a half-migrated DB.
    corpus_schema.bootstrap(settings.corpus_db_path)

    # Schedule startup sync as a background task so lifespan returns immediately.
    # corpus.db is persistent — endpoints serve existing data while the sync
    # refreshes it in the background. No HTTP 502 window on restart.
    startup_sync: asyncio.Task[None] = asyncio.create_task(
        reconciler.run_once(settings)
    )
    # _log_exc is a no-op while run_once swallows its own exceptions, but kept
    # for parity with the heal tasks and to stay correct if that ever changes.
    startup_sync.add_done_callback(reconciler._log_exc)
    # WeakSet is safe here: the event loop holds a strong ref for the task's
    # lifetime; the finally block cancels + gathers it on shutdown.
    bg_tasks.add(startup_sync)
    log.info("reconciler startup sync scheduled (background)")
    loop_task = reconciler.hourly_loop(settings)
    try:
        yield
    finally:
        loop_task.cancel()
        try:
            await loop_task
        except asyncio.CancelledError:
            pass
        # Cancel and await all tracked background heal tasks
        tasks = list(app.state.background_tasks)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="Roxabi Live", version="0.1.0", lifespan=lifespan)

# Compress large JSON responses (e.g. /api/graph ~1.3 MB). compresslevel
# pinned explicitly so the intent survives any future Starlette default change.
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=9)

app.include_router(issues_router)
app.include_router(dep_graph_v6_router)
app.include_router(repos_router)
app.include_router(dep_graph_v5_router)
app.include_router(webhook_router)

_FE = Path(__file__).parent / "dep_graph" / "v6" / "frontend"
app.mount("/v6", StaticFiles(directory=_FE, html=True), name="v6")


@app.get("/", include_in_schema=False)
async def _root() -> RedirectResponse:
    return RedirectResponse(url="/v6/")


@app.get("/api/version")
async def api_version(request: Request) -> dict[str, str]:
    """Cheap change-detection token for the frontend poller.

    Returns the max mtime (ns) across corpus.db and its WAL/SHM sidecars.
    In WAL mode writes land in `-wal` first and only reach the main file on
    checkpoint, so polling all three catches every mutation — webhook AND
    reconciler — without touching SQLite.
    """
    db = get_settings(request).corpus_db_path
    latest = 0
    for path in (
        db,
        db.with_suffix(db.suffix + "-wal"),
        db.with_suffix(db.suffix + "-shm"),
    ):
        try:
            mtime = path.stat().st_mtime_ns
        except OSError:
            continue
        latest = max(latest, mtime)
    return {"version": str(latest)}


@app.get("/health")
async def health(request: Request) -> dict[str, Any]:
    """Health check — returns db path, reachability, and issue count."""
    db = get_settings(request).corpus_db_path
    db_reachable = False
    issue_count = 0
    try:
        conn = sqlite3.connect(db)
        try:
            row = conn.execute("SELECT COUNT(*) FROM issues").fetchone()
            issue_count = row[0]
            db_reachable = True
        except sqlite3.OperationalError:
            pass
        finally:
            conn.close()
    except Exception:
        pass
    return {
        "status": "ok",
        "db": str(db),
        "db_reachable": db_reachable,
        "issue_count": issue_count,
    }
