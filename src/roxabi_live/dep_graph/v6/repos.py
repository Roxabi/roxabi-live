"""v6 repos route — distinct repos from the corpus DB."""

from __future__ import annotations

import os
from pathlib import Path

import aiosqlite
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["repos"])


def _db_path() -> Path:
    return Path(os.environ.get("CORPUS_DB_PATH", Path.home() / ".roxabi" / "corpus.db"))


@router.get("/repos")
async def get_repos() -> list[str]:
    """Return distinct repos from issues, sorted alphabetically."""
    async with aiosqlite.connect(_db_path()) as db:
        async with db.execute(
            "SELECT DISTINCT repo FROM issues ORDER BY repo"
        ) as cur:
            rows = await cur.fetchall()
    return [row[0] for row in rows]
