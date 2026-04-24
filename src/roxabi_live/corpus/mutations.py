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
    DELETE_LABELS_SQL,
    INSERT_EDGE_SQL,
    INSERT_LABEL_SQL,
    UPSERT_ISSUE_FROM_WEBHOOK_SQL,
    _extract_from_labels,
)

# Re-export for callers that need label derivation without underscore import.
extract_from_labels = _extract_from_labels


async def upsert_issue_async(
    conn: aiosqlite.Connection, issue_partial: dict[str, Any]
) -> None:
    """Insert-or-update an issue row from a webhook payload.

    Uses UPSERT_ISSUE_FROM_WEBHOOK_SQL which preserves milestone, is_stub,
    lane, priority, size, status on conflict — those columns are only updated
    by a full corpus.sync run, never by a webhook event.

    Expected keys in issue_partial:
        key, repo, number, title, state, url, created_at, updated_at, closed_at
    All other columns (milestone, is_stub, lane, priority, size, status) are
    preserved from the existing row on conflict.
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
) -> None:
    """Insert an edge (src, dst, kind) ignoring conflicts (idempotent).

    Runs inside the caller's transaction — no commit() here.
    """
    await conn.execute(INSERT_EDGE_SQL, (src, dst, kind))


async def remove_edge_async(
    conn: aiosqlite.Connection, src: str, dst: str, kind: str
) -> None:
    """Delete the edge (src, dst, kind) if it exists.

    Runs inside the caller's transaction — no commit() here.
    """
    await conn.execute(DELETE_EDGE_SQL, (src, dst, kind))


async def delete_issue_async(conn: aiosqlite.Connection, key: str) -> None:
    """Delete an issue row by key.

    Runs inside the caller's transaction — no commit() here.
    """
    await conn.execute("DELETE FROM issues WHERE key = ?", (key,))
