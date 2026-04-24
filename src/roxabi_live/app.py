"""FastAPI application factory."""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from roxabi_live import reconciler
from roxabi_live.api.issues import router as issues_router
from roxabi_live.dep_graph.v5.serve import router as dep_graph_v5_router
from roxabi_live.dep_graph.v6.repos import router as repos_router
from roxabi_live.dep_graph.v6.routes import router as dep_graph_v6_router
from roxabi_live.webhook.router import router as webhook_router

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    log.info("reconciler startup sync scheduled")
    asyncio.create_task(reconciler.run_once())
    loop_task = reconciler.hourly_loop()
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
async def health() -> dict[str, str]:
    """Health check — smoke test only.

    Full implementation (db_reachable, issue_count) lands in spec #866 slice 3.
    """
    return {"status": "ok"}
