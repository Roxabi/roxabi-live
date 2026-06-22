-- migration: 0022_assignees.sql
-- GitHub issue assignees (0..N logins), stored as JSON array.

ALTER TABLE issues ADD COLUMN assignees TEXT;