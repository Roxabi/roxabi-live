-- migration: 0020_user_consent.sql
-- Server-owned onboarding consent (replaces client localStorage).

ALTER TABLE users ADD COLUMN consent_at TEXT;