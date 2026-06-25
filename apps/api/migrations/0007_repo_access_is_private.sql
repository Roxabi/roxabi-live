-- migration: 0007_repo_access_is_private.sql
-- Applied via: wrangler d1 migrations apply DB [--env staging] --remote

-- Add is_private column to tenant_repo_access (fail-closed default).
-- DEFAULT 1 = treat every repo as private until the hourly sync sets is_private=0
-- for public repos. Defaulting to 0 (public) would expose private repos to
-- unauthenticated graph reads (IDOR) before the first sync tick after apply.
-- ALTER TABLE ... ADD COLUMN with a constant DEFAULT is valid in D1/SQLite.
-- No backfill needed: existing rows correctly inherit DEFAULT 1 (fail-closed).
-- No index added: is_private is used as a filter column in JOIN reads, not a
-- primary lookup key; query planner will cover it via the (tenant_id, repo) PK scan.
ALTER TABLE tenant_repo_access ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1;
