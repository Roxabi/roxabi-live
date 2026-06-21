-- migration: 0021_oauth_remember.sql
-- Persist "remember me" choice through OAuth state → 30-day session TTL.

ALTER TABLE oauth_state ADD COLUMN remember INTEGER NOT NULL DEFAULT 0;