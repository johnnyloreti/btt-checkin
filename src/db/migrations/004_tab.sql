-- 004: drink tab (§15.3). Apply once, before deploying the Worker version
-- that carries the tab:
--   wrangler d1 execute btt-checkin --remote --file=src/db/migrations/004_tab.sql
-- The Worker survives these tables being absent (see src/schema-caps.js):
-- the drink row and the staff tab screens stay hidden, check-in is untouched.

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
