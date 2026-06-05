-- migration: 0001_initial.sql
-- Applied via: wrangler d1 migrations apply DB [--env staging|production]

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repo_allowlist (
    repo TEXT PRIMARY KEY  -- "owner/name"
);

CREATE TABLE IF NOT EXISTS issues (
    key                 TEXT    PRIMARY KEY,
    repo                TEXT    NOT NULL,
    number              INTEGER NOT NULL,
    title               TEXT,
    state               TEXT    NOT NULL,
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
    repo                TEXT    NOT NULL,
    number              INTEGER NOT NULL,
    state               TEXT    NOT NULL,
    has_reviewed_label  INTEGER NOT NULL DEFAULT 0,
    closing_issue_keys  TEXT,
    updated_at          TEXT    NOT NULL,
    PRIMARY KEY (repo, number)
);

-- sync_control: reconciler state (replaces asyncio module-level vars)
CREATE TABLE IF NOT EXISTS sync_control (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO sync_control VALUES ('auth_failures',   '0', datetime('now'));
INSERT OR IGNORE INTO sync_control VALUES ('halted',          '0', datetime('now'));
INSERT OR IGNORE INTO sync_control VALUES ('sync_running',    '0', datetime('now'));
INSERT OR IGNORE INTO sync_control VALUES ('sync_started_at', '', datetime('now'));

-- Indices (mirror Python schema.py exactly)
CREATE INDEX IF NOT EXISTS ix_edges_dst        ON edges(dst_key);
CREATE INDEX IF NOT EXISTS ix_issues_repo_state ON issues(repo, state);
CREATE INDEX IF NOT EXISTS ix_labels_name       ON labels(name);
CREATE INDEX IF NOT EXISTS ix_pr_state_state    ON pr_state(state);
