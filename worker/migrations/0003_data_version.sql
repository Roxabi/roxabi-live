-- Migration: seed data_version key in sync_control
-- This key is bumped on every mutating webhook dispatch so that /api/version
-- reflects real-time board changes (≤15 s poll) instead of only the hourly
-- cron tick.

INSERT OR IGNORE INTO sync_control (key, value, updated_at)
VALUES ('data_version', '', datetime('now'));
