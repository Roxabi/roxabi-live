-- migration: 0008_tenant_not_null.sql  (M-b — epic #141 / S7 #150)
-- Applied via: wrangler d1 migrations apply DB [--env staging] --remote
--
-- The deferred NOT-NULL migration. Authored in S1's design (plan #144 appendix),
-- committed HERE (S7) so CI never tightens before the auth tables proved out.
--
-- SCOPE — new/rebuilt tables ONLY. Data tables (issues, edges, labels, pr_state,
-- repos) keep their global PKs and are untouched (repo-canonical pivot: no
-- tenant_id on data tables → no backfill, no NOT-NULL changes there). The
-- intentionally-nullable seams stay nullable: issues.payload (NULL in Phase 1,
-- ciphertext in Phase 2) and repos.repo_node_id (filled lazily by sync).
--
-- The new auth tables (0004) were already authored with NOT NULL inline, and
-- 0007 added tenant_repo_access.is_private NOT NULL. The S1 appendix flagged M-b
-- as a NO-OP candidate "if still empty at S7 entry". Re-evaluated at S7: it is
-- NOT empty — the 0004 sync_control rebuild silently dropped value's NOT NULL
-- (it was NOT NULL in 0001; the rebuild recreated it as `value TEXT`). This
-- migration restores that single invariant. No other column needs tightening.
--
-- SAFE: no code path writes NULL to sync_control.value — every write binds an
-- ISO timestamp / String(slot) / literal '0'|'1'|CAST(... AS TEXT) (verified
-- across mutations.ts + sync.ts). SELF-GUARDING: the INSERT … SELECT into a
-- NOT NULL column throws BEFORE any rename if a stray NULL exists, so a bad
-- state fails this migration loudly (sync_control still intact) rather than
-- corrupting data. Pre-req gate (docs/s7-access-cutover.md): re-verify
--   SELECT COUNT(*) FROM sync_control WHERE value IS NULL;  -- expect 0
-- on staging and prod before apply.

-- D1 enforces FKs by default; belt-and-braces for local/vanilla SQLite runs.
PRAGMA foreign_keys = ON;

-- sync_control rebuild — value TEXT → value TEXT NOT NULL. Mirrors the 0004
-- rename-swap (data exists in at least one table at every crash point). NO FK on
-- tenant_id (deviation D-2: sentinel rows use tenant_id=0, not a real tenant).
-- recovery guard — if a prior partial run failed between CREATE and first RENAME,
-- re-apply starts clean.
DROP TABLE IF EXISTS sync_control_new;
CREATE TABLE sync_control_new (
  tenant_id  INTEGER NOT NULL DEFAULT 0,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, key)
);
-- Copy tenant_id directly (post-0004 sync_control already has the column — unlike
-- 0004, which hardcoded 0 because the pre-rebuild table had no tenant_id).
INSERT INTO sync_control_new (tenant_id, key, value, updated_at)
  SELECT tenant_id, key, value, updated_at FROM sync_control;
ALTER TABLE sync_control RENAME TO sync_control_old;
ALTER TABLE sync_control_new RENAME TO sync_control;
DROP TABLE sync_control_old;
