"""Tests for roxabi_live.corpus.schema — SQLite corpus DB bootstrap.

Tests verify that:
- bootstrap() is idempotent (safe to call twice on the same path).
- All expected tables and indexes are created: issues, labels, edges,
  sync_state, and the ix_edges_dst index.
- The issues table does NOT contain body or body_hash columns (explicitly
  excluded per spec to keep the corpus lean).

RED state: scripts/corpus/schema.py does not exist yet.  All tests will
fail with ModuleNotFoundError until the implementation lands in T2.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from roxabi_live.corpus.schema import SCHEMA_VERSION, bootstrap

# V2-era schema: issues table without the four projectV2 columns.
# Used to seed a pre-migration DB for migration tests.
_V2_SCHEMA_SQL = """
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
    is_stub     INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS sync_state (
    repo            TEXT PRIMARY KEY,
    last_cursor     TEXT,
    last_synced_at  TEXT
);

CREATE INDEX IF NOT EXISTS ix_edges_dst ON edges(dst_key);
CREATE INDEX IF NOT EXISTS ix_issues_repo_state ON issues(repo, state);
CREATE INDEX IF NOT EXISTS ix_labels_name ON labels(name);
"""


def test_bootstrap_idempotent(tmp_path: Path) -> None:
    """Calling bootstrap() twice on the same DB must not raise and must leave
    the expected tables and index in place."""
    # Arrange
    db_path = tmp_path / "corpus.db"

    # Act — first call creates the schema
    bootstrap(db_path)
    # Act — second call must be a no-op (idempotent)
    bootstrap(db_path)

    # Assert — expected tables exist
    con = sqlite3.connect(db_path)
    try:
        rows = con.execute(
            "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')"
        ).fetchall()
    finally:
        con.close()

    names_by_type: dict[str, set[str]] = {"table": set(), "index": set()}
    for name, kind in rows:
        names_by_type[kind].add(name)

    expected_tables = {"issues", "labels", "edges", "sync_state"}
    assert expected_tables <= names_by_type["table"], (
        f"Missing tables: {expected_tables - names_by_type['table']}"
    )

    assert "ix_edges_dst" in names_by_type["index"], (
        "Expected index ix_edges_dst not found in sqlite_master"
    )


def test_schema_has_no_body_column(tmp_path: Path) -> None:
    """The issues table must not contain a 'body' or 'body_hash' column.

    The spec explicitly excludes these to keep the corpus lean.
    """
    # Arrange
    db_path = tmp_path / "corpus.db"

    # Act
    bootstrap(db_path)

    # Assert
    con = sqlite3.connect(db_path)
    try:
        columns = {
            row[1] for row in con.execute("PRAGMA table_info(issues)").fetchall()
        }
    finally:
        con.close()

    assert "body" not in columns, (
        "Column 'body' found in issues table — spec says to drop it"
    )
    assert "body_hash" not in columns, (
        "Column 'body_hash' found in issues table — spec says to drop it"
    )


def test_migrate_adds_projectv2_columns(tmp_path: Path) -> None:
    """bootstrap() on a v2 DB adds lane/priority/size/status without error."""
    # Arrange — seed a v2-era DB (issues table without the four columns)
    db_path = tmp_path / "corpus.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_V2_SCHEMA_SQL)
    conn.close()

    # Act — bootstrap must apply migration 2
    bootstrap(db_path)

    # Assert — all four new columns exist
    conn = sqlite3.connect(db_path)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(issues)").fetchall()}
        user_version = conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()

    assert {"lane", "priority", "size", "status"} <= cols, (
        f"Missing projectV2 columns. Found: {cols}"
    )
    assert user_version == SCHEMA_VERSION, (
        f"Expected user_version={SCHEMA_VERSION}, got {user_version}"
    )


def test_migrate_idempotent_on_v3(tmp_path: Path) -> None:
    """Calling bootstrap() twice on a v3 DB is safe (duplicate column guard)."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)
    bootstrap(db_path)  # must not raise
