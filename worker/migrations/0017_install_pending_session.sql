-- migration: 0017_install_pending_session.sql
-- Install-pending OAuth sessions (nullable tenant_id) + cached install targets on users.

PRAGMA foreign_keys = OFF;

CREATE TABLE sessions_new (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  tenant_id   INTEGER REFERENCES tenants(id),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sessions_new (id, user_id, tenant_id, token_hash, expires_at, revoked_at, created_at)
  SELECT id, user_id, tenant_id, token_hash, expires_at, revoked_at, created_at FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expires_at ON sessions(expires_at);

PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN install_targets_json TEXT;