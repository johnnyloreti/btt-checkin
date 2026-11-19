// staff.js — data behind the staff screens (§3). Every function takes env
// and returns plain objects; app.js turns them into responses.

import { classesOn, UNSCHEDULED_CLASS, START_LOCAL_RE, shiftDate } from './classes.js';
import { localParts } from './time.js';
import { hasWaiverColumn, hasPayerColumn } from './schema-caps.js';
import { backdateFromEnv } from './checkin.js';
import { ranksFor } from './promotions.js';

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
  // staffBackdateDays bounds the date picker on the member screen, so the
  // page never offers a day the server would refuse.
  return { date, weekday: weekdayLabel(date), timezone: schedule.timezone, classes: out, staffBackdateDays: backdateFromEnv(env).staff };
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
  const waiverCol = (await hasWaiverColumn(env)) ? 'm.waiver' : 'NULL AS waiver';
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.ghl_contact_id, a.class_name, a.checked_in_at, a.method, a.status_at_checkin,
            m.first_name, m.last_name, m.programs, ${waiverCol}
       FROM attendance a
       LEFT JOIN members m ON m.ghl_contact_id = a.ghl_contact_id
      WHERE a.class_start_local = ? AND a.status = 'attended' AND (? IS NULL OR a.class_name = ?)
      ORDER BY a.checked_in_at ASC`,
  )
    .bind(startLocal, filterName, filterName)
    .all();
  // Belt and stripes beside each name (§15.4). Empty when belts are off or
  // migration 006 is pending, and the roster simply shows no rank.
  const ranks = await ranksFor(env, results.map((r) => ({ ghl_contact_id: r.ghl_contact_id, programs: parsePrograms(r.programs) })));
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
      waiver: r.waiver === null || r.waiver === undefined ? null : Number(r.waiver) === 1,
      rank: ranks.get(r.ghl_contact_id) || null,
    })),
  };
}

function parsePrograms(raw) {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
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
  const extra = [];
  if (await hasWaiverColumn(env)) extra.push('waiver');
  const payerCol = await hasPayerColumn(env);
  if (payerCol) extra.push('payer_contact_id');
  const cols = ['programs', 'active', 'synced_at', ...extra].join(', ');
  const member = await env.DB.prepare(
    `SELECT ghl_contact_id, first_name, last_name, ${cols} FROM members WHERE ghl_contact_id = ?`,
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
    waiver: Number(member.waiver ?? 1) === 1,
    // Whether a parent is linked to receive this member's reminders
    // (Phase 1b). null when the column is not there yet. Never the id.
    payerLinked: payerCol ? Boolean(member.payer_contact_id) : null,
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

// ---------- away list (§15.5) ----------
export const DEFAULT_AWAY_DAYS = 14;

/** Days without a class before a member is listed. "0" turns the list off. */
export function awayConfig(env = {}) {
  const raw = String(env.AWAY_DAYS ?? '').trim();
  const n = Number(raw);
  if (raw === '0') return { enabled: false, days: 0 };
  return { enabled: true, days: raw !== '' && Number.isInteger(n) && n > 0 ? n : DEFAULT_AWAY_DAYS };
}

function daysBetween(fromDate, toDate) {
  const utc = (d) => { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day); };
  return Math.round((utc(toDate) - utc(fromDate)) / 86_400_000);
}

/**
 * Who has gone quiet. Two lists of active members:
 *   away   attended before, last class `days` or more days ago, longest first
 *   never  on the roster with no attended class at all
 * Days are whole ET calendar days from the class date to today. A voided
 * check-in does not count as a class.
 */
export async function awayList(env, schedule, now) {
  const cfg = awayConfig(env);
  if (!cfg.enabled) return { enabled: false, days: 0, away: [], never: [] };
  const todayLocal = localParts(now, env.TZ || schedule.timezone).date;
  const { results } = await env.DB.prepare(
    `SELECT m.ghl_contact_id, m.first_name, m.last_name, m.programs,
            COUNT(a.id) AS lifetime, MAX(a.class_start_local) AS last_start
       FROM members m
       LEFT JOIN attendance a
         ON a.ghl_contact_id = m.ghl_contact_id AND a.status = 'attended'
      WHERE m.active = 1
      GROUP BY m.ghl_contact_id`,
  ).all();
  const away = [];
  const never = [];
  for (const r of results) {
    const programs = parsePrograms(r.programs);
    const base = {
      ghl_contact_id: r.ghl_contact_id,
      first: r.first_name,
      last: r.last_name,
      programLabels: programs.filter((p) => schedule.programs[p]).map((p) => schedule.programs[p].label),
    };
    if (!r.last_start) {
      never.push(base);
      continue;
    }
    const lastDate = String(r.last_start).slice(0, 10);
    const daysAway = daysBetween(lastDate, todayLocal);
    if (daysAway >= cfg.days) away.push({ ...base, lastDate, daysAway, lifetime: Number(r.lifetime) || 0 });
  }
  const byName = (a, b) => a.first.localeCompare(b.first) || a.last.localeCompare(b.last);
  away.sort((a, b) => b.daysAway - a.daysAway || byName(a, b));
  never.sort(byName);
  return { enabled: true, days: cfg.days, today: todayLocal, away, never };
}

// ---------- attendance trends (§15.6) ----------
export const TREND_WEEKS = 4;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Headcount per class for the last TREND_WEEKS weeks, oldest first, the
 * current week last. Weeks run Mon to Sun on the ET calendar, like the
 * rollup's attendance_week (§6).
 *
 *   weeks  [{ start, end, current, total, people }]   people = distinct members
 *   rows   [{ day, name, start, counts: [n | null] }] one per scheduled class
 *   other  [n]  open mat, and anything not on today's schedule
 *
 * A count is null for a class that has not come round yet this week, so a
 * blank reads differently from a class nobody checked in to. Removed
 * check-ins are not counted.
 */
export async function trends(env, schedule, now, weeks = TREND_WEEKS) {
  const todayLocal = localParts(now, env.TZ || schedule.timezone).date;
  const sinceMonday = (WEEKDAYS.indexOf(weekdayLabel(todayLocal)) + 7) % 7;
  const thisMonday = shiftDate(todayLocal, -sinceMonday);
  const first = shiftDate(thisMonday, -7 * (weeks - 1));
  const { results } = await env.DB.prepare(
    `SELECT ghl_contact_id, class_name, class_start_local
       FROM attendance
      WHERE status = 'attended' AND class_start_local >= ? AND class_start_local < ?`,
  )
    .bind(`${first}T00:00`, `${shiftDate(thisMonday, 7)}T00:00`)
    .all();

  const perClass = new Map();
  for (const r of results) {
    const key = `${r.class_start_local}|${r.class_name}`;
    perClass.set(key, (perClass.get(key) || 0) + 1);
  }

  const outWeeks = [];
  const rowsByKey = new Map();
  const matched = new Set();
  for (let w = 0; w < weeks; w += 1) {
    const start = shiftDate(first, 7 * w);
    outWeeks.push({ start, end: shiftDate(start, 6), current: start === thisMonday, total: 0, people: 0 });
    for (let d = 0; d < 7; d += 1) {
      const date = shiftDate(start, d);
      for (const c of classesOn(schedule, date)) {
        const rowKey = `${d}|${c.start}|${c.name}`;
        if (!rowsByKey.has(rowKey)) {
          rowsByKey.set(rowKey, { day: WEEKDAYS[d], dayIndex: d, name: c.name, start: c.start, counts: new Array(weeks).fill(null) });
        }
        const key = `${c.startLocal}|${c.name}`;
        matched.add(key);
        // A class later this week has not happened: leave it blank.
        rowsByKey.get(rowKey).counts[w] = date > todayLocal ? null : perClass.get(key) || 0;
      }
    }
  }

  const other = new Array(weeks).fill(0);
  const people = outWeeks.map(() => new Set());
  for (const r of results) {
    const w = Math.floor(daysBetween(first, String(r.class_start_local).slice(0, 10)) / 7);
    if (w < 0 || w >= weeks) continue;
    outWeeks[w].total += 1;
    people[w].add(r.ghl_contact_id);
    if (!matched.has(`${r.class_start_local}|${r.class_name}`)) other[w] += 1;
  }
  outWeeks.forEach((wk, i) => { wk.people = people[i].size; });

  const rows = [...rowsByKey.values()]
    .sort((a, b) => a.dayIndex - b.dayIndex || a.start.localeCompare(b.start) || a.name.localeCompare(b.name))
    .map(({ dayIndex, ...row }) => row);
  return { today: todayLocal, weeks: outWeeks, rows, other };
}
