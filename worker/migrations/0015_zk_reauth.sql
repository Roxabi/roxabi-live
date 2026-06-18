-- migration: 0015_zk_reauth.sql
-- OAuth step-up re-auth proofs for zk_key_backups UPDATE (#216 PR 2).

ALTER TABLE oauth_state ADD COLUMN reauth INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS zk_reauth_proofs (
  code       TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_zk_reauth_proofs_user_id ON zk_reauth_proofs(user_id);
CREATE INDEX IF NOT EXISTS ix_zk_reauth_proofs_expires_at ON zk_reauth_proofs(expires_at);