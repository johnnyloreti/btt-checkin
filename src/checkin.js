// checkin.js — record attendance (§2, §5). Used by the kiosk route now and
// the staff add route in step 5.

import { validateClassChoice } from './classes.js';

const MAX_PAST_DAYS = 3; // queued kiosk retries can arrive late; anything older is refused
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

  // Date guard: today or up to MAX_PAST_DAYS back, never the future.
  if (choice.date > todayLocal) return { ok: false, status: 400, body: { error: 'class date is in the future' } };
  const oldest = new Date(`${todayLocal}T00:00:00Z`);
  oldest.setUTCDate(oldest.getUTCDate() - MAX_PAST_DAYS);
  if (choice.date < oldest.toISOString().slice(0, 10)) {
    return { ok: false, status: 400, body: { error: 'class date is too far in the past' } };
  }

  // Actual tap time: trust clientTs when sane, else server time.
  let checkedInAt = now;
  const ts = isoOrNull(clientTs);
  if (ts && ts.getTime() <= now.getTime() + MAX_TS_SKEW_MS && ts.getTime() >= now.getTime() - (MAX_PAST_DAYS + 1) * 86_400_000) {
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
