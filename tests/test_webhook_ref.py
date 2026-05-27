"""Tests for handle_ref_create and handle_ref_delete — T14 [RED-GATE].

Covers:
- handle_ref_create: branch matching BRANCH_ISSUE_RE sets has_active_branch=1
- handle_ref_create: dependabot/... branch is a no-op (regex non-match)
- handle_ref_create: ref_type=tag is a no-op
- handle_ref_delete: regex-matching branch triggers sync_branches call with
  correct repo argument (mocked to assert call, not test network I/O)
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiosqlite
import pytest

from roxabi_live.corpus.schema import bootstrap
from roxabi_live.webhook.handlers import handle_ref_create, handle_ref_delete

# ---------------------------------------------------------------------------
# Minimal schema SQL — issues table only (no labels/edges needed here)
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS issues (
    key                 TEXT PRIMARY KEY,
    repo                TEXT NOT NULL,
    number              INTEGER NOT NULL,
    title               TEXT,
    state               TEXT NOT NULL DEFAULT 'open',
    url                 TEXT,
    created_at          TEXT,
    updated_at          TEXT,
    closed_at           TEXT,
    milestone           TEXT,
    is_stub             INTEGER NOT NULL DEFAULT 0,
    lane                TEXT,
    priority            TEXT,
    size                TEXT,
    status              TEXT,
    has_active_branch   INTEGER NOT NULL DEFAULT 0
);
"""


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
async def db() -> AsyncIterator[aiosqlite.Connection]:
    """In-memory aiosqlite connection with issues schema."""
    conn = await aiosqlite.connect(":memory:")
    await conn.executescript(_SCHEMA_SQL)
    await conn.commit()
    yield conn
    await conn.close()


