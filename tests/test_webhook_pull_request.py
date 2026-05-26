"""Tests for handle_pull_request — T14 [RED-GATE].

Covers:
- action=opened with body "Closes #123" → pr_state row has closing_issue_keys
  containing 'Roxabi/lyra#123'
- action=labeled with 'reviewed' label → has_reviewed_label=1
- action=unlabeled with no 'reviewed' label remaining → has_reviewed_label=0
- action=closed with merged=true → state='closed'
- action=closed without merged → state='closed'
- action=reopened → state='open'
- multi-PR precedence: two PRs linking same issue — both rows stored
- various closing keyword variants: fixes, resolves, fixed, closed, etc.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import aiosqlite
import pytest

from roxabi_live.webhook.handlers import handle_pull_request

# ---------------------------------------------------------------------------
# Minimal schema — pr_state table only
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS pr_state (
    repo                TEXT NOT NULL,
    number              INTEGER NOT NULL,
    state               TEXT NOT NULL,
    has_reviewed_label  INTEGER NOT NULL DEFAULT 0,
    closing_issue_keys  TEXT,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (repo, number)
);
"""


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
async def db() -> AsyncIterator[aiosqlite.Connection]:
    """In-memory aiosqlite connection with pr_state schema."""
    conn = await aiosqlite.connect(":memory:")
    await conn.executescript(_SCHEMA_SQL)
    await conn.commit()
    yield conn
    await conn.close()


