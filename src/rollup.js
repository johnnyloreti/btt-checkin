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

/** Map<key, id> of the location's custom fields, cached for an hour. */
export async function getFieldIds(fetchFields, now = new Date()) {
  if (!fieldCache.map || now.getTime() - fieldCache.at > 60 * 60 * 1000) {
    fieldCache = { at: now.getTime(), map: await fetchFields() };
  }
  return fieldCache.map;
}

export const DEFAULT_ROLLUP_BATCH = 20;
export const MAX_ROLLUP_BATCH = 40;

/**
 * Contacts pushed per cron tick: ROLLUP_BATCH in wrangler.toml, 20 unless
 * set. One GHL call each, and Workers Free allows about 50 outbound calls an
 * invocation, shared with the roster sync and the tab on the same tick.
 */
export function rollupBatch(env = {}) {
  const n = Number.parseInt(String(env.ROLLUP_BATCH ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ROLLUP_BATCH;
  return Math.min(n, MAX_ROLLUP_BATCH);
}

/** Where the last run stopped, when it stopped short: { cutoff, cursor } or null. */
async function unfinishedRun(db) {
  const row = await db.prepare("SELECT detail FROM sync_log WHERE job = 'rollup' ORDER BY ran_at DESC, id DESC LIMIT 1").first();
  if (!row || !row.detail) return null;
  let d;
  try {
    d = JSON.parse(row.detail);
  } catch {
    return null;
  }
  if (!d || !(Number(d.remaining) > 0) || typeof d.cutoff !== 'string' || !Array.isArray(d.cursor) || d.cursor.length !== 2) return null;
  return { cutoff: d.cutoff, cursor: [String(d.cursor[0]), String(d.cursor[1])] };
}

/**
 * Push rollups for contacts in pending_rollups, a batch at a time.
 *
 * It used to push every pending contact in one go, one GHL call each. Past
 * about forty contacts a night that runs into the outbound-call limit of a
 * single invocation, the calls beyond it fail, and those members' fields
 * fall a day behind, every night. Now a run takes `rollupBatch(env)`
 * contacts, oldest first, and writes down where it stopped. The cron calls
 * it again on each later tick with `resume`, which carries on from there
 * until the night's list is done.
 *
 * A night's list is fixed when the run starts (`cutoff`): a check-in during
 * the day is still pushed that night, as before, not half an hour later.
 * A contact whose push failed is passed over and stays pending for the next
 * night, as before; resuming never retries it every half hour.
 *
 * deps.fetchFields: () => Promise<Map<key, id>>
 * deps.putContact:  (contactId, [{ id, field_value }]) => Promise
 * deps.now: Date
 * deps.resume: true on the ticks after the nightly one
 *
 * Outcomes:
 *  - ok:       every contact tried was pushed, all five fields present
 *  - degraded: some fields missing in GHL (skipped, others pushed) or some
 *              contacts failed (they stay pending for tomorrow)
 *  - failed:   could not resolve fields, or every push failed
 * `remaining` is how many of the night's list are still to be tried.
 * A resume with nothing to carry on returns { did: false } and logs nothing.
 * Never throws.
 */
export async function runRollup(env, schedule, deps) {
  const db = env.DB;
  const now = deps.now || new Date();
  const ranAt = now.toISOString();
  const today = localParts(now, env.TZ || schedule.timezone).date;
  const batch = rollupBatch(env);

  let cutoff = ranAt;
  let cursor = ['', ''];
  if (deps.resume) {
    let left = null;
    try {
      left = await unfinishedRun(db);
    } catch (e) {
      console.warn(`rollup resume: could not read the last run: ${e && e.message ? e.message : e}`);
    }
    if (!left) return { did: false, outcome: 'ok' };
    ({ cutoff, cursor } = left);
  }

  let fields;
  try {
    fields = await getFieldIds(deps.fetchFields, now);
  } catch (e) {
    // A resume that cannot start keeps its place for the next tick.
    const detail = { error: `custom fields: ${e && e.message ? e.message : e}`, ...(deps.resume ? { remaining: 1, cutoff, cursor } : {}) };
    await logSync(db, ranAt, 'failed', detail);
    return { did: true, outcome: 'failed', ...detail };
  }
  const missingFields = FIELD_KEYS.filter((k) => !fields.get(k));
  const presentKeys = FIELD_KEYS.filter((k) => fields.get(k));
  if (presentKeys.length === 0) {
    resetFieldCache();
    const detail = { error: 'none of the five attendance custom fields exist in GHL', missingFields };
    await logSync(db, ranAt, 'failed', detail);
    return { did: true, outcome: 'failed', ...detail };
  }

  // The night's list from where the last batch stopped, one more than a
  // batch so "is there more" needs no second query.
  const { results: rows } = await db
    .prepare(
      `SELECT ghl_contact_id, queued_at FROM pending_rollups
        WHERE queued_at <= ? AND (queued_at > ? OR (queued_at = ? AND ghl_contact_id > ?))
        ORDER BY queued_at, ghl_contact_id LIMIT ?`,
    )
    .bind(cutoff, cursor[0], cursor[0], cursor[1], batch + 1)
    .all();
  const pending = rows.slice(0, batch);
  if (pending.length === 0) {
    const detail = { pushed: 0, failed: 0, pending: 0, remaining: 0, missingFields };
    await logSync(db, ranAt, missingFields.length ? 'degraded' : 'ok', detail);
    return { did: true, outcome: missingFields.length ? 'degraded' : 'ok', ...detail };
  }
  let remaining = 0;
  if (rows.length > batch) {
    const last = pending[pending.length - 1];
    const more = await db
      .prepare('SELECT COUNT(*) AS n FROM pending_rollups WHERE queued_at <= ? AND (queued_at > ? OR (queued_at = ? AND ghl_contact_id > ?))')
      .bind(cutoff, last.queued_at, last.queued_at, last.ghl_contact_id)
      .first();
    remaining = Number(more?.n ?? 1);
  }

  // One query for the whole batch's attendance, not one per contact.
  const byContact = new Map(pending.map((p) => [p.ghl_contact_id, []]));
  let readError = null;
  try {
    const marks = pending.map(() => '?').join(', ');
    const { results: attended } = await db
      .prepare(`SELECT ghl_contact_id, class_start_local FROM attendance WHERE status = 'attended' AND ghl_contact_id IN (${marks})`)
      .bind(...pending.map((p) => p.ghl_contact_id))
      .all();
    for (const r of attended) byContact.get(r.ghl_contact_id)?.push(r);
  } catch (e) {
    readError = e && e.message ? e.message : String(e);
  }

  let pushed = 0;
  const failed = [];
  const done = [];
  for (const p of pending) {
    const id = p.ghl_contact_id;
    try {
      if (readError) throw new Error(`attendance: ${readError}`);
      const values = computeRollup(byContact.get(id), today);
      const payload = presentKeys.map((k) => ({ id: fields.get(k), field_value: String(values[k]) }));
      await deps.putContact(id, payload);
      done.push(p);
      pushed += 1;
    } catch (e) {
      failed.push(`${id}: ${e && e.message ? e.message : e}`);
    }
  }
  // Cleared together, after the pushes. If this is lost the same values are
  // pushed again next time, which changes nothing in GHL.
  if (done.length) {
    try {
      await db.batch(done.map((p) => db.prepare('DELETE FROM pending_rollups WHERE ghl_contact_id = ? AND queued_at = ?').bind(p.ghl_contact_id, p.queued_at)));
    } catch (e) {
      failed.push(`clearing pushed contacts: ${e && e.message ? e.message : e}`);
    }
  }

  const last = pending[pending.length - 1];
  const detail = {
    pushed, failed: failed.length, pending: pending.length + remaining, remaining, missingFields, failures: failed.slice(0, 20),
    ...(remaining > 0 ? { cutoff, cursor: [last.queued_at, last.ghl_contact_id] } : {}),
  };
  let outcome = 'ok';
  if (pushed === 0 && failed.length > 0) outcome = 'failed';
  else if (failed.length > 0 || missingFields.length > 0) outcome = 'degraded';
  await logSync(db, ranAt, outcome, detail);
  return { did: true, outcome, ...detail };
}
