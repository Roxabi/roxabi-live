"""Tests for corpus schema migration idempotency — T4 [RED-GATE].

Covers:
- Fresh DB has has_active_branch column (default 0) + pr_state table + index
- Running bootstrap() twice raises no exceptions (idempotent)
- pr_state primary key constraint rejects duplicate (repo, number)
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import TypedDict

import pytest

from roxabi_live.corpus.schema import bootstrap

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _ColInfo(TypedDict):
    type: str
    notnull: int
    dflt_value: str | None
    pk: int


class _ColExpect(TypedDict):
    type: str
    notnull: int


def _table_columns(conn: sqlite3.Connection, table: str) -> dict[str, _ColInfo]:
    """Return column metadata keyed by name from PRAGMA table_info."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    # row: (cid, name, type, notnull, dflt_value, pk)
    return {
        r[1]: _ColInfo(type=r[2], notnull=r[3], dflt_value=r[4], pk=r[5]) for r in rows
    }


def _index_names(conn: sqlite3.Connection, table: str) -> set[str]:
    """Return the set of index names defined on *table*."""
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?", (table,)
    ).fetchall()
    return {r[0] for r in rows}


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return bool(row and row[0])


# ---------------------------------------------------------------------------
# Tests — fresh DB schema
# ---------------------------------------------------------------------------


class TestFreshSchemaContents:
    """After bootstrap() on a fresh DB the expected objects must be present."""

    def test_issues_has_active_branch_column_exists(self, tmp_path: Path) -> None:
        """issues.has_active_branch column is created with NOT NULL DEFAULT 0."""
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)

        conn = sqlite3.connect(db_path)
        try:
            cols = _table_columns(conn, "issues")
        finally:
            conn.close()

        assert "has_active_branch" in cols, (
            "Column has_active_branch missing from issues"
        )
        col = cols["has_active_branch"]
        assert col["type"].upper() == "INTEGER", (
            f"Expected INTEGER, got {col['type']!r}"
        )
        assert col["notnull"] == 1, "has_active_branch must be NOT NULL"
        assert col["dflt_value"] == "0", f"Default must be 0, got {col['dflt_value']!r}"

    def test_pr_state_table_exists(self, tmp_path: Path) -> None:
        """pr_state table is created by bootstrap()."""
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)

        conn = sqlite3.connect(db_path)
        try:
            exists = _table_exists(conn, "pr_state")
        finally:
            conn.close()

        assert exists, "pr_state table not found in schema"

    def test_pr_state_columns(self, tmp_path: Path) -> None:
        """pr_state has the expected columns with correct constraints."""
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)

        conn = sqlite3.connect(db_path)
        try:
            cols = _table_columns(conn, "pr_state")
        finally:
            conn.close()

        expected: dict[str, _ColExpect] = {
            "repo": {"type": "TEXT", "notnull": 1},
            "number": {"type": "INTEGER", "notnull": 1},
            "state": {"type": "TEXT", "notnull": 1},
            "has_reviewed_label": {"type": "INTEGER", "notnull": 1},
            "closing_issue_keys": {"type": "TEXT", "notnull": 0},
            "updated_at": {"type": "TEXT", "notnull": 1},
        }
        for name, constraints in expected.items():
            assert name in cols, f"Column {name!r} missing from pr_state"
            col = cols[name]
            exp_type: str = constraints["type"]
            got_type: str = col["type"]
            assert got_type.upper() == exp_type.upper(), (
                f"pr_state.{name}: expected type {exp_type!r}, got {got_type!r}"
            )
            exp_nn: int = constraints["notnull"]
            got_nn: int = col["notnull"]
            assert got_nn == exp_nn, (
                f"pr_state.{name}: notnull={got_nn}, expected {exp_nn}"
            )

    def test_ix_pr_state_state_index_exists(self, tmp_path: Path) -> None:
        """ix_pr_state_state index is present on pr_state table."""
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)

        conn = sqlite3.connect(db_path)
        try:
            indexes = _index_names(conn, "pr_state")
        finally:
            conn.close()

        assert "ix_pr_state_state" in indexes, (
            f"ix_pr_state_state not found; indexes on pr_state: {indexes}"
        )


# ---------------------------------------------------------------------------
# Tests — idempotency
# ---------------------------------------------------------------------------


class TestBootstrapIdempotency:
    """Calling bootstrap() multiple times on the same DB must not raise."""

    def test_double_bootstrap_no_exception(self, tmp_path: Path) -> None:
        """Running bootstrap() twice on the same DB raises no exception."""
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)
        # Second call must be a no-op (all CREATE IF NOT EXISTS + _alter_column guard)
        bootstrap(db_path)

    def test_double_bootstrap_column_unchanged(self, tmp_path: Path) -> None:
        """Column metadata is identical after a second bootstrap() call."""
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)

        conn = sqlite3.connect(db_path)
        cols_before = _table_columns(conn, "issues")
        conn.close()

        bootstrap(db_path)

        conn = sqlite3.connect(db_path)
        cols_after = _table_columns(conn, "issues")
        conn.close()

        assert cols_before == cols_after, (
            "Column metadata changed after second bootstrap()"
        )


# ---------------------------------------------------------------------------
# Tests — pr_state constraints
# ---------------------------------------------------------------------------


class TestPrStateConstraints:
    """pr_state table enforces its primary key."""

    def test_insert_pr_state_row(self, tmp_path: Path) -> None:
        """A valid pr_state row can be inserted."""
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)

        conn = sqlite3.connect(db_path)
        try:
            conn.execute(
                "INSERT INTO pr_state (repo, number, state, updated_at)"
                " VALUES (?, ?, ?, ?)",
                ("Roxabi/lyra", 42, "open", "2026-05-26T00:00:00Z"),
            )
            conn.commit()
            row = conn.execute(
                "SELECT repo, number, state FROM pr_state WHERE repo=? AND number=?",
                ("Roxabi/lyra", 42),
            ).fetchone()
        finally:
            conn.close()

        assert row == ("Roxabi/lyra", 42, "open")

    def test_duplicate_pk_raises_integrity_error(self, tmp_path: Path) -> None:
        """Inserting a duplicate (repo, number) raises IntegrityError."""
        db_path = tmp_path / "corpus.db"
        bootstrap(db_path)

        conn = sqlite3.connect(db_path)
        try:
            conn.execute(
                "INSERT INTO pr_state (repo, number, state, updated_at)"
                " VALUES (?, ?, ?, ?)",
                ("Roxabi/lyra", 42, "open", "2026-05-26T00:00:00Z"),
            )
            conn.commit()

            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO pr_state (repo, number, state, updated_at)"
                    " VALUES (?, ?, ?, ?)",
                    ("Roxabi/lyra", 42, "closed", "2026-05-26T01:00:00Z"),
                )
                conn.commit()
        finally:
            conn.close()
