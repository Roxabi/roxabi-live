-- migration: 0018_sync_control_sentinel_reseed.sql
-- Re-seed global sync_control sentinel rows (tenant_id=0) after a D1 data wipe.
-- d1_migrations stays applied so 0001/0005/0006 seeds do not re-run; without these
-- rows acquireSyncLock is a silent no-op and bootstrap sync never starts.

INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (0, 'sync_running', '0', datetime('now'));
INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (0, 'halted', '0', datetime('now'));
INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (0, 'auth_failures', '0', datetime('now'));
INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (0, 'sync_started_at', '', datetime('now'));
INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (0, 'sync_slot', '0', datetime('now'));
INSERT OR IGNORE INTO sync_control (tenant_id, key, value, updated_at) VALUES (0, 'data_version', '', datetime('now'));