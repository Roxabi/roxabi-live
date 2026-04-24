"""FastAPI application factory."""

import asyncio
import logging
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from roxabi_live import reconciler
from roxabi_live.api.issues import router as issues_router
from roxabi_live.config import Settings
from roxabi_live.dep_graph.v5.serve import router as dep_graph_v5_router
from roxabi_live.dep_graph.v6.repos import router as repos_router
from roxabi_live.dep_graph.v6.routes import router as dep_graph_v6_router
from roxabi_live.webhook.router import router as webhook_router

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    settings = Settings.from_env()
    app.state.settings = settings

    log.info("reconciler startup sync scheduled")
    await reconciler.run_once(settings)
    loop_task = reconciler.hourly_loop(settings)
    try:
        yield
    finally:
        loop_task.cancel()
        try:
            await loop_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Roxabi Live", version="0.1.0", lifespan=lifespan)

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


@app.get("/health")
async def health() -> dict[str, Any]:
    """Health check — returns db path, reachability, and issue count."""
    db = Settings.from_env().corpus_db_path
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
