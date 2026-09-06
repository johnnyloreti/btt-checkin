// schedule.js — load and validate schedule.json.
// The JSON shape here is the internal contract. V1.1 will feed it from the
// GHL calendar sync instead of a committed file; nothing downstream changes.

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ScheduleError extends Error {
  constructor(message) {
    super(`schedule.json: ${message}`);
    this.name = 'ScheduleError';
  }
}

/** Parse a "HH:MM" string to minutes after midnight. Throws on bad input. */
export function parseTime(str) {
  const m = TIME_RE.exec(str);
  if (!m) throw new ScheduleError(`bad start time "${str}", expected HH:MM 24-hour`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Parse schedule text. Tolerates a UTF-8 BOM and CRLF line endings, since
 * the file is edited on Windows. Then validates.
 */
export function loadSchedule(text) {
  if (typeof text !== 'string') throw new ScheduleError('expected text');
  const clean = text.replace(/^﻿/, '');
  let obj;
  try {
    obj = JSON.parse(clean);
  } catch (e) {
    throw new ScheduleError(`invalid JSON (${e.message})`);
  }
  return validateSchedule(obj);
}

/**
 * Validate a parsed schedule object. Returns the same object on success.
 * Rules:
 *  - timezone is a non-empty string
 *  - programs is a non-empty map of key → { label, tag }
 *  - every class has a name, a known program, one or more valid days,
 *    a valid HH:MM start, and positive integer minutes
 *  - no two classes of the same program overlap on the same day
 */
export function validateSchedule(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new ScheduleError('root must be an object');
  if (typeof s.timezone !== 'string' || !s.timezone) throw new ScheduleError('missing timezone');

  if (!s.programs || typeof s.programs !== 'object' || Array.isArray(s.programs)) {
    throw new ScheduleError('programs must be an object');
  }
  const programKeys = Object.keys(s.programs);
  if (programKeys.length === 0) throw new ScheduleError('programs is empty');
  for (const key of programKeys) {
    const p = s.programs[key];
    if (!p || typeof p.label !== 'string' || !p.label) throw new ScheduleError(`program "${key}" needs a label`);
    if (typeof p.tag !== 'string' || !p.tag) throw new ScheduleError(`program "${key}" needs a tag`);
  }

  if (!Array.isArray(s.classes) || s.classes.length === 0) throw new ScheduleError('classes must be a non-empty array');

  // Per program+day list of [startMin, endMin, name] to check overlap.
  const seen = new Map();
  s.classes.forEach((c, i) => {
    const where = `classes[${i}]`;
    if (!c || typeof c !== 'object') throw new ScheduleError(`${where} must be an object`);
    if (typeof c.name !== 'string' || !c.name.trim()) throw new ScheduleError(`${where} needs a name`);
    if (!programKeys.includes(c.program)) throw new ScheduleError(`${where} "${c.name}" has unknown program "${c.program}"`);
    if (!Array.isArray(c.days) || c.days.length === 0) throw new ScheduleError(`${where} "${c.name}" needs days`);
    for (const d of c.days) {
      if (!DAYS.includes(d)) throw new ScheduleError(`${where} "${c.name}" has bad day "${d}", expected one of ${DAYS.join(', ')}`);
    }
    if (new Set(c.days).size !== c.days.length) throw new ScheduleError(`${where} "${c.name}" repeats a day`);
    let start;
    try {
      start = parseTime(c.start);
    } catch (e) {
      throw new ScheduleError(`${where} "${c.name}": ${e.message.replace(/^schedule\.json: /, '')}`);
    }
    if (!Number.isInteger(c.minutes) || c.minutes <= 0) throw new ScheduleError(`${where} "${c.name}" needs positive integer minutes`);
    const end = start + c.minutes;
    if (end > 24 * 60) throw new ScheduleError(`${where} "${c.name}" runs past midnight`);

    for (const d of c.days) {
      const k = `${c.program}|${d}`;
      const list = seen.get(k) || [];
      for (const [s0, e0, n0] of list) {
        if (start < e0 && s0 < end) {
          throw new ScheduleError(`"${c.name}" overlaps "${n0}" on ${d} (program ${c.program})`);
        }
      }
      list.push([start, end, c.name]);
      seen.set(k, list);
    }
  });

  return s;
}
