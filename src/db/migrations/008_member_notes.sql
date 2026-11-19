-- 008: a staff note on a member (§15.11). Apply once, before or after
-- deploying the Worker that reads it; the Worker survives either order
-- (see src/schema-caps.js: the note box stays hidden until this exists):
--   wrangler d1 execute btt-checkin --remote --file=src/db/migrations/008_member_notes.sql
-- Only needed once MEMBER_NOTES is "on" in wrangler.toml. While it is "off"
-- nothing reads this table and /health does not ask for it.
-- One note per member. A blank save deletes the row.
CREATE TABLE IF NOT EXISTS member_notes (
  ghl_contact_id TEXT PRIMARY KEY,
  body           TEXT NOT NULL,
  updated_at     TEXT NOT NULL       -- ISO UTC
);
