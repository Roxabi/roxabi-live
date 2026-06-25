-- migration: 0013_zk_always_on.sql
-- Private mode is always on (#142): enable ZK for all existing users.

UPDATE users SET zk_opt_in = 1 WHERE zk_opt_in = 0;