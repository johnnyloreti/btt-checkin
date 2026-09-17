-- btt-checkin D1 schema. Apply with:
--   wrangler d1 execute btt-checkin --remote --file=src/db/schema.sql
-- Every statement is idempotent so re-running is safe.

CREATE TABLE IF NOT EXISTS members (
  ghl_contact_id TEXT PRIMARY KEY,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  programs       TEXT NOT NULL,   -- JSON array of program keys, e.g. ["kids-6-9"]
  active         INTEGER NOT NULL DEFAULT 1,
  synced_at      TEXT NOT NULL,
  waiver         INTEGER NOT NULL DEFAULT 1   -- 1 = waiver tag present or feature off (§15.1)
);

CREATE TABLE IF NOT EXISTS attendance (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ghl_contact_id     TEXT NOT NULL,
  class_name         TEXT NOT NULL,
  class_start_local  TEXT NOT NULL,   -- "2026-09-06T17:00" ET, the scheduled start
  checked_in_at      TEXT NOT NULL,   -- ISO UTC, actual tap time
  method             TEXT NOT NULL CHECK (method IN ('kiosk','staff')),
  status             TEXT NOT NULL DEFAULT 'attended' CHECK (status IN ('attended','voided')),
  status_at_checkin  TEXT NOT NULL DEFAULT 'active',
  UNIQUE (ghl_contact_id, class_start_local)
);

CREATE INDEX IF NOT EXISTS idx_attendance_class_start ON attendance (class_start_local);
CREATE INDEX IF NOT EXISTS idx_attendance_contact ON attendance (ghl_contact_id, checked_in_at);

CREATE TABLE IF NOT EXISTS sync_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job       TEXT NOT NULL,             -- 'roster' | 'rollup'
  ran_at    TEXT NOT NULL,
  outcome   TEXT NOT NULL,             -- 'ok' | 'degraded' | 'failed'
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_log_job_ran ON sync_log (job, ran_at);

CREATE TABLE IF NOT EXISTS pending_rollups (
  ghl_contact_id TEXT PRIMARY KEY,
  queued_at      TEXT NOT NULL
);
