-- migration: 0016_zk_nuclear_reset.sql
-- Full ZK reset: purge all ciphertext, backups, handoffs; scrub issue titles from D1.
-- Operator rollout (#216): skip v1→v2 migration, re-enroll from scratch.

DELETE FROM zk_reauth_proofs;
DELETE FROM zk_key_backups;
DELETE FROM zk_payloads;
DELETE FROM user_token_handoffs;
UPDATE issues SET payload = json_object();