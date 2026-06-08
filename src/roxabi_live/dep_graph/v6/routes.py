"""FastAPI routes for v6 dep-graph."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter

from .api import GraphPayload, build_graph_json

router = APIRouter(prefix="/api/graph", tags=["dep-graph"])


def _db_path() -> Path:
    return Path(os.environ.get("CORPUS_DB_PATH", Path.home() / ".roxabi" / "corpus.db"))


@router.get("", response_model=None)
async def get_graph() -> GraphPayload:
    return await build_graph_json(_db_path())
