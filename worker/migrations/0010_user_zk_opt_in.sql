-- migration: 0010_user_zk_opt_in.sql
-- Phase 2 (#142): per-user opt-in flag for client-side encryption mode.
-- 0 = server-readable (Phase 1 default); 1 = user requested ZK mode (encryption pipeline).
ALTER TABLE users ADD COLUMN zk_opt_in INTEGER NOT NULL DEFAULT 0;