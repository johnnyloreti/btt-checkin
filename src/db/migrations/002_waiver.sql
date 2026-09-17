-- 002: waiver flag on members (§15.1). Apply once, before deploying the
-- Worker version that reads it:
--   wrangler d1 execute btt-checkin --remote --file=src/db/migrations/002_waiver.sql
-- Default 1 (signed) so nobody is prompted until the sync has run with a
-- WAIVER_TAG configured.
ALTER TABLE members ADD COLUMN waiver INTEGER NOT NULL DEFAULT 1;
