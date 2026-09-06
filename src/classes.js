// classes.js — which class is "now" (§2), computed server-side from the
// schedule. All wall-clock math is in the schedule's timezone.

import { localParts, pad } from './time.js';
import { parseTime } from './schedule.js';

/** Check-in window: from EARLY_MIN before start to LATE_MIN after. */
export const EARLY_MIN = 45;
export const LATE_MIN = 15;

export const UNSCHEDULED_CLASS = 'open mat / unscheduled';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const START_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday name for a "YYYY-MM-DD" string, independent of host timezone. */
export function weekdayOf(dateStr) {
  const m = DATE_RE.exec(dateStr);
  if (!m) throw new Error(`bad date "${dateStr}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) throw new Error(`bad date "${dateStr}"`);
  return DAY_NAMES[d.getUTCDay()];
}

/** Shift a "YYYY-MM-DD" string by whole days. */
export function shiftDate(dateStr, days) {
  const m = DATE_RE.exec(dateStr);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Every scheduled class on a given local date, with its class_start_local. */
export function classesOn(schedule, dateStr) {
  const weekday = weekdayOf(dateStr);
  return schedule.classes
    .filter((c) => c.days.includes(weekday))
    .map((c) => ({
      name: c.name,
      program: c.program,
      programLabel: schedule.programs[c.program].label,
      start: c.start,
      startMin: parseTime(c.start),
      minutes: c.minutes,
      startLocal: `${dateStr}T${c.start}`,
    }))
    .sort((a, b) => a.startMin - b.startMin);
}

/**
 * Classes whose check-in window contains `now`. Not filtered by program;
 * the kiosk intersects this with the member's programs, which is what
 * disambiguates back-to-back kids classes. The window alone never decides.
 */
export function matchClasses(schedule, now, tz, { earlyMin = EARLY_MIN, lateMin = LATE_MIN } = {}) {
  const local = localParts(now, tz);
  const nowMin = local.hour * 60 + local.minute;
  const matches = classesOn(schedule, local.date)
    .filter((c) => nowMin >= c.startMin - earlyMin && nowMin <= c.startMin + lateMin)
    .map((c) => ({ ...c, startsInMin: c.startMin - nowMin }));
  return {
    now: now.toISOString(),
    nowLocal: `${local.date}T${local.time}`,
    date: local.date,
    weekday: local.weekday,
    window: { earlyMin, lateMin },
    matches: matches.map(({ startMin, ...rest }) => rest),
  };
}

/**
 * Validate a check-in's class choice against the schedule.
 * Returns { ok, error, className, classStartLocal, date }.
 */
export function validateClassChoice(schedule, className, classStartLocal) {
  const m = START_LOCAL_RE.exec(String(classStartLocal || ''));
  if (!m) return { ok: false, error: 'classStartLocal must be YYYY-MM-DDTHH:MM' };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  let weekday;
  try {
    weekday = weekdayOf(date);
  } catch {
    return { ok: false, error: 'classStartLocal has an invalid date' };
  }
  const time = `${m[4]}:${m[5]}`;

  if (className === UNSCHEDULED_CLASS) {
    if (time !== '00:00') return { ok: false, error: 'unscheduled check-ins use T00:00' };
    return { ok: true, className, classStartLocal, date, weekday };
  }
  const hit = schedule.classes.find((c) => c.name === className && c.start === time && c.days.includes(weekday));
  if (!hit) return { ok: false, error: 'no such class at that time' };
  return { ok: true, className, classStartLocal, date, weekday, program: hit.program };
}
