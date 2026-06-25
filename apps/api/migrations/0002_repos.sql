-- migration: 0002_repos.sql
-- Applied via: wrangler d1 execute <DB> --config ../wrangler.toml --remote --file=worker/migrations/0002_repos.sql

-- D1 runs in WAL mode natively; `PRAGMA journal_mode` is rejected at
-- `wrangler d1 migrations apply` time, so it must not appear here.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
    repo     TEXT PRIMARY KEY,  -- e.g. 'Roxabi/voiceCLI'
    archived INTEGER NOT NULL DEFAULT 0
);
