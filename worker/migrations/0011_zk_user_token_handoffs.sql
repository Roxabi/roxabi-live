-- migration: 0011_zk_user_token_handoffs.sql
-- Ephemeral OAuth user-token handoff for ZK client fetch (#142 S3).
-- Tokens are AES-GCM encrypted at rest for ≤5 minutes, single-use consume.

ALTER TABLE oauth_state ADD COLUMN zk_token_handoff INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_token_handoffs (
  code       TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_enc  TEXT NOT NULL,
  token_iv   TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_user_token_handoffs_user_id ON user_token_handoffs(user_id);
CREATE INDEX IF NOT EXISTS ix_user_token_handoffs_expires_at ON user_token_handoffs(expires_at);