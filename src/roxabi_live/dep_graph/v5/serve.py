"""Serve v5.1 HTML — rebuild on demand when corpus.db is newer than the output.

POC: wraps the existing v5 compose pipeline behind a FastAPI route so the
cockpit can render the dep-graph from live corpus data.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from . import compose
from .build import OUT as V51_OUT
from .data import load as loader

router = APIRouter(prefix="/dep-graph", tags=["dep-graph-v5"])

_CORPUS_DB = Path.home() / ".roxabi" / "corpus.db"


def _needs_rebuild(html_path: Path, db_path: Path) -> bool:
    if not html_path.exists():
        return True
    if not db_path.exists():
        return False
    return db_path.stat().st_mtime > html_path.stat().st_mtime


def _rebuild() -> None:
    data = loader.load()
    compose.write(V51_OUT, data, active="graph")


@router.get("", response_class=HTMLResponse)
@router.get("/", response_class=HTMLResponse)
async def get_dep_graph() -> HTMLResponse:
    if _needs_rebuild(V51_OUT, _CORPUS_DB):
        _rebuild()
    return HTMLResponse(V51_OUT.read_text(encoding="utf-8"))
