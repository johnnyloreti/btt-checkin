-- 005: who pays for a member (§15.3 Phase 1b, first used by the waiver
-- reminder, §15.1). Apply once, before or after deploying the Worker that
-- reads it; the Worker survives either order:
--   wrangler d1 execute btt-checkin --remote --file=src/db/migrations/005_payer.sql
-- Filled by the roster sync from the contact custom field payer_contact_id
-- (PAYER_FIELD), which the btt-ops side sets on each kid. NULL means no
-- payer is linked, and the member's own contact is used.
ALTER TABLE members ADD COLUMN payer_contact_id TEXT;
