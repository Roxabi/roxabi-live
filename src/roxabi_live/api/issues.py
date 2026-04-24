"""GET /api/issues — list issues with optional filtering and single-issue lookup."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api", tags=["issues"])


def _db_path() -> Path:
    return Path(os.environ.get("CORPUS_DB_PATH", Path.home() / ".roxabi" / "corpus.db"))


@router.get("/issues")
async def list_issues(
    repo: str | None = None,
    state: str | None = None,
    label: str | None = None,
) -> dict[str, Any]:
    """Return all issues matching the given filters.

    Query params (all optional, combinable):
      - repo:  exact repo name match
      - state: exact state match (open / closed)
      - label: issue must have this label (EXISTS subquery)
    """
    conditions: list[str] = []
    params: list[Any] = []

    if repo is not None:
        conditions.append("issues.repo = ?")
        params.append(repo)

    if state is not None:
        conditions.append("issues.state = ?")
        params.append(state)

    if label is not None:
        conditions.append(
            "EXISTS ("
            "SELECT 1 FROM labels l "
            "WHERE l.issue_key = issues.key AND l.name = ?"
            ")"
        )
        params.append(label)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    sql = f"""
        SELECT issues.key, issues.repo, issues.number, issues.title,
               issues.state, issues.updated_at
        FROM issues
        {where}
        ORDER BY issues.updated_at ASC
    """

    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            rows = await cur.fetchall()

        items: list[dict[str, Any]] = []
        for row in rows:
            async with db.execute(
                "SELECT name FROM labels WHERE issue_key = ? ORDER BY name",
                (row["key"],),
            ) as lc:
                label_rows = await lc.fetchall()
            items.append(
                {
                    "key": row["key"],
                    "repo": row["repo"],
                    "number": row["number"],
                    "title": row["title"],
                    "state": row["state"],
                    "updated_at": row["updated_at"],
                    "labels": [lr["name"] for lr in label_rows],
                }
            )

    return {"total": len(items), "items": items}


@router.get("/issues/{key:path}")
async def get_issue(key: str) -> dict[str, Any]:
    """Return a single issue by key, including blocking/blocked_by edge arrays."""
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row

        sql = (
            "SELECT key, repo, number, title, state, updated_at"
            " FROM issues WHERE key = ?"
        )
        async with db.execute(sql, (key,)) as cur:
            row = await cur.fetchone()

        if row is None:
            raise HTTPException(status_code=404, detail="Issue not found")

        async with db.execute(
            "SELECT name FROM labels WHERE issue_key = ? ORDER BY name",
            (key,),
        ) as lc:
            labels = [r["name"] for r in await lc.fetchall()]

        async with db.execute(
            "SELECT dst_key FROM edges WHERE src_key = ? AND kind = 'blocks'",
            (key,),
        ) as bc:
            blocking = [r["dst_key"] for r in await bc.fetchall()]

        async with db.execute(
            "SELECT src_key FROM edges WHERE dst_key = ? AND kind = 'blocks'",
            (key,),
        ) as bbc:
            blocked_by = [r["src_key"] for r in await bbc.fetchall()]

    return {
        **dict(row),
        "labels": labels,
        "blocking": blocking,
        "blocked_by": blocked_by,
    }
