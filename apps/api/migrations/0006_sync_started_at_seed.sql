-- migration: 0006_sync_started_at_seed.sql
-- Applied via: wrangler d1 migrations apply DB [--env staging] --remote

-- Seed the global sync_started_at row (tenant_id=0).
-- runSync does `UPDATE sync_control SET value=?, updated_at=? WHERE key='sync_started_at'
-- AND tenant_id=0` (worker/src/sync/sync.ts). SQLite UPDATE on a missing row is a silent
-- no-op (0 rows changed, no error), so without this seed sync_started_at is never written
-- and any reader (monitoring, dashboard) sees NULL forever. Surfaced by the #167 review.
-- INSERT OR IGNORE: idempotent — no-op if the row already exists (re-applied migration, or
-- a tick that already wrote it). sync_control PK is (tenant_id, key); tenant_id=0 is the
-- global sentinel (no FK to tenants), same as the sync_slot seed in 0005.
INSERT OR IGNORE INTO sync_control (tenant_id, key, value) VALUES (0, 'sync_started_at', '');
