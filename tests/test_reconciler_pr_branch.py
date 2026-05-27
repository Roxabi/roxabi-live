"""Tests for reconciler.heal_pr_branch_state() — T18 [RED-GATE].

Covers:
- heal_pr_branch_state() calls sync_branches once per repo
- heal_pr_branch_state() calls sync_prs once per repo
- heal_pr_branch_state() with empty iterable → no calls, no error
- heal_pr_branch_state() corrects drift: has_active_branch updated after sync
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from roxabi_live.reconciler import heal_pr_branch_state

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS issues (
    key               TEXT PRIMARY KEY,
    repo              TEXT NOT NULL,
    number            INTEGER NOT NULL,
    title             TEXT NOT NULL DEFAULT '',
    state             TEXT NOT NULL DEFAULT 'open',
    url               TEXT NOT NULL DEFAULT '',
    created_at        TEXT,
    updated_at        TEXT,
    closed_at         TEXT,
    milestone         TEXT,
    is_stub           INTEGER NOT NULL DEFAULT 0,
    lane              TEXT,
    priority          TEXT,
    size              TEXT,
    status            TEXT,
    has_active_branch INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pr_state (
    repo                 TEXT NOT NULL,
    number               INTEGER NOT NULL,
    state                TEXT NOT NULL,
    has_reviewed_label   INTEGER NOT NULL DEFAULT 0,
    closing_issue_keys   TEXT,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (repo, number)
);
"""


def _setup_db(tmp_path: Path) -> Path:
    """Create a temp SQLite DB with minimal schema; return its path."""
    db_path = tmp_path / "corpus.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(_SCHEMA_SQL)
    conn.close()
    return db_path


def _insert_issue(
    db_path: Path,
    *,
    key: str = "Roxabi/lyra#1",
    repo: str = "Roxabi/lyra",
    number: int = 1,
    has_active_branch: int = 0,
) -> None:
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "INSERT INTO issues (key, repo, number, has_active_branch) VALUES (?, ?, ?, ?)",
        (key, repo, number, has_active_branch),
    )
    conn.commit()
    conn.close()


def _read_has_active_branch(db_path: Path, key: str) -> int | None:
    """Read has_active_branch for the given issue key from the DB file."""
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT has_active_branch FROM issues WHERE key=?", (key,)
    ).fetchone()
    conn.close()
    return int(row[0]) if row is not None else None


# ---------------------------------------------------------------------------
# T18-1: sync_branches called once per repo
# ---------------------------------------------------------------------------


class TestHealCallsSyncBranches:
    """heal_pr_branch_state calls sync_branches exactly once per repo."""

    @pytest.mark.asyncio
    async def test_sync_branches_called_once_per_repo(self, tmp_path: Path) -> None:
        db_path = _setup_db(tmp_path)
        repos = ["Roxabi/lyra", "Roxabi/roxabi-live"]

        mock_sync_branches = MagicMock()
        mock_sync_prs = MagicMock()

        with (
            patch("roxabi_live.corpus.sync.sync_branches", mock_sync_branches),
            patch("roxabi_live.corpus.sync.sync_prs", mock_sync_prs),
        ):
            await heal_pr_branch_state(db_path, repos)

        assert mock_sync_branches.call_count == 2
        actual_repos = [c.args[0] for c in mock_sync_branches.call_args_list]
        assert actual_repos == repos

    @pytest.mark.asyncio
    async def test_sync_branches_receives_a_sqlite_connection(
        self, tmp_path: Path
    ) -> None:
        """sync_branches must be called with a sqlite3.Connection as second arg."""
        db_path = _setup_db(tmp_path)
        captured: list[sqlite3.Connection] = []

        def _capture(repo: str, conn: sqlite3.Connection) -> None:
            captured.append(conn)

        mock_sync_prs = MagicMock()

        with (
            patch("roxabi_live.corpus.sync.sync_branches", side_effect=_capture),
            patch("roxabi_live.corpus.sync.sync_prs", mock_sync_prs),
        ):
            await heal_pr_branch_state(db_path, ["Roxabi/lyra"])

        assert len(captured) == 1
        assert isinstance(captured[0], sqlite3.Connection)


# ---------------------------------------------------------------------------
# T18-2: sync_prs called once per repo
# ---------------------------------------------------------------------------


