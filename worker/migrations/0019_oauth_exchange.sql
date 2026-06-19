-- migration: 0019_oauth_exchange.sql
-- One-time OAuth session handoff — Set-Cookie on GET /auth/exchange (no JS cookie race).

CREATE TABLE IF NOT EXISTS oauth_exchange (
  code           TEXT PRIMARY KEY,
  session_token  TEXT NOT NULL,
  redirect_after TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_oauth_exchange_expires_at ON oauth_exchange(expires_at);