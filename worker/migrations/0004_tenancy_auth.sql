-- migration: 0004_tenancy_auth.sql
-- Applied via: wrangler d1 migrations apply DB [--env staging] --remote

-- D1 runs in WAL mode natively; `PRAGMA journal_mode` is rejected at
-- `wrangler d1 migrations apply` time, so it must not appear here.
PRAGMA foreign_keys = ON;

-- tenants: one row per GitHub App installation
CREATE TABLE IF NOT EXISTS tenants (
  id              INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login   TEXT NOT NULL,
  account_type    TEXT NOT NULL CHECK(account_type IN ('User','Organization')),
  suspended_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- users: one row per GitHub user who has authorized the App
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  github_id    INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- user_installations: which users belong to which tenant
CREATE TABLE IF NOT EXISTS user_installations (
  user_id   INTEGER NOT NULL REFERENCES users(id),
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  PRIMARY KEY (user_id, tenant_id)
);

-- sessions: D1 (not KV) for strongly-consistent revocation
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- oauth_state: single-use PKCE-like state for OAuth flow
CREATE TABLE IF NOT EXISTS oauth_state (
  state          TEXT PRIMARY KEY,
  redirect_after TEXT,
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- install_tokens: AES-GCM-encrypted installation access tokens; DEK = INSTALL_TOKEN_KEY secret
-- Deviation: spec wrote `tenant_id INTEGER NOT NULL REFERENCES tenants(id) PRIMARY KEY` which is
-- invalid SQLite column-level PK syntax; reordered to `PRIMARY KEY NOT NULL REFERENCES tenants(id)`.
CREATE TABLE IF NOT EXISTS install_tokens (
  tenant_id  INTEGER PRIMARY KEY NOT NULL REFERENCES tenants(id),
  token_enc  TEXT NOT NULL,
  token_iv   TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- tenant_repo_access: authorization layer (fail-closed: no row → no data)
CREATE TABLE IF NOT EXISTS tenant_repo_access (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  repo      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, repo)
);

-- user_repo_permission_cache: per-user private-repo permission; 24h TTL
CREATE TABLE IF NOT EXISTS user_repo_permission_cache (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  repo       TEXT NOT NULL,
  has_access INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, repo)
);

-- sync_control rebuild: add composite PK (tenant_id, key) to support per-tenant state.
-- Deviation D-2: NO foreign key on tenant_id — the existing 5 sentinel rows use tenant_id=0
-- (a sentinel, not a real tenant), which would violate a FK constraint to tenants(id).
-- Strategy: rename-rebuild to preserve existing data, seeding sentinel rows at tenant_id=0.
CREATE TABLE sync_control_new (
  tenant_id  INTEGER NOT NULL DEFAULT 0,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, key)
);
INSERT INTO sync_control_new (tenant_id, key, value, updated_at)
  SELECT 0, key, value, updated_at FROM sync_control;
DROP TABLE sync_control;
ALTER TABLE sync_control_new RENAME TO sync_control;

-- zk_payloads: Phase-2 ZK seam; PK is per-user (browser keys, not per-tenant)
CREATE TABLE IF NOT EXISTS zk_payloads (
  user_id           INTEGER NOT NULL REFERENCES users(id),
  issue_key         TEXT NOT NULL,
  pubkey_fp         TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, issue_key)
);

-- title → payload move: ZK seam (D24); title lives inside payload JSON going forward.
-- JSON_EXTRACT(payload,'$.title') replaces direct title column access.
ALTER TABLE issues ADD COLUMN payload TEXT;
UPDATE issues SET payload = json_object('title', title) WHERE title IS NOT NULL;
ALTER TABLE issues DROP COLUMN title;

-- repos rename anchor (deviation D-1): SQLite forbids ADD COLUMN ... UNIQUE inline,
-- so the UNIQUE constraint is implemented as a separate index.
ALTER TABLE repos ADD COLUMN repo_node_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_repos_node_id ON repos(repo_node_id);
