// time.js — wall-clock helpers for the gym's timezone.
// Everything the kiosk and staff see is ET. Storage is ISO UTC except
// class_start_local, which is the scheduled ET start ("2026-09-06T17:00").

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/**
 * Break a Date into local wall-clock parts in the given IANA timezone.
 * Returns { year, month, day, hour, minute, second, weekday, date, time }
 * where weekday is "Mon".."Sun", date is "YYYY-MM-DD", time is "HH:MM".
 */
export function localParts(date, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = Number(parts.hour) % 24; // some engines emit "24" at midnight
  const out = {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday.slice(0, 3),
  };
  if (!DAY_NAMES.includes(out.weekday)) throw new Error(`unexpected weekday "${parts.weekday}"`);
  out.date = `${out.year}-${pad(out.month)}-${pad(out.day)}`;
  out.time = `${pad(out.hour)}:${pad(out.minute)}`;
  return out;
}

export function pad(n) {
  return String(n).padStart(2, '0');
}
