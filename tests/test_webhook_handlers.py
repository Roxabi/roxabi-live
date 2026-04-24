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

from pathlib import Path
from typing import Any

import aiosqlite
import pytest

from roxabi_live.webhook.handlers import handle_issues  # expected ImportError in RED

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
"""

# ---------------------------------------------------------------------------
# Payload helpers
# ---------------------------------------------------------------------------


def _make_payload(
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
async def db(tmp_path: Path) -> aiosqlite.Connection:
    """In-memory aiosqlite connection with issues + labels schema."""
    conn = await aiosqlite.connect(":memory:")
    await conn.executescript(_SCHEMA_SQL)
    await conn.execute("PRAGMA foreign_keys = ON")
    await conn.commit()
    yield conn
    await conn.close()


async def _seed_issue(
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


async def _fetch_issue(
    conn: aiosqlite.Connection, key: str
) -> tuple[Any, ...] | None:
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

    async def test_issues_closed_updates_state(
        self, db: aiosqlite.Connection
    ) -> None:
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

    async def test_issues_edited_updates_title(
        self, db: aiosqlite.Connection
    ) -> None:
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

    async def test_issues_deleted_removes_row(
        self, db: aiosqlite.Connection
    ) -> None:
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
