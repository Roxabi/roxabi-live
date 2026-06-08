"""Tests for corpus.mutations async helpers — T5 [RED].

Covers:
- upsert_issue_async + upsert_issue (sync) on same key produce identical rows
- upsert_issue_async preserves non-payload columns on second call
- add_edge_async is idempotent
- remove_edge_async only removes matching kind
- replace_labels_async wipes and rewrites labels
- delete_issue_async removes issue row
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiosqlite
import pytest

from roxabi_live.corpus.mutations import (
    add_edge_async,
    delete_issue_async,
    remove_edge_async,
    replace_labels_async,
    upsert_edges_async,
    upsert_issue_async,
)
from roxabi_live.corpus.schema import bootstrap, connect
from roxabi_live.corpus.sync import upsert_issue

# ---------------------------------------------------------------------------
# Schema SQL
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS issues (
    key         TEXT PRIMARY KEY,
    repo        TEXT NOT NULL,
    number      INTEGER NOT NULL,
    title       TEXT,
    state       TEXT NOT NULL,
    url         TEXT,
    created_at  TEXT,
    updated_at  TEXT,
    closed_at   TEXT,
    milestone   TEXT,
    is_stub     INTEGER NOT NULL DEFAULT 0,
    lane        TEXT,
    priority    TEXT,
    size        TEXT,
    status      TEXT,
    has_active_branch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS labels (
    issue_key   TEXT NOT NULL,
    name        TEXT NOT NULL,
    PRIMARY KEY (issue_key, name),
    FOREIGN KEY (issue_key) REFERENCES issues(key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edges (
    src_key     TEXT NOT NULL,
    dst_key     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'parent',
    PRIMARY KEY (src_key, dst_key, kind)
);
"""

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
async def db() -> AsyncIterator[aiosqlite.Connection]:
    """In-memory aiosqlite connection with full corpus schema."""
    conn = await aiosqlite.connect(":memory:")
    await conn.executescript(_SCHEMA_SQL)
    await conn.execute("PRAGMA foreign_keys = ON")
    await conn.commit()
    yield conn
    await conn.close()


def _base_issue(
    key: str = "Roxabi/lyra#1",
    repo: str = "Roxabi/lyra",
    number: int = 1,
    title: str = "Test issue",
    state: str = "open",
) -> dict[str, Any]:
    return {
        "key": key,
        "repo": repo,
        "number": number,
        "title": title,
        "state": state,
        "url": f"https://github.com/{repo}/issues/{number}",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "closed_at": None,
        "milestone": "v1.0",
        "is_stub": 0,
        "lane": "a1",
        "priority": "P1",
        "size": "F-lite",
        "status": None,
    }


# ---------------------------------------------------------------------------
# Tests — upsert_issue_async
# ---------------------------------------------------------------------------


