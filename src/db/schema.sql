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

-- Stripe and belt awards (§15.2). Eligibility counts attended classes since
-- the most recent row here.
CREATE TABLE IF NOT EXISTS promotions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ghl_contact_id TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('stripe','belt')),
  awarded_on     TEXT NOT NULL,              -- "YYYY-MM-DD" ET
  at_class_count INTEGER NOT NULL,           -- attended classes at that moment
  note           TEXT,
  created_at     TEXT NOT NULL               -- ISO UTC
);

CREATE INDEX IF NOT EXISTS idx_promotions_contact ON promotions (ghl_contact_id, created_at);

-- Drink tab (§15.3). Same statements as src/db/migrations/004_tab.sql.
-- A member's purchase PIN. Hash is HMAC-SHA256 keyed with the PIN_PEPPER
-- secret, which never touches this database; see src/pin.js.
CREATE TABLE IF NOT EXISTS purchase_pins (
  payer_contact_id TEXT PRIMARY KEY,
  pin_hash         TEXT NOT NULL,
  salt             TEXT NOT NULL,
  set_at           TEXT NOT NULL,
  set_by           TEXT NOT NULL CHECK (set_by IN ('link','staff')),
  failed_count     INTEGER NOT NULL DEFAULT 0,
  first_failed_at  TEXT,
  locked_until     TEXT
);

-- One-time PIN setup links. The raw token is only ever in the link itself.
CREATE TABLE IF NOT EXISTS pin_setup_tokens (
  token_hash       TEXT PRIMARY KEY,
  payer_contact_id TEXT NOT NULL,
  via              TEXT NOT NULL DEFAULT 'link' CHECK (via IN ('link','staff')),
  created_at       TEXT NOT NULL,          -- also enforces one link per member per 10 minutes
  expires_at       TEXT NOT NULL,
  used_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_pin_setup_tokens_payer ON pin_setup_tokens (payer_contact_id, created_at);

-- Every wrong PIN, kiosk-wide, for the staff page.
CREATE TABLE IF NOT EXISTS pin_failures (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  payer_contact_id TEXT NOT NULL,
  failed_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pin_failures_at ON pin_failures (failed_at);

CREATE TABLE IF NOT EXISTS purchases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_contact_id  TEXT NOT NULL,         -- who took the item
  payer_contact_id  TEXT NOT NULL,         -- whose card pays (same as buyer in Phase 1)
  item_key          TEXT NOT NULL,
  product_id        TEXT NOT NULL,
  price_id          TEXT NOT NULL,
  unit_amount_cents INTEGER NOT NULL,      -- price at the moment of purchase
  qty               INTEGER NOT NULL DEFAULT 1,
  purchased_at      TEXT NOT NULL,         -- ISO UTC
  method            TEXT NOT NULL CHECK (method IN ('kiosk','staff')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','voided','invoiced')),
  closeout_payer_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_purchases_payer_status ON purchases (payer_contact_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_at ON purchases (purchased_at);

CREATE TABLE IF NOT EXISTS closeouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  approved_by  TEXT NOT NULL DEFAULT 'staff'
);

-- One row per payer per close-out, written before any GHL call. Each step of
-- the close-out records its result here before the next runs, so a crash at
-- any point resumes safely and never double-charges.
CREATE TABLE IF NOT EXISTS closeout_payers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  closeout_id         INTEGER NOT NULL,
  payer_contact_id    TEXT NOT NULL,
  amount_cents        INTEGER NOT NULL,
  invoice_name        TEXT NOT NULL,       -- "BTT tab #<closeout_id>-<8 hex of sha256(payer id)>", unique
  state               TEXT NOT NULL CHECK (state IN
                        ('pending','schedule_created','autopay_on','paid','failed',
                         'paid_at_pos','skipped_no_card','skipped_missing_contact')),
  invoice_schedule_id TEXT,
  invoice_id          TEXT,
  card_brand          TEXT,
  card_last4          TEXT,
  card_source         TEXT,                -- invoice | funnel | payment_link
  detail              TEXT,
  updated_at          TEXT NOT NULL,
  UNIQUE (closeout_id, payer_contact_id)
);

-- A payer whose last close-out found no usable card. The kiosk hides the
-- drink row for them until staff clear it, so a tab never grows with nothing
-- behind it.
CREATE TABLE IF NOT EXISTS tab_flags (
  payer_contact_id TEXT PRIMARY KEY,
  no_card_since    TEXT NOT NULL
);
