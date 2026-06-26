-- migration: 0012_scrub_zk_sealed_payloads.sql
-- One-time scrub: issues with zk_payloads rows must not retain plaintext titles in D1.

UPDATE issues SET payload = json_object()
WHERE key IN (SELECT DISTINCT issue_key FROM zk_payloads);