class TestUpsertIssueAsync:
    """upsert_issue_async() — async webhook upsert path."""

    async def test_inserts_new_issue(self, db: aiosqlite.Connection) -> None:
        """upsert_issue_async inserts a new row on first call."""
        partial = {
            "key": "Roxabi/lyra#1",
            "repo": "Roxabi/lyra",
            "number": 1,
            "title": "New issue",
            "state": "open",
            "url": "https://github.com/Roxabi/lyra/issues/1",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "closed_at": None,
        }
        await upsert_issue_async(db, partial)
        await db.commit()

        cur = await db.execute(
            "SELECT key, title, state FROM issues WHERE key = ?", ("Roxabi/lyra#1",)
        )
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == "Roxabi/lyra#1"
        assert row[1] == "New issue"
        assert row[2] == "open"

    async def test_propagates_milestone_and_label_derived_fields(
        self, db: aiosqlite.Connection
    ) -> None:
        """Webhook upsert writes milestone, lane, priority, size from the partial.

        The `issues` event payload is always complete for these columns, so the
        webhook upsert propagates them through.  Only `status` (sourced from a
        GitHub Project v2 board, never present in the `issues` payload) is
        preserved on conflict.
        """
        # First call: full sync upsert (sets all columns including status)
        await db.execute(
            """
            INSERT INTO issues
                (key, repo, number, title, state, url, created_at, updated_at,
                 closed_at, milestone, is_stub, lane, priority, size, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "Roxabi/lyra#1",
                "Roxabi/lyra",
                1,
                "Original title",
                "open",
                "https://github.com/Roxabi/lyra/issues/1",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
                None,
                "v1.0",  # milestone
                0,
                "a1",  # lane
                "P1",  # priority
                "F-lite",  # size
                "In Progress",  # status (project board)
            ),
        )
        await db.commit()

        # Second call: webhook upsert with updated milestone/lane/priority/size
        # (e.g. user demilestoned + relabeled the issue)
        partial = {
            "key": "Roxabi/lyra#1",
            "repo": "Roxabi/lyra",
            "number": 1,
            "title": "Updated title",
            "state": "closed",
            "url": "https://github.com/Roxabi/lyra/issues/1",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-04-24T00:00:00Z",
            "closed_at": "2026-04-24T00:00:00Z",
            "milestone": None,  # demilestoned
            "lane": "b",  # relabeled into lane b
            "priority": "P2",
            "size": "S",
        }
        await upsert_issue_async(db, partial)
        await db.commit()

        cur = await db.execute(
            "SELECT title, state, milestone, lane, priority, size, status"
            " FROM issues WHERE key = ?",
            ("Roxabi/lyra#1",),
        )
        row = await cur.fetchone()
        assert row is not None
        title, state, milestone, lane, priority, size, status = row
        # Updated by webhook
        assert title == "Updated title"
        assert state == "closed"
        assert milestone is None, f"milestone not demilestoned: {milestone!r}"
        assert lane == "b", f"lane not updated: {lane!r}"
        assert priority == "P2", f"priority not updated: {priority!r}"
        assert size == "S", f"size not updated: {size!r}"
        # Preserved: status comes from GitHub Project board, not webhook payload
        assert status == "In Progress", f"status was overwritten: {status!r}"

    async def test_sync_and_async_produce_identical_rows(self, tmp_path: Path) -> None:
        """Async + sync upserts on the same key produce identical rows.

        SC7: SQL constants are shared — both paths write the same column set.
        """
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)
        sync_conn = connect(db_path)

        issue = _base_issue()
        upsert_issue(sync_conn, issue)
        sync_conn.commit()

        # Read via sync
        sync_row = sync_conn.execute(
            "SELECT key, repo, number, title, state, url,"
            " created_at, updated_at, closed_at, milestone, is_stub,"
            " lane, priority, size, status"
            " FROM issues WHERE key = ?",
            (issue["key"],),
        ).fetchone()
        sync_conn.close()

        # Now do the same via async path on fresh db
        db_path2 = tmp_path / "corpus2.db"
        bootstrap(db_path2)

        async with aiosqlite.connect(db_path2) as aconn:
            # Insert with all fields first (simulating pre-existing row with full data)
            await aconn.execute(
                """
                INSERT INTO issues
                    (key, repo, number, title, state, url, created_at, updated_at,
                     closed_at, milestone, is_stub, lane, priority, size, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    issue["key"],
                    issue["repo"],
                    issue["number"],
                    issue["title"],
                    issue["state"],
                    issue["url"],
                    issue["created_at"],
                    issue["updated_at"],
                    issue["closed_at"],
                    issue["milestone"],
                    issue["is_stub"],
                    issue["lane"],
                    issue["priority"],
                    issue["size"],
                    issue["status"],
                ),
            )
            await aconn.commit()

            # Update via async path — feed the same payload columns as the
            # sync path so the two rows can be compared 1:1.  status stays
            # NULL through the async path (it comes from a Project board).
            partial = {
                "key": issue["key"],
                "repo": issue["repo"],
                "number": issue["number"],
                "title": issue["title"],
                "state": issue["state"],
                "url": issue["url"],
                "created_at": issue["created_at"],
                "updated_at": issue["updated_at"],
                "closed_at": issue["closed_at"],
                "milestone": issue["milestone"],
                "lane": issue["lane"],
                "priority": issue["priority"],
                "size": issue["size"],
            }
            await upsert_issue_async(aconn, partial)
            await aconn.commit()

            cur = await aconn.execute(
                "SELECT key, repo, number, title, state, url,"
                " created_at, updated_at, closed_at, milestone, is_stub,"
                " lane, priority, size, status"
                " FROM issues WHERE key = ?",
                (issue["key"],),
            )
            async_row = await cur.fetchone()

        # All 15 columns must match — both paths share the same SQL constants
        # so the row layout written by sync upsert_issue and async
        # upsert_issue_async must be identical (SC7).
        assert sync_row is not None
        assert async_row is not None
        column_names = (
            "key",
            "repo",
            "number",
            "title",
            "state",
            "url",
            "created_at",
            "updated_at",
            "closed_at",
            "milestone",
            "is_stub",
            "lane",
            "priority",
            "size",
            "status",
        )
        for i, name in enumerate(column_names):
            assert sync_row[i] == async_row[i], (
                f"Column {name}: {sync_row[i]!r} (sync) vs {async_row[i]!r} (async)"
            )


