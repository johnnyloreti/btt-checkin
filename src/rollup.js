// rollup.js — nightly push of attendance rollups to GHL custom fields (§6).
// computeRollup is pure. runRollup touches D1 and, through deps, GHL.

import { localParts } from './time.js';
import { shiftDate, weekdayOf } from './classes.js';

/** The five custom field keys Johnny creates in GHL, in push order. */
export const FIELD_KEYS = ['attendance_last', 'attendance_30d', 'attendance_lifetime', 'attendance_week', 'attendance_class_count_label'];

const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Monday of the Mon-Sun week containing `date` ("YYYY-MM-DD"). */
export function mondayOf(date) {
  return shiftDate(date, -WEEKDAY_INDEX[weekdayOf(date)]);
}

/**
 * Rollup values for one contact.
 * rows: attended attendance rows with class_start_local ("YYYY-MM-DDTHH:MM" ET).
 * today: "YYYY-MM-DD" in ET.
 *  - attendance_last: date of the most recent attended class, or ''
 *  - attendance_30d: classes in the 30 calendar days ending today
 *  - attendance_week: classes in the current Mon-Sun week
 *  - attendance_lifetime: all attended
 *  - attendance_class_count_label: "Class #<lifetime>"
 */
export function computeRollup(rows, today) {
  const dates = rows.map((r) => String(r.class_start_local).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const since30 = shiftDate(today, -29);
  const monday = mondayOf(today);
  const sunday = shiftDate(monday, 6);
  let last = '';
  let d30 = 0;
  let week = 0;
  for (const d of dates) {
    if (d > last) last = d;
    if (d >= since30 && d <= today) d30 += 1;
    if (d >= monday && d <= sunday) week += 1;
  }
  const lifetime = dates.length;
  return {
    attendance_last: last,
    attendance_30d: d30,
    attendance_lifetime: lifetime,
    attendance_week: week,
    attendance_class_count_label: `Class #${lifetime}`,
  };
}

async function logSync(db, ranAt, outcome, detail) {
  await db.prepare('INSERT INTO sync_log (job, ran_at, outcome, detail) VALUES (?, ?, ?, ?)').bind('rollup', ranAt, outcome, JSON.stringify(detail)).run();
}

// Field ids are resolved once per isolate and kept for an hour.
let fieldCache = { at: 0, map: null };
export function resetFieldCache() {
  fieldCache = { at: 0, map: null };
}

/**
 * Push rollups for every contact in pending_rollups.
 *
 * deps.fetchFields: () => Promise<Map<key, id>>
 * deps.putContact:  (contactId, [{ id, field_value }]) => Promise
 * deps.now: Date
 *
 * Outcomes:
 *  - ok:       every pending contact pushed, all five fields present
 *  - degraded: some fields missing in GHL (skipped, others pushed) or some
 *              contacts failed (they stay pending for tomorrow)
 *  - failed:   could not resolve fields, or every push failed
 * Never throws.
 */
export async function runRollup(env, schedule, deps) {
  const db = env.DB;
  const now = deps.now || new Date();
  const ranAt = now.toISOString();
  const today = localParts(now, env.TZ || schedule.timezone).date;

  let fields;
  try {
    if (!fieldCache.map || now.getTime() - fieldCache.at > 60 * 60 * 1000) {
      fieldCache = { at: now.getTime(), map: await deps.fetchFields() };
    }
    fields = fieldCache.map;
  } catch (e) {
    const detail = { error: `custom fields: ${e && e.message ? e.message : e}` };
    await logSync(db, ranAt, 'failed', detail);
    return { outcome: 'failed', ...detail };
  }
  const missingFields = FIELD_KEYS.filter((k) => !fields.get(k));
  const presentKeys = FIELD_KEYS.filter((k) => fields.get(k));
  if (presentKeys.length === 0) {
    resetFieldCache();
    const detail = { error: 'none of the five attendance custom fields exist in GHL', missingFields };
    await logSync(db, ranAt, 'failed', detail);
    return { outcome: 'failed', ...detail };
  }

  const { results: pending } = await db.prepare('SELECT ghl_contact_id, queued_at FROM pending_rollups ORDER BY queued_at').all();
  if (pending.length === 0) {
    const detail = { pushed: 0, failed: 0, pending: 0, missingFields };
    await logSync(db, ranAt, missingFields.length ? 'degraded' : 'ok', detail);
    return { outcome: missingFields.length ? 'degraded' : 'ok', ...detail };
  }

  let pushed = 0;
  const failed = [];
  for (const p of pending) {
    const id = p.ghl_contact_id;
    try {
      const { results: rows } = await db
        .prepare("SELECT class_start_local FROM attendance WHERE ghl_contact_id = ? AND status = 'attended'")
        .bind(id)
        .all();
      const values = computeRollup(rows, today);
      const payload = presentKeys.map((k) => ({ id: fields.get(k), field_value: String(values[k]) }));
      await deps.putContact(id, payload);
      await db.prepare('DELETE FROM pending_rollups WHERE ghl_contact_id = ? AND queued_at = ?').bind(id, p.queued_at).run();
      pushed += 1;
    } catch (e) {
      failed.push(`${id}: ${e && e.message ? e.message : e}`);
    }
  }

  const detail = { pushed, failed: failed.length, pending: pending.length, missingFields, failures: failed.slice(0, 20) };
  let outcome = 'ok';
  if (pushed === 0 && failed.length > 0) outcome = 'failed';
  else if (failed.length > 0 || missingFields.length > 0) outcome = 'degraded';
  await logSync(db, ranAt, outcome, detail);
  return { outcome, ...detail };
}
