// checkin.js — record attendance (§2, §5). Used by the kiosk route and the
// staff add route.

import { shiftDate, validateClassChoice } from './classes.js';

/**
 * How far back a check-in may be dated, in whole days.
 *
 * The kiosk needs only enough room for a queued retry to land: a record
 * sitting in localStorage on an iPad that lost wifi. Keeping that tight is
 * what stops a stale queued tap from appearing weeks later on a roster
 * nobody is looking at any more.
 *
 * Staff need room to backfill a class nobody tapped for — the iPad was in
 * the office, the class ran anyway — so their reach is a month. A staff add
 * is a deliberate act by someone who is signed in, and it lands on the class
 * it names, so every rollup number comes out on the right date.
 *
 * Both are overridable per deploy with KIOSK_BACKDATE_DAYS /
 * STAFF_BACKDATE_DAYS in wrangler.toml.
 */
export const KIOSK_BACKDATE_DAYS = 3;
export const STAFF_BACKDATE_DAYS = 30;

/** The configured backdate limits, falling back to the defaults above. */
export function backdateFromEnv(env = {}) {
  const days = (value, fallback) => {
    const raw = String(value ?? '').trim();
    if (raw === '') return fallback; // unset, or blank in wrangler.toml
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    kiosk: days(env.KIOSK_BACKDATE_DAYS, KIOSK_BACKDATE_DAYS),
    staff: days(env.STAFF_BACKDATE_DAYS, STAFF_BACKDATE_DAYS),
  };
}

const MAX_TS_SKEW_MS = 5 * 60 * 1000;

function isoOrNull(s) {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Record one check-in.
 *
 * input: { contactId (real GHL id), className, classStartLocal, clientTs?, method, memberActive, nowLocalDate }
 * Returns { ok, status, body } where body is what the route returns.
 *
 * Duplicate guard: UNIQUE(ghl_contact_id, class_start_local). A second tap
 * for the same class changes nothing and reports duplicate=true. A row that
 * staff voided earlier is set back to attended by a new check-in.
 */
export async function recordCheckin(env, schedule, input) {
  const { contactId, className, classStartLocal, clientTs, method, memberActive, now, todayLocal } = input;
  const choice = validateClassChoice(schedule, className, classStartLocal);
  if (!choice.ok) return { ok: false, status: 400, body: { error: choice.error } };

  // Date guard: today or up to the method's limit back, never the future.
  const limits = backdateFromEnv(env);
  const maxPastDays = method === 'staff' ? limits.staff : limits.kiosk;
  if (choice.date > todayLocal) return { ok: false, status: 400, body: { error: 'class date is in the future' } };
  if (choice.date < shiftDate(todayLocal, -maxPastDays)) {
    return { ok: false, status: 400, body: { error: `class date is more than ${maxPastDays} days ago` } };
  }

  // Actual tap time: trust clientTs when sane, else server time. The floor is
  // the kiosk's queue lifetime whichever route this is — a staff backfill of
  // an old class is still recorded as tapped today, which is the truth.
  let checkedInAt = now;
  const ts = isoOrNull(clientTs);
  const tsFloor = now.getTime() - (limits.kiosk + 1) * 86_400_000;
  if (ts && ts.getTime() <= now.getTime() + MAX_TS_SKEW_MS && ts.getTime() >= tsFloor) {
    checkedInAt = ts;
  }

  const statusAtCheckin = memberActive ? 'active' : 'inactive';
  const db = env.DB;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status, status_at_checkin)
         VALUES (?, ?, ?, ?, ?, 'attended', ?)
         ON CONFLICT(ghl_contact_id, class_start_local) DO UPDATE SET
           status = 'attended',
           checked_in_at = excluded.checked_in_at,
           method = excluded.method,
           status_at_checkin = excluded.status_at_checkin
         WHERE attendance.status = 'voided'`,
      )
      .bind(contactId, choice.className, choice.classStartLocal, checkedInAt.toISOString(), method, statusAtCheckin),
    db.prepare('INSERT OR IGNORE INTO pending_rollups (ghl_contact_id, queued_at) VALUES (?, ?)').bind(contactId, now.toISOString()),
    db
      .prepare("SELECT COUNT(*) AS n FROM attendance WHERE ghl_contact_id = ? AND status = 'attended'")
      .bind(contactId),
  ]);

  const changed = Number(results[0]?.meta?.changes ?? 0) > 0;
  const count = Number(results[2]?.results?.[0]?.n ?? 0);
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      duplicate: !changed,
      className: choice.className,
      classStartLocal: choice.classStartLocal,
      classCount: count,
      classCountLabel: `Class #${count}`,
    },
  };
}
