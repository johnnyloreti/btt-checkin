-- 006: belts on the promotions table (§15.4). Apply once, before or after
-- deploying the Worker that reads it; the Worker survives either order
-- (see src/schema-caps.js: rank stays hidden and stripes keep working until
-- these columns exist):
--   wrangler d1 execute btt-checkin --remote --file=src/db/migrations/006_belts.sql
-- belt:     the belt a 'belt' row records, a key from BELTS_KIDS or BELTS_ADULT.
-- stripes:  stripes already on that belt when it was recorded.
-- starting: 1 when the row sets a rank the member already held. It shows
--           their rank but is not an award, so the class count toward the
--           next stripe is left alone.
ALTER TABLE promotions ADD COLUMN belt TEXT;
ALTER TABLE promotions ADD COLUMN stripes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promotions ADD COLUMN starting INTEGER NOT NULL DEFAULT 0;
