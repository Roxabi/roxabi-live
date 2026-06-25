-- migration: 0014_zk_key_backups.sql
-- Passphrase-wrapped accountKey backup per user (#216 PR 1).
-- pubkey_fp → key_fp transition: dual-write period until 0017 drops pubkey_fp.

CREATE TABLE IF NOT EXISTS zk_key_backups (
  user_id        INTEGER NOT NULL REFERENCES users(id) PRIMARY KEY,
  backup_version INTEGER NOT NULL DEFAULT 1,
  kdf_alg        TEXT NOT NULL DEFAULT 'argon2id',
  kdf_params     TEXT NOT NULL,
  wrap_iv        TEXT NOT NULL,
  wrapped_key    TEXT NOT NULL,
  key_fp         TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE zk_payloads ADD COLUMN key_fp TEXT;

UPDATE zk_payloads
SET key_fp = pubkey_fp
WHERE key_fp IS NULL AND pubkey_fp IS NOT NULL;