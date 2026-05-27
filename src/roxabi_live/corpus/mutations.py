"""Async corpus mutation helpers for the webhook layer.

These helpers are called by webhook/handlers.py to write corpus data via
aiosqlite. They share SQL constants with corpus.sync so both paths produce
identical rows.

Design contract:
- No commit() inside helpers — the caller controls the transaction boundary.
- All write helpers accept an aiosqlite.Connection and call execute/executemany.
- SQL constants are imported from corpus.sync to guarantee a single source.
"""

from __future__ import annotations

from typing import Any

import aiosqlite

from roxabi_live.corpus.sync import (
    DELETE_EDGE_SQL,
    DELETE_EDGES_BY_KIND_SQL,
    DELETE_LABELS_SQL,
    INSERT_EDGE_SQL,
    INSERT_LABEL_SQL,
    UPSERT_ISSUE_FROM_WEBHOOK_SQL,
    UPSERT_PR_STATE_SQL,
)

# SQL constants for branch and PR state mutations (webhook + sync paths)
SET_ACTIVE_BRANCH_ON_SQL = (
    "UPDATE issues SET has_active_branch=1 WHERE repo=? AND number=?"
)
SET_ACTIVE_BRANCH_OFF_SQL = (
    "UPDATE issues SET has_active_branch=0 WHERE repo=? AND number=?"
)


async def upsert_issue_async(
    conn: aiosqlite.Connection, issue_partial: dict[str, Any]
) -> None:
    """Insert-or-update an issue row from a webhook payload.

    Uses UPSERT_ISSUE_FROM_WEBHOOK_SQL which propagates every column carried
    by the GitHub `issues` event (including milestone, lane, priority, size).
    Only `status` is preserved on conflict — it is sourced from a GitHub
    Project v2 board and never present in the `issues` payload.

    Expected keys in issue_partial:
        key, repo, number, title, state, url, created_at, updated_at, closed_at,
        milestone, lane, priority, size
    Missing keys default to NULL.
    """
    await conn.execute(
        UPSERT_ISSUE_FROM_WEBHOOK_SQL,
        (
            issue_partial["key"],
            issue_partial["repo"],
            issue_partial["number"],
            issue_partial["title"],
            issue_partial["state"],
            issue_partial["url"],
            issue_partial.get("created_at"),
            issue_partial.get("updated_at"),
            issue_partial.get("closed_at"),
            issue_partial.get("milestone"),
            issue_partial.get("lane"),
            issue_partial.get("priority"),
            issue_partial.get("size"),
        ),
    )


async def replace_labels_async(
    conn: aiosqlite.Connection, key: str, names: list[str]
) -> None:
    """Wipe all labels for issue key and rewrite them.

    Runs inside the caller's transaction — no commit() here.
    """
    await conn.execute(DELETE_LABELS_SQL, (key,))
    await conn.executemany(
        INSERT_LABEL_SQL,
        [(key, name) for name in names],
    )


async def add_edge_async(
    conn: aiosqlite.Connection, src: str, dst: str, kind: str
) -> int:
    """Insert an edge (src, dst, kind) ignoring conflicts (idempotent).

    Returns the number of rows inserted (0 if the edge already existed).

    Runs inside the caller's transaction — no commit() here.
    """
    cur = await conn.execute(INSERT_EDGE_SQL, (src, dst, kind))
    return cur.rowcount


async def remove_edge_async(
    conn: aiosqlite.Connection, src: str, dst: str, kind: str
) -> int:
    """Delete the edge (src, dst, kind) if it exists.

    Returns the number of rows deleted (0 if the edge did not exist).

    Runs inside the caller's transaction — no commit() here.
    """
    cur = await conn.execute(DELETE_EDGE_SQL, (src, dst, kind))
    return cur.rowcount


async def delete_issue_async(conn: aiosqlite.Connection, key: str) -> None:
    """Delete an issue row by key.

    Runs inside the caller's transaction — no commit() here.
    """
    await conn.execute("DELETE FROM issues WHERE key = ?", (key,))


async def upsert_edges_async(
    conn: aiosqlite.Connection,
    issue_key: str,
    blocked_by: list[str],
    blocking: list[str],
    kind: str = "parent",
) -> int:
    """Async mirror of corpus.sync.upsert_edges for use in the webhook layer.

    Wipes all edges touching issue_key (as src OR dst) of the given kind, then
    rewrites from blocked_by + blocking.

    Canonical direction:
    - Every blocker b in blocked_by -> row (src=b, dst=issue_key).
    - Every blockee b in blocking  -> row (src=issue_key, dst=b).

    Returns the total number of rows changed (deleted + inserted).

    Runs inside the caller's transaction — no commit() here.
    """
    before = conn.total_changes
    await conn.execute(DELETE_EDGES_BY_KIND_SQL, (issue_key, issue_key, kind))
    rows: list[tuple[str, str, str]] = []
    for blocker in blocked_by:
        rows.append((blocker, issue_key, kind))
    for blockee in blocking:
        rows.append((issue_key, blockee, kind))
    if rows:
        await conn.executemany(INSERT_EDGE_SQL, rows)
    return conn.total_changes - before


async def set_active_branch_async(
    conn: aiosqlite.Connection, repo: str, number: int, value: int
) -> None:
    """Set has_active_branch for the given issue.

    Runs inside the caller's transaction — no commit() here.
    value: 1 to mark active, 0 to clear.
    """
    sql = SET_ACTIVE_BRANCH_ON_SQL if value else SET_ACTIVE_BRANCH_OFF_SQL
    await conn.execute(sql, (repo, number))


async def upsert_pr_state_async(  # noqa: PLR0913
    conn: aiosqlite.Connection,
    repo: str,
    number: int,
    state: str,
    has_reviewed_label: int,
    closing_issue_keys_json: str,
    updated_at: str,
) -> None:
    """Insert or update a pr_state row.

    Runs inside the caller's transaction — no commit() here.
    """
    await conn.execute(
        UPSERT_PR_STATE_SQL,
        (repo, number, state, has_reviewed_label, closing_issue_keys_json, updated_at),
    )
