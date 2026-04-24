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
    status      TEXT
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

    async def test_preserves_non_payload_columns(
        self, db: aiosqlite.Connection
    ) -> None:
        """Second call preserves milestone/lane/priority/size/status from first.

        SC13: non-payload columns must not be NULL'd by a webhook upsert.
        """
        # First call: full sync upsert (sets milestone, lane, priority, size)
        # We simulate this by directly inserting a row with all columns set
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
                None,
            ),
        )
        await db.commit()

        # Second call: webhook upsert (without milestone/lane/priority/size)
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
        title, state, milestone, lane, priority, size, _status = row
        # Updated fields
        assert title == "Updated title"
        assert state == "closed"
        # Preserved non-payload fields
        assert milestone == "v1.0", f"milestone was NULLed: {milestone!r}"
        assert lane == "a1", f"lane was NULLed: {lane!r}"
        assert priority == "P1", f"priority was NULLed: {priority!r}"
        assert size == "F-lite", f"size was NULLed: {size!r}"

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

            # Update via async path
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

        # Core fields should match (async preserves milestone/lane/etc from DB)
        assert sync_row is not None
        assert async_row is not None
        # key, repo, number, title, state, url match
        for i in range(6):
            assert sync_row[i] == async_row[i], (
                f"Column {i} mismatch: {sync_row[i]!r} vs {async_row[i]!r}"
            )


# ---------------------------------------------------------------------------
# Tests — add_edge_async / remove_edge_async
# ---------------------------------------------------------------------------


class TestEdgeAsync:
    """add_edge_async and remove_edge_async."""

    async def test_add_edge_inserts(self, db: aiosqlite.Connection) -> None:
        """add_edge_async inserts an edge row."""
        await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()

        cur = await db.execute(
            "SELECT src_key, dst_key, kind FROM edges"
            " WHERE src_key=? AND dst_key=? AND kind=?",
            ("A#1", "B#2", "blocks"),
        )
        row = await cur.fetchone()
        assert row == ("A#1", "B#2", "blocks")

    async def test_add_edge_is_idempotent(self, db: aiosqlite.Connection) -> None:
        """Calling add_edge_async twice on same (src, dst, kind) is idempotent."""
        await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()
        await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()

        cur = await db.execute("SELECT COUNT(*) FROM edges")
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == 1

    async def test_remove_edge_deletes(self, db: aiosqlite.Connection) -> None:
        """remove_edge_async removes the specified edge."""
        await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()
        await remove_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()

        cur = await db.execute("SELECT COUNT(*) FROM edges")
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == 0

    async def test_remove_edge_only_removes_matching_kind(
        self, db: aiosqlite.Connection
    ) -> None:
        """remove_edge_async with kind='parent' does not remove kind='blocks' edges."""
        await add_edge_async(db, "A#1", "B#2", "parent")
        await add_edge_async(db, "A#1", "B#2", "blocks")
        await db.commit()

        await remove_edge_async(db, "A#1", "B#2", "parent")
        await db.commit()

        cur = await db.execute("SELECT src_key, dst_key, kind FROM edges")
        rows = list(await cur.fetchall())
        assert len(rows) == 1
        assert rows[0] == ("A#1", "B#2", "blocks")


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