class TestHealCallsSyncPrs:
    """heal_pr_branch_state calls sync_prs exactly once per repo."""

    @pytest.mark.asyncio
    async def test_sync_prs_called_once_per_repo(self, tmp_path: Path) -> None:
        db_path = _setup_db(tmp_path)
        repos = ["Roxabi/lyra", "Roxabi/roxabi-live"]

        mock_sync_branches = MagicMock()
        mock_sync_prs = MagicMock()

        with (
            patch("roxabi_live.corpus.sync.sync_branches", mock_sync_branches),
            patch("roxabi_live.corpus.sync.sync_prs", mock_sync_prs),
        ):
            await heal_pr_branch_state(db_path, repos)

        assert mock_sync_prs.call_count == 2
        actual_repos = [c.args[0] for c in mock_sync_prs.call_args_list]
        assert actual_repos == repos

    @pytest.mark.asyncio
    async def test_sync_prs_receives_a_sqlite_connection(self, tmp_path: Path) -> None:
        """sync_prs must be called with a sqlite3.Connection as second arg."""
        db_path = _setup_db(tmp_path)
        captured: list[sqlite3.Connection] = []

        def _capture(repo: str, conn: sqlite3.Connection) -> None:
            captured.append(conn)

        mock_sync_branches = MagicMock()

        with (
            patch("roxabi_live.corpus.sync.sync_branches", mock_sync_branches),
            patch("roxabi_live.corpus.sync.sync_prs", side_effect=_capture),
        ):
            await heal_pr_branch_state(db_path, ["Roxabi/lyra"])

        assert len(captured) == 1
        assert isinstance(captured[0], sqlite3.Connection)

    @pytest.mark.asyncio
    async def test_sync_prs_called_after_sync_branches(self, tmp_path: Path) -> None:
        """For each repo, sync_branches must be called before sync_prs."""
        db_path = _setup_db(tmp_path)
        call_log: list[str] = []

        def _branches(repo: str, c: sqlite3.Connection) -> None:
            call_log.append(f"branches:{repo}")

        def _prs(repo: str, c: sqlite3.Connection) -> None:
            call_log.append(f"prs:{repo}")

        with (
            patch("roxabi_live.corpus.sync.sync_branches", side_effect=_branches),
            patch("roxabi_live.corpus.sync.sync_prs", side_effect=_prs),
        ):
            await heal_pr_branch_state(db_path, ["Roxabi/lyra", "Roxabi/roxabi-live"])

        assert call_log == [
            "branches:Roxabi/lyra",
            "prs:Roxabi/lyra",
            "branches:Roxabi/roxabi-live",
            "prs:Roxabi/roxabi-live",
        ]


# ---------------------------------------------------------------------------
# T18-3: empty iterable → no calls, no error
# ---------------------------------------------------------------------------


class TestHealEmptyIterable:
    """heal_pr_branch_state with empty iterable is a no-op."""

    @pytest.mark.asyncio
    async def test_empty_repos_no_calls(self, tmp_path: Path) -> None:
        db_path = _setup_db(tmp_path)

        mock_sync_branches = MagicMock()
        mock_sync_prs = MagicMock()

        with (
            patch("roxabi_live.corpus.sync.sync_branches", mock_sync_branches),
            patch("roxabi_live.corpus.sync.sync_prs", mock_sync_prs),
        ):
            await heal_pr_branch_state(db_path, [])

        mock_sync_branches.assert_not_called()
        mock_sync_prs.assert_not_called()

    @pytest.mark.asyncio
    async def test_empty_repos_does_not_raise(self, tmp_path: Path) -> None:
        """An empty iterable must complete without any exception."""
        db_path = _setup_db(tmp_path)
        # No mocks needed — no sync calls expected, no network hit
        await heal_pr_branch_state(db_path, [])


# ---------------------------------------------------------------------------
# T18-4: drift correction — has_active_branch updated after heal
# ---------------------------------------------------------------------------


class TestHealCorrectsDrift:
    """heal_pr_branch_state corrects has_active_branch drift in the DB."""

    @pytest.mark.asyncio
    async def test_heal_flips_has_active_branch_from_0_to_1(
        self, tmp_path: Path
    ) -> None:
        """After heal, has_active_branch=0 gets corrected to 1.

        The mock sync_branches receives the thread-local connection and writes
        directly to the DB as the real impl would.
        """
        db_path = _setup_db(tmp_path)
        _insert_issue(
            db_path,
            key="Roxabi/lyra#42",
            repo="Roxabi/lyra",
            number=42,
            has_active_branch=0,
        )

        def _fake_sync_branches(repo: str, conn: sqlite3.Connection) -> None:
            # Simulate real sync_branches finding branch feat/42-my-feature
            conn.execute(
                "UPDATE issues SET has_active_branch=1 WHERE repo=? AND number=42",
                (repo,),
            )
            conn.commit()

        mock_sync_prs = MagicMock()

        with (
            patch(
                "roxabi_live.corpus.sync.sync_branches",
                side_effect=_fake_sync_branches,
            ),
            patch("roxabi_live.corpus.sync.sync_prs", mock_sync_prs),
        ):
            await heal_pr_branch_state(db_path, ["Roxabi/lyra"])

        # Re-open fresh connection in test thread to verify persisted result
        result = _read_has_active_branch(db_path, "Roxabi/lyra#42")
        assert result == 1, f"Expected has_active_branch=1 after heal, got {result}"

    @pytest.mark.asyncio
    async def test_heal_flips_has_active_branch_from_1_to_0(
        self, tmp_path: Path
    ) -> None:
        """After heal, has_active_branch=1 gets corrected to 0 when branch deleted."""
        db_path = _setup_db(tmp_path)
        _insert_issue(
            db_path,
            key="Roxabi/lyra#7",
            repo="Roxabi/lyra",
            number=7,
            has_active_branch=1,
        )

        def _fake_sync_branches(repo: str, conn: sqlite3.Connection) -> None:
            # Simulate real sync_branches finding no matching branches
            conn.execute(
                "UPDATE issues SET has_active_branch=0 WHERE repo=?",
                (repo,),
            )
            conn.commit()

        mock_sync_prs = MagicMock()

        with (
            patch(
                "roxabi_live.corpus.sync.sync_branches",
                side_effect=_fake_sync_branches,
            ),
            patch("roxabi_live.corpus.sync.sync_prs", mock_sync_prs),
        ):
            await heal_pr_branch_state(db_path, ["Roxabi/lyra"])

        result = _read_has_active_branch(db_path, "Roxabi/lyra#7")
        assert result == 0, (
            f"Expected has_active_branch=0 after heal (branch deleted), got {result}"
        )