# ---------------------------------------------------------------------------
# Tests — add_edge_async / remove_edge_async
# ---------------------------------------------------------------------------


class TestEdgeAsync:
    """add_edge_async and remove_edge_async."""

    async def test_add_edge_inserts(self, db: aiosqlite.Connection) -> None:
        """add_edge_async inserts an edge row and returns delta=1."""
        delta = await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()

        cur = await db.execute(
            "SELECT src_key, dst_key, kind FROM edges"
            " WHERE src_key=? AND dst_key=? AND kind=?",
            ("A#1", "B#2", "blocks"),
        )
        row = await cur.fetchone()
        assert row == ("A#1", "B#2", "blocks")
        assert delta == 1, f"Expected delta=1 for new edge insert, got {delta}"

    async def test_add_edge_is_idempotent(self, db: aiosqlite.Connection) -> None:
        """Calling add_edge_async twice on same (src, dst, kind) is idempotent."""
        delta1 = await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()
        delta2 = await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()

        cur = await db.execute("SELECT COUNT(*) FROM edges")
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == 1
        assert delta1 == 1, f"Expected delta1=1 for first insert, got {delta1}"
        assert delta2 == 0, f"Expected delta2=0 for idempotent insert, got {delta2}"

    async def test_remove_edge_deletes(self, db: aiosqlite.Connection) -> None:
        """remove_edge_async removes the specified edge and returns delta=1."""
        await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()
        delta = await remove_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()

        cur = await db.execute("SELECT COUNT(*) FROM edges")
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == 0
        assert delta == 1, f"Expected delta=1 for edge delete, got {delta}"

    async def test_remove_edge_only_removes_matching_kind(
        self, db: aiosqlite.Connection
    ) -> None:
        """remove_edge_async with kind='parent' does not remove kind='blocks' edges."""
        await add_edge_async(db, "A#1", "B#2", "parent")
        await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()

        delta = await remove_edge_async(db, "A#1", "B#2", "parent")
        await db.commit()

        cur = await db.execute("SELECT src_key, dst_key, kind FROM edges")
        rows = list(await cur.fetchall())
        assert len(rows) == 1
        assert rows[0] == ("A#1", "B#2", "blocks")
        assert delta == 1, f"Expected delta=1 for single-kind delete, got {delta}"


# ---------------------------------------------------------------------------
# Tests — upsert_edges_async
# ---------------------------------------------------------------------------


