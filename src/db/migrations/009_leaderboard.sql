-- 009: keeping a member off the monthly podium (§15.13). Apply once, before
-- or after deploying the Worker that reads it; the Worker survives either
-- order (see src/schema-caps.js: the podium stays hidden until this exists,
-- because without it nobody could be kept off it):
--   wrangler d1 execute btt-checkin --remote --file=src/db/migrations/009_leaderboard.sql
-- Filled by the roster sync: 1 when the member's contact, or their linked
-- parent's, carries the tag in LEADERBOARD_HIDE_TAG.
ALTER TABLE members ADD COLUMN board_hidden INTEGER NOT NULL DEFAULT 0;
