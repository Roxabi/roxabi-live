"""Corpus DB schema — SQLite bootstrap and helpers."""

from __future__ import annotations

import pathlib
import sqlite3

SCHEMA_VERSION = 6

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS repo_allowlist (
    repo TEXT PRIMARY KEY  -- "owner/name"
);

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

CREATE TABLE IF NOT EXISTS sync_state (
    repo            TEXT PRIMARY KEY,
    last_cursor     TEXT,
    last_synced_at  TEXT
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

CREATE INDEX IF NOT EXISTS ix_edges_dst ON edges(dst_key);
CREATE INDEX IF NOT EXISTS ix_issues_repo_state ON issues(repo, state);
CREATE INDEX IF NOT EXISTS ix_labels_name ON labels(name);
CREATE INDEX IF NOT EXISTS ix_pr_state_state ON pr_state(state);
"""


def _alter_column(conn: sqlite3.Connection, sql: str) -> None:
    """Execute an ALTER TABLE ADD COLUMN statement, ignoring duplicate-column errors."""
    try:
        conn.execute(sql)
        conn.commit()
    except sqlite3.OperationalError as exc:
        if "duplicate column" not in str(exc).lower():
            raise


def _edges_pk_includes_kind(conn: sqlite3.Connection) -> bool:
    """True when the live `edges` table PK already includes the `kind` column."""
    rows = conn.execute("PRAGMA table_info(edges)").fetchall()
    pk_cols = {r[1] for r in rows if r[5] > 0}
    return "kind" in pk_cols


def _migrate_edges_pk(conn: sqlite3.Connection) -> None:
    """Rebuild edges with PK (src_key, dst_key, kind). SQLite has no DROP CONSTRAINT.

    All statements run inside an explicit transaction so an interrupt between
    DROP and RENAME rolls back cleanly; `executescript` auto-commits per
    statement and cannot offer that guarantee.
    """
    if _edges_pk_includes_kind(conn):
        return
    try:
        conn.execute("BEGIN")
        conn.execute(
            """
            CREATE TABLE edges_new (
                src_key     TEXT NOT NULL,
                dst_key     TEXT NOT NULL,
                kind        TEXT NOT NULL DEFAULT 'parent',
                PRIMARY KEY (src_key, dst_key, kind)
            )
            """
        )
        conn.execute(
            "INSERT INTO edges_new (src_key, dst_key, kind) "
            "SELECT src_key, dst_key, kind FROM edges"
        )
        conn.execute("DROP TABLE edges")
        conn.execute("ALTER TABLE edges_new RENAME TO edges")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_edges_dst ON edges(dst_key)")
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _migrate(conn: sqlite3.Connection) -> None:
    """Apply incremental migrations to existing DBs."""
    # Migration 1 — edges.kind (SCHEMA_VERSION 1 -> 2)
    _alter_column(
        conn, "ALTER TABLE edges ADD COLUMN kind TEXT NOT NULL DEFAULT 'parent'"
    )

    # Migration 2 — projectV2 fields on issues (SCHEMA_VERSION 2 -> 3)
    # One call per column so a failure on column N is not swallowed by column N+1.
    _alter_column(conn, "ALTER TABLE issues ADD COLUMN lane TEXT")
    _alter_column(conn, "ALTER TABLE issues ADD COLUMN priority TEXT")
    _alter_column(conn, "ALTER TABLE issues ADD COLUMN size TEXT")
    _alter_column(conn, "ALTER TABLE issues ADD COLUMN status TEXT")

    # Migration 3 — edges PK includes `kind` (SCHEMA_VERSION 3 -> 4).
    # CREATE TABLE IF NOT EXISTS above cannot alter an existing PK.
    _migrate_edges_pk(conn)

    # Migration 4 — repo_allowlist (SCHEMA_VERSION 4 -> 5).
    # Seed from existing issues only if the allowlist is currently empty,
    # so existing DBs get their current repos on first upgrade (opt-in).
    # Fresh DBs start empty (allowlist table created above via SCHEMA_SQL).
    count = conn.execute("SELECT COUNT(*) FROM repo_allowlist").fetchone()[0]
    if count == 0:
        conn.execute(
            "INSERT OR IGNORE INTO repo_allowlist(repo)"
            " SELECT DISTINCT repo FROM issues"
        )
        conn.commit()

    # Migration 5 — branch/PR animation state (SCHEMA_VERSION 5 -> 6).
    # pr_state table is created above via SCHEMA_SQL (CREATE TABLE IF NOT EXISTS).
    # Only the issues column needs an explicit ALTER because the table already exists.
    _alter_column(
        conn,
        "ALTER TABLE issues ADD COLUMN has_active_branch INTEGER NOT NULL DEFAULT 0",
    )


def bootstrap(db_path: pathlib.Path) -> None:
    """Idempotent schema initialisation."""
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA_SQL)
        _migrate(conn)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.commit()
    finally:
        conn.close()


def connect(db_path: pathlib.Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn
