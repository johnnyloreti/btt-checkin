-- 007: lesson notes and week plans (§15.8). Apply once, before or after
-- deploying the Worker that reads it; the Worker survives either order
-- (see src/schema-caps.js: the lesson boxes stay hidden until these exist):
--   wrangler d1 execute btt-checkin --remote --file=src/db/migrations/007_lessons.sql
-- lesson_plans: one plan per program per week. week_start is the Monday, ET.
-- class_notes:  one note per scheduled class.
-- A blank save deletes the row, so a row always has something to show.
CREATE TABLE IF NOT EXISTS lesson_plans (
  week_start TEXT NOT NULL,          -- "YYYY-MM-DD", a Monday
  program    TEXT NOT NULL,          -- program key from schedule.json
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL,          -- ISO UTC
  PRIMARY KEY (week_start, program)
);

CREATE TABLE IF NOT EXISTS class_notes (
  class_start_local TEXT NOT NULL,   -- "YYYY-MM-DDTHH:MM" ET, the scheduled start
  class_name        TEXT NOT NULL,
  body              TEXT NOT NULL,
  updated_at        TEXT NOT NULL,   -- ISO UTC
  PRIMARY KEY (class_start_local, class_name)
);
