"""Failing tests for roxabi_live.webhook.handlers.handle_issues (RED phase).

Module does not exist yet — all tests will fail with ImportError until the
implementation lands.

handle_issues(payload: dict, conn: aiosqlite.Connection) -> None
- Processes GitHub `issues` webhook events: opened, edited, labeled,
  unlabeled, closed, reopened, deleted
- Upserts the issues row (key = {repo}#{number}) and replaces labels rows

Namespaces reserved per spec:
  test_issues_*       — this task (T16)
  test_deps_*         — T18
  test_sub_issues_*   — T18
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiosqlite
import pytest

from roxabi_live.webhook.handlers import handle_deps, handle_issues, handle_sub_issues

# ---------------------------------------------------------------------------
# Schema SQL (mirrors corpus schema — issues + labels only)
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
    PRIMARY KEY (src_key, dst_key)
);
"""

# ---------------------------------------------------------------------------
# Payload helpers
# ---------------------------------------------------------------------------


def _make_payload(  # noqa: PLR0913
    action: str,
    number: int = 7,
    title: str = "Test issue",
    state: str = "open",
    labels: list[str] | None = None,
    repo: str = "Roxabi/lyra",
    url: str | None = None,
    updated_at: str = "2026-04-24T12:00:00Z",
) -> dict[str, Any]:
    """Build a minimal GitHub `issues` webhook payload."""
    if labels is None:
        labels = []
    if url is None:
        url = f"https://github.com/{repo}/issues/{number}"
    repo_owner, repo_name = repo.split("/", 1) if "/" in repo else ("Roxabi", repo)
    return {
        "action": action,
        "issue": {
            "number": number,
            "title": title,
            "state": state,
            "html_url": url,
            "labels": [{"name": lbl} for lbl in labels],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": updated_at,
            "closed_at": None,
            "milestone": None,
        },
        "repository": {
            "full_name": repo,
            "name": repo_name,
            "owner": {"login": repo_owner},
        },
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
async def db(tmp_path: Path) -> AsyncIterator[aiosqlite.Connection]:
    """In-memory aiosqlite connection with issues + labels schema."""
    conn = await aiosqlite.connect(":memory:")
    await conn.executescript(_SCHEMA_SQL)
    await conn.execute("PRAGMA foreign_keys = ON")
    await conn.commit()
    yield conn
    await conn.close()


async def _seed_issue(  # noqa: PLR0913
    conn: aiosqlite.Connection,
    key: str,
    repo: str,
    number: int,
    title: str = "Pre-seeded issue",
    state: str = "open",
    labels: list[str] | None = None,
) -> None:
    """Insert a row into issues (and optional labels) for pre-seeding tests."""
    await conn.execute(
        """
        INSERT INTO issues (key, repo, number, title, state)
        VALUES (?, ?, ?, ?, ?)
        """,
        (key, repo, number, title, state),
    )
    for lbl in labels or []:
        await conn.execute(
            "INSERT INTO labels (issue_key, name) VALUES (?, ?)",
            (key, lbl),
        )
    await conn.commit()


async def _fetch_issue(conn: aiosqlite.Connection, key: str) -> aiosqlite.Row | None:
    """Return (key, repo, number, title, state) for the given issue key."""
    cursor = await conn.execute(
        "SELECT key, repo, number, title, state FROM issues WHERE key = ?",
        (key,),
    )
    return await cursor.fetchone()


async def _fetch_labels(conn: aiosqlite.Connection, key: str) -> list[str]:
    """Return sorted label names for the given issue key."""
    cursor = await conn.execute(
        "SELECT name FROM labels WHERE issue_key = ? ORDER BY name",
        (key,),
    )
    rows = await cursor.fetchall()
    return [r[0] for r in rows]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestIssuesWebhookHandler:
    """handle_issues() — GitHub issues webhook event processing."""

    async def test_issues_opened_inserts_row(self, db: aiosqlite.Connection) -> None:
        """action=opened inserts a new issue row with correct fields."""
        # Arrange
        payload = _make_payload(
            action="opened",
            number=7,
            title="New feature request",
            state="open",
            labels=["enhancement", "good first issue"],
            repo="Roxabi/lyra",
        )

        # Act
        await handle_issues(payload, db)

        # Assert — issue row present with expected fields
        row = await _fetch_issue(db, "Roxabi/lyra#7")
        assert row is not None, "Expected issue row to be inserted"
        key, repo, number, title, state = row
        assert key == "Roxabi/lyra#7"
        assert repo == "Roxabi/lyra"
        assert number == 7
        assert title == "New feature request"
        assert state == "open"

        # Assert — labels inserted
        labels = await _fetch_labels(db, "Roxabi/lyra#7")
        assert labels == ["enhancement", "good first issue"]

    async def test_issues_labeled_replaces_labels(
        self, db: aiosqlite.Connection
    ) -> None:
        """action=labeled with new label set replaces old labels entirely."""
        # Arrange — pre-seed issue with labels [a, b]
        await _seed_issue(
            db,
            key="Roxabi/lyra#7",
            repo="Roxabi/lyra",
            number=7,
            labels=["a", "b"],
        )
        payload = _make_payload(
            action="labeled",
            number=7,
            labels=["a", "b", "c"],
            repo="Roxabi/lyra",
        )

        # Act
        await handle_issues(payload, db)

        # Assert — old set cleared, new set [a, b, c] in place
        labels = await _fetch_labels(db, "Roxabi/lyra#7")
        assert labels == ["a", "b", "c"], f"Expected [a, b, c], got {labels}"

    async def test_issues_closed_updates_state(self, db: aiosqlite.Connection) -> None:
        """action=closed transitions state to 'closed'."""
        # Arrange — pre-seed open issue
        await _seed_issue(
            db,
            key="Roxabi/lyra#7",
            repo="Roxabi/lyra",
            number=7,
            state="open",
        )
        payload = _make_payload(
            action="closed",
            number=7,
            state="closed",
            repo="Roxabi/lyra",
        )

        # Act
        await handle_issues(payload, db)

        # Assert
        row = await _fetch_issue(db, "Roxabi/lyra#7")
        assert row is not None
        _key, _repo, _number, _title, state = row
        assert state == "closed", f"Expected state='closed', got '{state}'"

    async def test_issues_edited_updates_title(self, db: aiosqlite.Connection) -> None:
        """action=edited with new title updates the title column."""
        # Arrange — pre-seed issue with original title
        await _seed_issue(
            db,
            key="Roxabi/lyra#7",
            repo="Roxabi/lyra",
            number=7,
            title="Original title",
        )
        payload = _make_payload(
            action="edited",
            number=7,
            title="Updated title",
            repo="Roxabi/lyra",
        )

        # Act
        await handle_issues(payload, db)

        # Assert
        row = await _fetch_issue(db, "Roxabi/lyra#7")
        assert row is not None
        _key, _repo, _number, title, _state = row
        assert title == "Updated title", f"Expected 'Updated title', got '{title}'"

    async def test_issues_deleted_removes_row(self, db: aiosqlite.Connection) -> None:
        """action=deleted removes the issue row and its labels."""
        # Arrange — pre-seed issue with labels
        await _seed_issue(
            db,
            key="Roxabi/lyra#7",
            repo="Roxabi/lyra",
            number=7,
            labels=["bug", "urgent"],
        )
        payload = _make_payload(
            action="deleted",
            number=7,
            repo="Roxabi/lyra",
        )

        # Act
        await handle_issues(payload, db)

        # Assert — issue row gone
        row = await _fetch_issue(db, "Roxabi/lyra#7")
        assert row is None, "Expected issue row to be deleted"

        # Assert — labels gone (cascade or explicit delete)
        labels = await _fetch_labels(db, "Roxabi/lyra#7")
        assert labels == [], f"Expected empty labels after delete, got {labels}"


# ---------------------------------------------------------------------------
# Helpers for edges / deps / sub_issues tests
# ---------------------------------------------------------------------------


def _make_issue_obj(repo: str, number: int) -> dict[str, Any]:
    """Minimal GitHub issue object with embedded repository."""
    repo_owner, repo_name = repo.split("/", 1) if "/" in repo else ("Roxabi", repo)
    return {
        "number": number,
        "title": f"Issue {number}",
        "state": "open",
        "html_url": f"https://github.com/{repo}/issues/{number}",
        "labels": [],
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-04-24T12:00:00Z",
        "closed_at": None,
        "repository": {
            "full_name": repo,
            "name": repo_name,
            "owner": {"login": repo_owner},
        },
    }


def _make_deps_payload(
    action: str,
    issue_repo: str = "Roxabi/lyra",
    issue_number: int = 10,
    blocking_repo: str = "Roxabi/lyra",
    blocking_number: int = 5,
) -> dict[str, Any]:
    """Build a minimal GitHub `issue_dependencies` webhook payload."""
    return {
        "action": action,
        "issue": _make_issue_obj(issue_repo, issue_number),
        "blocking_issue": _make_issue_obj(blocking_repo, blocking_number),
        "repository": {
            "full_name": issue_repo,
            "name": issue_repo.split("/", 1)[-1],
            "owner": {"login": issue_repo.split("/", 1)[0]},
        },
    }


def _make_sub_issues_payload(
    action: str,
    parent_repo: str = "Roxabi/lyra",
    parent_number: int = 1,
    child_repo: str = "Roxabi/lyra",
    child_number: int = 2,
) -> dict[str, Any]:
    """Build a minimal GitHub `sub_issues` webhook payload."""
    return {
        "action": action,
        "issue": _make_issue_obj(parent_repo, parent_number),
        "sub_issue": _make_issue_obj(child_repo, child_number),
        "repository": {
            "full_name": parent_repo,
            "name": parent_repo.split("/", 1)[-1],
            "owner": {"login": parent_repo.split("/", 1)[0]},
        },
    }


async def _fetch_edge(
    conn: aiosqlite.Connection, src_key: str, dst_key: str, kind: str
) -> aiosqlite.Row | None:
    cursor = await conn.execute(
        "SELECT src_key, dst_key, kind FROM edges"
        " WHERE src_key=? AND dst_key=? AND kind=?",
        (src_key, dst_key, kind),
    )
    return await cursor.fetchone()


async def _seed_edge(
    conn: aiosqlite.Connection, src_key: str, dst_key: str, kind: str
) -> None:
    await conn.execute(
        "INSERT OR IGNORE INTO edges (src_key, dst_key, kind) VALUES (?, ?, ?)",
        (src_key, dst_key, kind),
    )
    await conn.commit()


# ---------------------------------------------------------------------------
# Tests — handle_deps
# ---------------------------------------------------------------------------


class TestDepsWebhookHandler:
    """handle_deps() — GitHub issue_dependencies webhook event processing."""

    async def test_deps_blocked_by_added_inserts_edge(
        self, db: aiosqlite.Connection
    ) -> None:
        """blocked_by_added inserts edge (blocker→blocked, kind='blocks')."""
        payload = _make_deps_payload(
            action="blocked_by_added",
            issue_repo="Roxabi/lyra",
            issue_number=10,
            blocking_repo="Roxabi/lyra",
            blocking_number=5,
        )

        await handle_deps(payload, db)

        row = await _fetch_edge(db, "Roxabi/lyra#5", "Roxabi/lyra#10", "blocks")
        assert row is not None, "Expected edge (blocker→blocked, blocks) to be inserted"
        assert row == ("Roxabi/lyra#5", "Roxabi/lyra#10", "blocks")

    async def test_deps_blocked_by_removed_deletes_edge(
        self, db: aiosqlite.Connection
    ) -> None:
        """blocked_by_removed deletes the existing blocks edge."""
        await _seed_edge(db, "Roxabi/lyra#5", "Roxabi/lyra#10", "blocks")

        payload = _make_deps_payload(
            action="blocked_by_removed",
            issue_repo="Roxabi/lyra",
            issue_number=10,
            blocking_repo="Roxabi/lyra",
            blocking_number=5,
        )

        await handle_deps(payload, db)

        row = await _fetch_edge(db, "Roxabi/lyra#5", "Roxabi/lyra#10", "blocks")
        assert row is None, "Expected edge to be deleted after blocked_by_removed"

    async def test_deps_blocking_added_is_noop(self, db: aiosqlite.Connection) -> None:
        """blocking_added (duplicate-direction) is ignored — no edge inserted."""
        payload = _make_deps_payload(
            action="blocking_added",
            issue_repo="Roxabi/lyra",
            issue_number=5,
            blocking_repo="Roxabi/lyra",
            blocking_number=10,
        )

        await handle_deps(payload, db)

        # Neither direction should exist
        row_a = await _fetch_edge(db, "Roxabi/lyra#5", "Roxabi/lyra#10", "blocks")
        row_b = await _fetch_edge(db, "Roxabi/lyra#10", "Roxabi/lyra#5", "blocks")
        assert row_a is None and row_b is None, (
            "Expected no edge for blocking_added noop"
        )


# ---------------------------------------------------------------------------
# Tests — handle_sub_issues
# ---------------------------------------------------------------------------


class TestSubIssuesWebhookHandler:
    """handle_sub_issues() — GitHub sub_issues webhook event processing."""

    async def test_sub_issues_added_inserts_parent_edge(
        self, db: aiosqlite.Connection
    ) -> None:
        """sub_issue_added inserts edge (parent→child, kind='parent')."""
        payload = _make_sub_issues_payload(
            action="sub_issue_added",
            parent_repo="Roxabi/lyra",
            parent_number=1,
            child_repo="Roxabi/lyra",
            child_number=2,
        )

        await handle_sub_issues(payload, db)

        row = await _fetch_edge(db, "Roxabi/lyra#1", "Roxabi/lyra#2", "parent")
        assert row is not None, "Expected edge (parent→child, parent) to be inserted"
        assert row == ("Roxabi/lyra#1", "Roxabi/lyra#2", "parent")

    async def test_sub_issues_removed_deletes_edge(
        self, db: aiosqlite.Connection
    ) -> None:
        """sub_issue_removed deletes the existing parent edge."""
        await _seed_edge(db, "Roxabi/lyra#1", "Roxabi/lyra#2", "parent")

        payload = _make_sub_issues_payload(
            action="sub_issue_removed",
            parent_repo="Roxabi/lyra",
            parent_number=1,
            child_repo="Roxabi/lyra",
            child_number=2,
        )

        await handle_sub_issues(payload, db)

        row = await _fetch_edge(db, "Roxabi/lyra#1", "Roxabi/lyra#2", "parent")
        assert row is None, "Expected edge to be deleted after sub_issue_removed"

    async def test_sub_issues_parent_added_is_noop(
        self, db: aiosqlite.Connection
    ) -> None:
        """parent_issue_added (duplicate-direction) is ignored — no edge inserted."""
        payload = _make_sub_issues_payload(
            action="parent_issue_added",
            parent_repo="Roxabi/lyra",
            parent_number=1,
            child_repo="Roxabi/lyra",
            child_number=2,
        )

        await handle_sub_issues(payload, db)

        row_a = await _fetch_edge(db, "Roxabi/lyra#1", "Roxabi/lyra#2", "parent")
        row_b = await _fetch_edge(db, "Roxabi/lyra#2", "Roxabi/lyra#1", "parent")
        assert row_a is None and row_b is None, (
            "Expected no edge for parent_issue_added noop"
        )


# ---------------------------------------------------------------------------
# T8 [RED] — Transactional write tests (SC9)
# ---------------------------------------------------------------------------


class TestHandleIssuesTransaction:
    """handle_issues wraps writes in async with conn: (SC9)."""

    async def test_handle_issues_uses_transaction(
        self, db: aiosqlite.Connection
    ) -> None:
        """handle_issues completes atomically — issue + labels committed together.

        SC9: The handler must use async with conn: so that a crash mid-write
        rolls back the entire operation rather than leaving a partial state.
        This test verifies the happy path: both issue and labels are present
        after a successful call.
        """
        payload = _make_payload(
            action="opened",
            number=20,
            title="Transactional test",
            state="open",
            labels=["bug", "urgent"],
            repo="Roxabi/lyra",
        )

        await handle_issues(payload, db)

        # Verify issue row was committed
        row = await _fetch_issue(db, "Roxabi/lyra#20")
        assert row is not None, "Issue row must be committed after handle_issues"

        # Verify labels were committed
        labels = await _fetch_labels(db, "Roxabi/lyra#20")
        assert sorted(labels) == ["bug", "urgent"], (
            f"Labels must be committed together with issue: {labels}"
        )

    async def test_handle_issues_no_raw_sql_strings(self) -> None:
        """SC8: handlers.py must contain zero raw INSERT/UPDATE/DELETE SQL strings."""
        import pathlib

        handlers_src = (
            pathlib.Path(__file__).parent.parent
            / "src" / "roxabi_live" / "webhook" / "handlers.py"
        ).read_text()

        raw_sql_lines = [
            line.strip() for line in handlers_src.splitlines()
            if any(kw in line.upper() for kw in ("INSERT ", "UPDATE ", "DELETE "))
            and not line.strip().startswith("#")
        ]
        assert raw_sql_lines == [], (
            f"handlers.py contains raw SQL strings: {raw_sql_lines}"
        )
