"""GET /api/issues — list issues with optional filtering and single-issue lookup."""

from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import APIRouter, HTTPException, Request

from roxabi_live.config import get_settings

router = APIRouter(prefix="/api", tags=["issues"])


def _get_db_path(request: Request) -> Path:
    return get_settings(request).corpus_db_path


def _parse_key(key: str) -> tuple[str, int | None]:
    """Parse 'owner/repo#N' → (repo, number).  Returns (key, None) on failure."""
    m = re.match(r"^(.+)#(\d+)$", key)
    if m:
        return m.group(1), int(m.group(2))
    return key, None


ISSUE_KEY_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+$")


@router.get("/issues")
async def list_issues(  # noqa: PLR0913 — FastAPI query params, not domain args
    request: Request,
    repo: str | None = None,
    state: str | None = None,
    label: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """Return all issues matching the given filters.

    Query params (all optional, combinable):
      - repo:   exact repo name match
      - state:  exact state match (open / closed)
      - label:  issue must have this label (EXISTS subquery)
      - limit:  max rows to return (default 100)
      - offset: row offset for pagination (default 0)
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

    count_sql = f"SELECT COUNT(*) FROM issues {where}"

    data_sql = f"""
        SELECT issues.key, issues.repo, issues.number, issues.title,
               issues.state, issues.url, issues.milestone, issues.is_stub,
               issues.created_at, issues.updated_at, issues.closed_at
        FROM issues
        {where}
        ORDER BY issues.updated_at ASC
        LIMIT ? OFFSET ?
    """

    async with aiosqlite.connect(_get_db_path(request)) as db:
        db.row_factory = aiosqlite.Row

        async with db.execute(count_sql, params) as cnt_cur:
            cnt_row = await cnt_cur.fetchone()
        total = cnt_row[0] if cnt_row else 0

        async with db.execute(data_sql, [*params, limit, offset]) as cur:
            rows = await cur.fetchall()

        labels_by_key: dict[str, list[str]] = defaultdict(list)
        if rows:
            keys = [row["key"] for row in rows]
            placeholders = ",".join("?" * len(keys))
            lbl_sql = (
                f"SELECT issue_key, name FROM labels"
                f" WHERE issue_key IN ({placeholders}) ORDER BY name"
            )
            async with db.execute(lbl_sql, keys) as lc:
                async for lr in lc:
                    labels_by_key[str(lr["issue_key"])].append(str(lr["name"]))

        issues: list[dict[str, Any]] = []
        for row in rows:
            issues.append(
                {
                    "key": row["key"],
                    "repo": row["repo"],
                    "number": row["number"],
                    "title": row["title"],
                    "state": row["state"],
                    "url": row["url"],
                    "labels": labels_by_key[row["key"]],
                    "milestone": row["milestone"],
                    "is_stub": bool(row["is_stub"]),
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "closed_at": row["closed_at"],
                }
            )

    return {"issues": issues, "total": total, "limit": limit, "offset": offset}


@router.get("/issues/{key:path}")
async def get_issue(request: Request, key: str) -> dict[str, Any]:
    """Return a single issue by key, including blocking/blocked_by edge arrays."""
    if not ISSUE_KEY_RE.fullmatch(key):
        raise HTTPException(
            status_code=400,
            detail="invalid issue key; expected '<owner>/<repo>#<number>'",
        )
    async with aiosqlite.connect(_get_db_path(request)) as db:
        db.row_factory = aiosqlite.Row

        sql = (
            "SELECT key, repo, number, title, state, url, milestone, is_stub,"
            " created_at, updated_at, closed_at"
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

        # blocking: edges where this issue is src (kind=blocks) → dst issues
        async with db.execute(
            "SELECT e.dst_key, i.number, i.repo"
            " FROM edges e"
            " LEFT JOIN issues i ON i.key = e.dst_key"
            " WHERE e.src_key = ? AND e.kind = 'blocks'",
            (key,),
        ) as bc:
            blocking_rows = await bc.fetchall()

        # blocked_by: edges where this issue is dst (kind=blocks) → src issues
        async with db.execute(
            "SELECT e.src_key, i.number, i.repo"
            " FROM edges e"
            " LEFT JOIN issues i ON i.key = e.src_key"
            " WHERE e.dst_key = ? AND e.kind = 'blocks'",
            (key,),
        ) as bbc:
            blocked_by_rows = await bbc.fetchall()

    def _edge_item(
        edge_key: str, number: int | None, edge_repo: str | None
    ) -> dict[str, Any]:
        if number is None or edge_repo is None:
            # Stub fallback: parse from key
            parsed_repo, parsed_number = _parse_key(edge_key)
            return {"key": edge_key, "number": parsed_number, "repo": parsed_repo}
        return {"key": edge_key, "number": number, "repo": edge_repo}

    blocking = [_edge_item(r["dst_key"], r["number"], r["repo"]) for r in blocking_rows]
    blocked_by = [
        _edge_item(r["src_key"], r["number"], r["repo"]) for r in blocked_by_rows
    ]

    return {
        "key": row["key"],
        "repo": row["repo"],
        "number": row["number"],
        "title": row["title"],
        "state": row["state"],
        "url": row["url"],
        "labels": labels,
        "milestone": row["milestone"],
        "is_stub": bool(row["is_stub"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "closed_at": row["closed_at"],
        "blocking": blocking,
        "blocked_by": blocked_by,
    }