class TestUpsertEdgesAsync:
    """upsert_edges_async() — batch rewrite of edges for an issue."""

    async def test_insert_only(self, db: aiosqlite.Connection) -> None:
        """No pre-seeded edges: delta equals number of rows inserted."""
        delta = await upsert_edges_async(
            db, "A#1", blocked_by=["B#2"], blocking=["C#3"], kind="blocks"
        )
        await db.commit()

        assert delta == 2, f"Expected delta=2 (2 inserts), got {delta}"
        cur = await db.execute("SELECT COUNT(*) FROM edges")
        row = await cur.fetchone()
        assert row is not None and row[0] == 2

    async def test_delete_and_rewrite(self, db: aiosqlite.Connection) -> None:
        """Pre-seeded edges replaced: delta = deleted + inserted."""
        await add_edge_async(db, "B#2", "A#1", "blocks")
        await add_edge_async(db, "A#1", "C#3", "blocks")
        await db.commit()

        delta = await upsert_edges_async(
            db, "A#1", blocked_by=["D#4"], blocking=["E#5"], kind="blocks"
        )
        await db.commit()

        assert delta == 4, f"Expected delta=4 (2 deletes + 2 inserts), got {delta}"
        cur = await db.execute(
            "SELECT src_key, dst_key, kind FROM edges ORDER BY src_key"
        )
        rows = list(await cur.fetchall())
        assert len(rows) == 2
        assert rows[0] == ("A#1", "E#5", "blocks")
        assert rows[1] == ("D#4", "A#1", "blocks")

    async def test_empty_lists(self, db: aiosqlite.Connection) -> None:
        """Pre-seeded edges cleared: delta equals number of deleted rows."""
        await add_edge_async(db, "B#2", "A#1", "blocks")
        await add_edge_async(db, "A#1", "C#3", "blocks")
        await db.commit()

        delta = await upsert_edges_async(
            db, "A#1", blocked_by=[], blocking=[], kind="blocks"
        )
        await db.commit()

        assert delta == 2, f"Expected delta=2 (2 deletes), got {delta}"
        cur = await db.execute("SELECT COUNT(*) FROM edges")
        row = await cur.fetchone()
        assert row is not None and row[0] == 0


# ---------------------------------------------------------------------------
# Tests — replace_labels_async
# ---------------------------------------------------------------------------


class TestReplaceLabelsAsync:
    """replace_labels_async() — wipes and rewrites labels for an issue."""

    async def test_inserts_labels(self, db: aiosqlite.Connection) -> None:
        """replace_labels_async inserts the given label names."""
        # Need an issue row first (FK constraint)
        await db.execute(
            "INSERT INTO issues (key, repo, number, title, state) VALUES (?,?,?,?,?)",
            ("K#1", "K", 1, "t", "open"),
        )
        await db.commit()

        await replace_labels_async(db, "K#1", ["bug", "enhancement"])
        await db.commit()

        cur = await db.execute(
            "SELECT name FROM labels WHERE issue_key=? ORDER BY name", ("K#1",)
        )
        rows = await cur.fetchall()
        assert [r[0] for r in rows] == ["bug", "enhancement"]

    async def test_replaces_existing_labels(self, db: aiosqlite.Connection) -> None:
        """replace_labels_async wipes old labels before writing new ones."""
        await db.execute(
            "INSERT INTO issues (key, repo, number, title, state) VALUES (?,?,?,?,?)",
            ("K#1", "K", 1, "t", "open"),
        )
        await db.execute(
            "INSERT INTO labels (issue_key, name) VALUES (?,?)", ("K#1", "old-label")
        )
        await db.commit()

        await replace_labels_async(db, "K#1", ["new-label"])
        await db.commit()

        cur = await db.execute(
            "SELECT name FROM labels WHERE issue_key=? ORDER BY name", ("K#1",)
        )
        rows = await cur.fetchall()
        assert [r[0] for r in rows] == ["new-label"]


# ---------------------------------------------------------------------------
# Tests — delete_issue_async
# ---------------------------------------------------------------------------


class TestDeleteIssueAsync:
    """delete_issue_async() — removes an issue row."""

    async def test_deletes_existing_issue(self, db: aiosqlite.Connection) -> None:
        """delete_issue_async removes the issue row."""
        await db.execute(
            "INSERT INTO issues (key, repo, number, title, state) VALUES (?,?,?,?,?)",
            ("K#1", "K", 1, "t", "open"),
        )
        await db.commit()

        await delete_issue_async(db, "K#1")
        await db.commit()

        cur = await db.execute("SELECT COUNT(*) FROM issues WHERE key=?", ("K#1",))
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == 0

    async def test_delete_nonexistent_is_noop(self, db: aiosqlite.Connection) -> None:
        """delete_issue_async on a missing key does not raise."""
        await delete_issue_async(db, "nonexistent#99")
        await db.commit()
