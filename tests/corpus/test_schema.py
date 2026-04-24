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


# V3-era edges DDL: PK on (src_key, dst_key) only. Used to seed a pre-v4 DB.
_V3_EDGES_SQL = """
CREATE TABLE edges (
    src_key     TEXT NOT NULL,
    dst_key     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'parent',
    PRIMARY KEY (src_key, dst_key)
);
CREATE INDEX ix_edges_dst ON edges(dst_key);
"""


def _edges_pk_columns(conn: sqlite3.Connection) -> list[str]:
    """Return PK column names for `edges`, ordered by PK position."""
    rows = conn.execute("PRAGMA table_info(edges)").fetchall()
    pk_rows = sorted((r for r in rows if r[5] > 0), key=lambda r: r[5])
    return [r[1] for r in pk_rows]


def test_fresh_edges_pk_has_kind(tmp_path: Path) -> None:
    """Fresh bootstrap must produce `edges` with PK (src_key, dst_key, kind)."""
    db_path = tmp_path / "corpus.db"
    bootstrap(db_path)

    conn = sqlite3.connect(db_path)
    try:
        assert _edges_pk_columns(conn) == ["src_key", "dst_key", "kind"]
    finally:
        conn.close()


def test_migration_v3_to_v4_preserves_edges(tmp_path: Path) -> None:
    """A v3 DB with edges migrates to v4 PK without losing rows."""
    db_path = tmp_path / "corpus.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_V3_EDGES_SQL)
    conn.executemany(
        "INSERT INTO edges (src_key, dst_key, kind) VALUES (?, ?, ?)",
        [
            ("A", "B", "parent"),
            ("B", "C", "parent"),
            ("X", "Y", "blocks"),
        ],
    )
    conn.execute("PRAGMA user_version = 3")
    conn.commit()
    conn.close()

    bootstrap(db_path)

    conn = sqlite3.connect(db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        rows = set(conn.execute("SELECT src_key, dst_key, kind FROM edges").fetchall())
        user_version = conn.execute("PRAGMA user_version").fetchone()[0]
        pk_cols = _edges_pk_columns(conn)
    finally:
        conn.close()

    assert count == 3
    assert rows == {
        ("A", "B", "parent"),
        ("B", "C", "parent"),
        ("X", "Y", "blocks"),
    }
    assert user_version == SCHEMA_VERSION
    assert pk_cols == ["src_key", "dst_key", "kind"]


def test_migration_v2_to_v4_upgrades_edges_pk_and_preserves_data(
    tmp_path: Path,
) -> None:
    """Full v2 -> v4 path: projectV2 columns added AND edges PK upgraded, rows kept."""
    db_path = tmp_path / "corpus.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_V2_SCHEMA_SQL)
    conn.executemany(
        "INSERT INTO edges (src_key, dst_key, kind) VALUES (?, ?, ?)",
        [("A", "B", "parent"), ("X", "Y", "blocks")],
    )
    conn.execute("PRAGMA user_version = 2")
    conn.commit()
    conn.close()

    bootstrap(db_path)

    conn = sqlite3.connect(db_path)
    try:
        issue_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(issues)").fetchall()
        }
        edge_rows = set(
            conn.execute("SELECT src_key, dst_key, kind FROM edges").fetchall()
        )
        pk_cols = _edges_pk_columns(conn)
        user_version = conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()

    assert {"lane", "priority", "size", "status"} <= issue_cols
    assert edge_rows == {("A", "B", "parent"), ("X", "Y", "blocks")}
    assert pk_cols == ["src_key", "dst_key", "kind"]
    assert user_version == SCHEMA_VERSION


def test_migration_v3_to_v4_idempotent(tmp_path: Path) -> None:
    """Running bootstrap twice on a v3 DB converges to the same v4 state."""
    db_path = tmp_path / "corpus.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_V3_EDGES_SQL)
    conn.execute(
        "INSERT INTO edges (src_key, dst_key, kind) VALUES ('A', 'B', 'parent')"
    )
    conn.execute("PRAGMA user_version = 3")
    conn.commit()
    conn.close()

    bootstrap(db_path)
    bootstrap(db_path)

    conn = sqlite3.connect(db_path)
    try:
        count = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        pk_cols = _edges_pk_columns(conn)
    finally:
        conn.close()

    assert count == 1
    assert pk_cols == ["src_key", "dst_key", "kind"]
