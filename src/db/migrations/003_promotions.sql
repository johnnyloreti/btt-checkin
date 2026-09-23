-- 003: promotions, for the stripe tab (§15.2). Apply once, before deploying
-- the Worker version that reads it:
--   wrangler d1 execute btt-checkin --remote --file=src/db/migrations/003_promotions.sql
-- The Worker survives this table being absent (see src/schema-caps.js); the
-- stripe tab simply stays hidden until the table exists.
CREATE TABLE IF NOT EXISTS promotions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ghl_contact_id TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('stripe','belt')),
  awarded_on     TEXT NOT NULL,              -- "YYYY-MM-DD" ET, the day it was given
  at_class_count INTEGER NOT NULL,           -- attended classes at that moment
  note           TEXT,
  created_at     TEXT NOT NULL               -- ISO UTC, orders same-day awards
);

CREATE INDEX IF NOT EXISTS idx_promotions_contact ON promotions (ghl_contact_id, created_at);
