-- migration: 0005_sync_slot_seed.sql
-- Applied via: wrangler d1 migrations apply DB [--env staging] --remote

-- Seed the global sync_slot sentinel row (tenant_id=0).
-- INSERT OR IGNORE: idempotent — no-op if the row already exists (e.g. re-applied migration).
-- sync_control PK is (tenant_id, key); tenant_id=0 is the global sentinel (no FK to tenants).
INSERT OR IGNORE INTO sync_control (tenant_id, key, value) VALUES (0, 'sync_slot', '0');