async def _fetch_pr_state(
    conn: aiosqlite.Connection, repo: str, number: int
) -> dict[str, Any] | None:
    """Return pr_state row as a dict or None."""
    cur = await conn.execute(
        "SELECT repo, number, state, has_reviewed_label, closing_issue_keys, updated_at"
        " FROM pr_state WHERE repo=? AND number=?",
        (repo, number),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    return {
        "repo": row[0],
        "number": row[1],
        "state": row[2],
        "has_reviewed_label": row[3],
        "closing_issue_keys": json.loads(row[4]) if row[4] else [],
        "updated_at": row[5],
    }


def _make_pr_payload(  # noqa: PLR0913
    action: str,
    number: int = 42,
    state: str = "open",
    merged: bool = False,
    labels: list[str] | None = None,
    body: str = "",
    repo: str = "Roxabi/lyra",
) -> dict[str, Any]:
    """Build a minimal GitHub pull_request webhook payload."""
    return {
        "action": action,
        "pull_request": {
            "number": number,
            "state": state,
            "merged": merged,
            "body": body,
            "labels": [{"name": lbl} for lbl in (labels or [])],
        },
        "repository": {
            "full_name": repo,
            "name": repo.split("/", 1)[-1],
            "owner": {"login": repo.split("/", 1)[0]},
        },
    }


# ---------------------------------------------------------------------------
# Tests — handle_pull_request
# ---------------------------------------------------------------------------


class TestHandlePullRequest:
    """handle_pull_request() — PR event processing and pr_state upsert."""

    async def test_opened_with_closes_body_stores_closing_keys(
        self, db: aiosqlite.Connection
    ) -> None:
        """opened with 'Closes #123' body sets closing_issue_keys."""
        payload = _make_pr_payload(
            action="opened",
            number=42,
            body="Closes #123\n\nSome description.",
            repo="Roxabi/lyra",
        )
        await handle_pull_request(payload, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None, "Expected pr_state row to be inserted"
        keys = row["closing_issue_keys"]
        assert "Roxabi/lyra#123" in keys, (
            f"Expected 'Roxabi/lyra#123' in closing_issue_keys, got {keys!r}"
        )

    async def test_labeled_with_reviewed_sets_flag(
        self, db: aiosqlite.Connection
    ) -> None:
        """action=labeled with 'reviewed' label → has_reviewed_label=1."""
        payload = _make_pr_payload(
            action="labeled",
            number=42,
            labels=["reviewed", "enhancement"],
        )
        await handle_pull_request(payload, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None
        assert row["has_reviewed_label"] == 1, (
            f"Expected has_reviewed_label=1, got {row['has_reviewed_label']!r}"
        )

    async def test_unlabeled_without_reviewed_clears_flag(
        self, db: aiosqlite.Connection
    ) -> None:
        """action=unlabeled, no 'reviewed' label remaining → has_reviewed_label=0."""
        # First: insert with reviewed label
        payload_labeled = _make_pr_payload(
            action="labeled",
            number=42,
            labels=["reviewed"],
        )
        await handle_pull_request(payload_labeled, db)

        # Then: unlabel — no 'reviewed' in remaining labels
        payload_unlabeled = _make_pr_payload(
            action="unlabeled",
            number=42,
            labels=["enhancement"],  # reviewed removed
        )
        await handle_pull_request(payload_unlabeled, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None
        flag = row["has_reviewed_label"]
        assert flag == 0, (
            f"Expected has_reviewed_label=0 after unlabel, got {flag!r}"
        )

    async def test_closed_with_merged_true_sets_closed(
        self, db: aiosqlite.Connection
    ) -> None:
        """action=closed with merged=true → state='closed'."""
        payload = _make_pr_payload(
            action="closed",
            number=42,
            state="closed",
            merged=True,
        )
        await handle_pull_request(payload, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None
        assert row["state"] == "closed", (
            f"Expected state='closed' for merged PR, got {row['state']!r}"
        )

    async def test_closed_without_merged_sets_closed(
        self, db: aiosqlite.Connection
    ) -> None:
        """action=closed without merged flag → state='closed'."""
        payload = _make_pr_payload(
            action="closed",
            number=42,
            state="closed",
            merged=False,
        )
        await handle_pull_request(payload, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None
        assert row["state"] == "closed", (
            f"Expected state='closed', got {row['state']!r}"
        )

    async def test_reopened_sets_open(self, db: aiosqlite.Connection) -> None:
        """action=reopened → state='open'."""
        # First close it
        await handle_pull_request(_make_pr_payload("closed", 42, state="closed"), db)
        # Then reopen
        await handle_pull_request(_make_pr_payload("reopened", 42, state="open"), db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None
        assert row["state"] == "open", (
            f"Expected state='open' after reopen, got {row['state']!r}"
        )

    async def test_upsert_is_idempotent(self, db: aiosqlite.Connection) -> None:
        """Calling handle_pull_request twice on same PR is idempotent — 1 row."""
        payload = _make_pr_payload("opened", 42, body="Closes #1")
        await handle_pull_request(payload, db)
        await handle_pull_request(payload, db)

        cur = await db.execute(
            "SELECT COUNT(*) FROM pr_state WHERE repo=? AND number=?",
            ("Roxabi/lyra", 42),
        )
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == 1, f"Expected exactly 1 row, got {row[0]}"

    async def test_various_closing_keywords(self, db: aiosqlite.Connection) -> None:
        """All closing keyword variants parse into closing_issue_keys."""
        body = (
            "fixes #10\nfixed #20\nresolve #30\nresolved #40\ncloses #50\nclose #60\n"
        )
        payload = _make_pr_payload("opened", 99, body=body)
        await handle_pull_request(payload, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 99)
        assert row is not None
        keys = row["closing_issue_keys"]
        expected = {
            "Roxabi/lyra#10",
            "Roxabi/lyra#20",
            "Roxabi/lyra#30",
            "Roxabi/lyra#40",
            "Roxabi/lyra#50",
            "Roxabi/lyra#60",
        }
        assert set(keys) == expected, (
            f"Expected closing keys {expected}, got {set(keys)!r}"
        )

    async def test_no_closing_keywords_stores_empty_list(
        self, db: aiosqlite.Connection
    ) -> None:
        """Body without closing keywords → closing_issue_keys=[]."""
        payload = _make_pr_payload(
            "opened", 42, body="This PR does stuff but doesn't close anything."
        )
        await handle_pull_request(payload, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None
        assert row["closing_issue_keys"] == [], (
            f"Expected empty list, got {row['closing_issue_keys']!r}"
        )

    async def test_reviewed_label_case_sensitive(
        self, db: aiosqlite.Connection
    ) -> None:
        """'Reviewed' (capital R) does NOT set has_reviewed_label — exact match only."""
        payload = _make_pr_payload("labeled", 42, labels=["Reviewed", "REVIEWED"])
        await handle_pull_request(payload, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None
        assert row["has_reviewed_label"] == 0, (
            "Expected case-sensitive match only — 'Reviewed' should not set flag"
        )

    async def test_multiple_prs_for_same_issue_stored_separately(
        self, db: aiosqlite.Connection
    ) -> None:
        """Two separate PRs can both link the same issue — stored as distinct rows."""
        payload_a = _make_pr_payload("opened", 10, body="Closes #100")
        payload_b = _make_pr_payload("opened", 11, body="Fixes #100")
        await handle_pull_request(payload_a, db)
        await handle_pull_request(payload_b, db)

        row_a = await _fetch_pr_state(db, "Roxabi/lyra", 10)
        row_b = await _fetch_pr_state(db, "Roxabi/lyra", 11)
        assert row_a is not None and row_b is not None
        assert "Roxabi/lyra#100" in row_a["closing_issue_keys"]
        assert "Roxabi/lyra#100" in row_b["closing_issue_keys"]

    async def test_synchronize_action_upserts_row(
        self, db: aiosqlite.Connection
    ) -> None:
        """action=synchronize (new commits pushed) upserts the pr_state row."""
        payload = _make_pr_payload("synchronize", 42, body="Closes #7")
        await handle_pull_request(payload, db)

        row = await _fetch_pr_state(db, "Roxabi/lyra", 42)
        assert row is not None, "Expected pr_state row for synchronize action"
        assert "Roxabi/lyra#7" in row["closing_issue_keys"]
