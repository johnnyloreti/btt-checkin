// staff.js — data behind the staff screens (§3). Every function takes env
// and returns plain objects; app.js turns them into responses.

import { classesOn, UNSCHEDULED_CLASS, START_LOCAL_RE, shiftDate } from './classes.js';
import { localParts } from './time.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Tonight: every scheduled class on `date` with its attended count, plus open mat if any. */
export async function today(env, schedule, date) {
  if (!DATE_RE.test(date)) throw Object.assign(new Error('date must be YYYY-MM-DD'), { status: 400 });
  const classes = classesOn(schedule, date);
  const { results } = await env.DB.prepare(
    `SELECT class_start_local, class_name, COUNT(*) AS n
       FROM attendance
      WHERE status = 'attended' AND class_start_local >= ? AND class_start_local < ?
      GROUP BY class_start_local, class_name`,
  )
    .bind(`${date}T00:00`, `${date}T24:00`)
    .all();
  const counts = new Map(results.map((r) => [`${r.class_start_local}|${r.class_name}`, Number(r.n)]));
  const out = classes.map((c) => ({
    name: c.name,
    program: c.program,
    programLabel: c.programLabel,
    start: c.start,
    startLocal: c.startLocal,
    minutes: c.minutes,
    count: counts.get(`${c.startLocal}|${c.name}`) || 0,
  }));
  const openMat = counts.get(`${date}T00:00|${UNSCHEDULED_CLASS}`) || 0;
  if (openMat > 0) {
    out.push({ name: UNSCHEDULED_CLASS, program: null, programLabel: '', start: null, startLocal: `${date}T00:00`, minutes: 0, count: openMat });
  }
  return { date, weekday: weekdayLabel(date), timezone: schedule.timezone, classes: out };
}

function weekdayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Class roster: attended rows for one class start, with names. */
export async function classRoster(env, schedule, startLocal, className) {
  if (!START_LOCAL_RE.test(String(startLocal || ''))) {
    throw Object.assign(new Error('start must be YYYY-MM-DDTHH:MM'), { status: 400 });
  }
  const filterName = typeof className === 'string' && className ? className : null;
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.ghl_contact_id, a.class_name, a.checked_in_at, a.method, a.status_at_checkin,
            m.first_name, m.last_name
       FROM attendance a
       LEFT JOIN members m ON m.ghl_contact_id = a.ghl_contact_id
      WHERE a.class_start_local = ? AND a.status = 'attended' AND (? IS NULL OR a.class_name = ?)
      ORDER BY a.checked_in_at ASC`,
  )
    .bind(startLocal, filterName, filterName)
    .all();
  return {
    startLocal,
    className: filterName || (results[0] ? results[0].class_name : null),
    rows: results.map((r) => ({
      attendanceId: r.id,
      first: r.first_name || '(unknown)',
      last: r.last_name || '',
      className: r.class_name,
      checkedInAt: r.checked_in_at,
      method: r.method,
      statusAtCheckin: r.status_at_checkin,
    })),
  };
}

/** Void: soft delete. Sets status, never deletes. Returns how many rows changed. */
export async function voidAttendance(env, attendanceId) {
  const id = Number(attendanceId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('attendanceId must be a positive integer'), { status: 400 });
  const res = await env.DB.prepare("UPDATE attendance SET status = 'voided' WHERE id = ? AND status = 'attended'").bind(id).run();
  return { ok: true, attendanceId: id, changed: Number(res.meta?.changes ?? 0) };
}

/** Member lookup: last 30 days, lifetime count, sync status. Read-only. */
export async function memberHistory(env, schedule, contactId, now) {
  const member = await env.DB.prepare(
    'SELECT ghl_contact_id, first_name, last_name, programs, active, synced_at FROM members WHERE ghl_contact_id = ?',
  )
    .bind(contactId)
    .first();
  if (!member) return null;
  const todayLocal = localParts(now, schedule.timezone).date;
  const since = `${shiftDate(todayLocal, -30)}T00:00`;
  const [recent, lifetime, pending] = await Promise.all([
    env.DB.prepare(
      `SELECT id, class_name, class_start_local, checked_in_at, method, status, status_at_checkin
         FROM attendance WHERE ghl_contact_id = ? AND class_start_local >= ?
        ORDER BY class_start_local DESC, id DESC`,
    )
      .bind(contactId, since)
      .all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM attendance WHERE ghl_contact_id = ? AND status = 'attended'").bind(contactId).first(),
    env.DB.prepare('SELECT queued_at FROM pending_rollups WHERE ghl_contact_id = ?').bind(contactId).first(),
  ]);
  let programs = [];
  try {
    programs = JSON.parse(member.programs);
  } catch {
    programs = [];
  }
  return {
    first: member.first_name,
    last: member.last_name,
    programs,
    programLabels: programs.filter((p) => schedule.programs[p]).map((p) => schedule.programs[p].label),
    active: Number(member.active) === 1,
    syncedAt: member.synced_at,
    rollupPending: pending ? pending.queued_at : null,
    lifetime: Number(lifetime?.n ?? 0),
    last30: recent.results.map((r) => ({
      attendanceId: r.id,
      className: r.class_name,
      classStartLocal: r.class_start_local,
      checkedInAt: r.checked_in_at,
      method: r.method,
      status: r.status,
      statusAtCheckin: r.status_at_checkin,
    })),
  };
}