@pytest.fixture()
def tmp_db(tmp_path: Path) -> Path:
    """On-disk DB bootstrapped with full schema, returns the path."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    return db_path


async def _seed_issue(
    conn: aiosqlite.Connection,
    key: str,
    repo: str,
    number: int,
    has_active_branch: int = 0,
) -> None:
    await conn.execute(
        "INSERT INTO issues (key, repo, number, state, has_active_branch)"
        " VALUES (?, ?, ?, 'open', ?)",
        (key, repo, number, has_active_branch),
    )
    await conn.commit()


async def _get_has_active_branch(conn: aiosqlite.Connection, key: str) -> int | None:
    cur = await conn.execute("SELECT has_active_branch FROM issues WHERE key=?", (key,))
    row = await cur.fetchone()
    return row[0] if row is not None else None


def _make_ref_payload(
    ref: str,
    ref_type: str = "branch",
    repo: str = "Roxabi/lyra",
) -> dict[str, Any]:
    """Build a minimal GitHub create/delete ref webhook payload."""
    return {
        "ref": ref,
        "ref_type": ref_type,
        "repository": {
            "full_name": repo,
            "name": repo.split("/", 1)[-1],
            "owner": {"login": repo.split("/", 1)[0]},
        },
    }


# ---------------------------------------------------------------------------
# Tests — handle_ref_create
# ---------------------------------------------------------------------------


class TestHandleRefCreate:
    """handle_ref_create() — branch creation sets has_active_branch."""

    async def test_matching_branch_sets_active_flag(
        self, db: aiosqlite.Connection
    ) -> None:
        """Branch feat/123-foo matches BRANCH_ISSUE_RE → issue 123 gets flag=1."""
        await _seed_issue(db, "Roxabi/lyra#123", "Roxabi/lyra", 123)

        payload = _make_ref_payload(ref="feat/123-foo", ref_type="branch")
        await handle_ref_create(payload, db)

        flag = await _get_has_active_branch(db, "Roxabi/lyra#123")
        assert flag == 1, f"Expected has_active_branch=1, got {flag!r}"

    async def test_bare_number_branch_sets_active_flag(
        self, db: aiosqlite.Connection
    ) -> None:
        """Branch 456-slug (no prefix) also matches → issue 456 gets flag=1."""
        await _seed_issue(db, "Roxabi/lyra#456", "Roxabi/lyra", 456)

        payload = _make_ref_payload(ref="456-my-feature", ref_type="branch")
        await handle_ref_create(payload, db)

        flag = await _get_has_active_branch(db, "Roxabi/lyra#456")
        assert flag == 1, f"Expected has_active_branch=1, got {flag!r}"

    async def test_dependabot_branch_is_noop(self, db: aiosqlite.Connection) -> None:
        """dependabot/... branch does not match BRANCH_ISSUE_RE → no-op."""
        await _seed_issue(db, "Roxabi/lyra#1", "Roxabi/lyra", 1)

        payload = _make_ref_payload(ref="dependabot/npm_and_yarn/lodash-4.17.21")
        await handle_ref_create(payload, db)

        # Flag should remain 0 (no change)
        flag = await _get_has_active_branch(db, "Roxabi/lyra#1")
        assert flag == 0, f"Expected no-op (flag=0), got {flag!r}"

    async def test_ref_type_tag_is_noop(self, db: aiosqlite.Connection) -> None:
        """ref_type=tag is immediately returned — no DB writes."""
        await _seed_issue(db, "Roxabi/lyra#123", "Roxabi/lyra", 123)

        payload = _make_ref_payload(ref="feat/123-foo", ref_type="tag")
        await handle_ref_create(payload, db)

        # Flag must remain 0 — tag events are ignored
        flag = await _get_has_active_branch(db, "Roxabi/lyra#123")
        assert flag == 0, f"Expected no-op for tag (flag=0), got {flag!r}"

    async def test_release_please_branch_is_noop(
        self, db: aiosqlite.Connection
    ) -> None:
        """release-please--... branch does not match → no-op."""
        await _seed_issue(db, "Roxabi/lyra#1", "Roxabi/lyra", 1)

        payload = _make_ref_payload(ref="release-please--branches--main")
        await handle_ref_create(payload, db)

        flag = await _get_has_active_branch(db, "Roxabi/lyra#1")
        assert flag == 0, f"Expected no-op (flag=0), got {flag!r}"


# ---------------------------------------------------------------------------
# Tests — handle_ref_delete
# ---------------------------------------------------------------------------


class TestHandleRefDelete:
    """handle_ref_delete() — branch deletion triggers sync_branches re-scan."""

    async def test_matching_branch_delete_calls_sync_branches(
        self,
        db: aiosqlite.Connection,
        monkeypatch: pytest.MonkeyPatch,
        tmp_db: Path,
    ) -> None:
        """Deleting feat/123-foo triggers sync_branches(repo, ...) call."""
        called_with: list[str] = []

        def _mock_sync_branches(repo: str, conn: Any) -> None:  # noqa: ANN401
            called_with.append(repo)

        monkeypatch.setattr(
            "roxabi_live.webhook.handlers.sync_branches", _mock_sync_branches
        )

        payload = _make_ref_payload(ref="feat/123-foo", ref_type="branch")
        await handle_ref_delete(payload, db, db_path=tmp_db)

        assert called_with == ["Roxabi/lyra"], (
            f"Expected sync_branches called with 'Roxabi/lyra', got {called_with!r}"
        )

    async def test_non_matching_branch_delete_does_not_call_sync(
        self,
        db: aiosqlite.Connection,
        monkeypatch: pytest.MonkeyPatch,
        tmp_db: Path,
    ) -> None:
        """Deleting dependabot/... does not trigger sync_branches."""
        called_with: list[str] = []

        def _mock_sync_branches(repo: str, conn: Any) -> None:  # noqa: ANN401
            called_with.append(repo)

        monkeypatch.setattr(
            "roxabi_live.webhook.handlers.sync_branches", _mock_sync_branches
        )

        payload = _make_ref_payload(ref="dependabot/npm/lodash", ref_type="branch")
        await handle_ref_delete(payload, db, db_path=tmp_db)

        assert called_with == [], (
            f"Expected sync_branches NOT called for dependabot branch, "
            f"got {called_with!r}"
        )

    async def test_tag_delete_is_noop(
        self,
        db: aiosqlite.Connection,
        monkeypatch: pytest.MonkeyPatch,
        tmp_db: Path,
    ) -> None:
        """ref_type=tag delete event is ignored — no sync_branches call."""
        called_with: list[str] = []

        def _mock_sync_branches(repo: str, conn: Any) -> None:  # noqa: ANN401
            called_with.append(repo)

        monkeypatch.setattr(
            "roxabi_live.webhook.handlers.sync_branches", _mock_sync_branches
        )

        payload = _make_ref_payload(ref="feat/123-foo", ref_type="tag")
        await handle_ref_delete(payload, db, db_path=tmp_db)

        assert called_with == [], "Expected no sync_branches call for tag delete"

    async def test_delete_without_db_path_warns_and_calls_sync(
        self,
        db: aiosqlite.Connection,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """When db_path=None, a warning is logged and sync_branches is still called
        (via the fallback path) so tests that mock it can assert the call.
        """
        import logging

        called_with: list[str] = []

        def _mock_sync_branches(repo: str, conn: Any) -> None:  # noqa: ANN401
            called_with.append(repo)

        monkeypatch.setattr(
            "roxabi_live.webhook.handlers.sync_branches", _mock_sync_branches
        )

        payload = _make_ref_payload(ref="fix/789-something", ref_type="branch")
        with caplog.at_level(logging.WARNING, logger="roxabi_live.webhook.handlers"):
            await handle_ref_delete(payload, db, db_path=None)

        assert any("db_path not provided" in rec.message for rec in caplog.records), (
            "Expected a warning log when db_path is None"
        )
        assert "Roxabi/lyra" in called_with, (
            "Expected sync_branches still called in fallback path"
        )
