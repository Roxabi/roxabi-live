-- migration: 0009_tenant_deleted_at.sql
-- Applied via: wrangler d1 migrations apply DB [--env staging] --remote
--
-- Soft-delete tombstone for installation.deleted webhook events (H2).
-- Tenant row is retained (issues/edges intact); deleted_at = ISO timestamp
-- when the installation was deleted, NULL = active.
ALTER TABLE tenants ADD COLUMN deleted_at TEXT;
