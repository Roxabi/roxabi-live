"""v6 repos route — repos and sync state from corpus DB."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["repos"])


def _db_path() -> Path:
    return Path(os.environ.get("CORPUS_DB_PATH", Path.home() / ".roxabi" / "corpus.db"))


@router.get("/repos")
async def get_repos() -> dict[str, Any]:
    """Return repos and their sync state from sync_state table."""
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT repo, last_synced_at, last_cursor FROM sync_state ORDER BY repo"
        ) as cur:
            rows = await cur.fetchall()
    return {
        "repos": [
            {
                "repo": row["repo"],
                "last_synced_at": row["last_synced_at"],
                "last_cursor": row["last_cursor"],
            }
            for row in rows
        ]
    }
