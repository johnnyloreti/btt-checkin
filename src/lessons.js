// lessons.js — lesson notes and week plans (§15.8).
//
// Two levels, so a note for tonight can grow into a curriculum:
//   week plan   one per program per week (Mon to Sun, ET): the theme
//   class note  one per scheduled class: what this class will cover
// The Tonight screen and the class roster show the class note, and fall
// back to the week plan for that class's program.
//
// Staff side only. Both tables arrive with migration 007; until it runs the
// lesson boxes are hidden and nothing else on the staff page changes
// (hasLessonTables in schema-caps.js).

import { classesOn, shiftDate, weekdayOf } from './classes.js';
import { hasLessonTables } from './schema-caps.js';

export const MAX_LESSON_CHARS = 2000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** LESSON_NOTES = "off" (or "0") turns the feature off. Anything else is on. */
export function lessonsEnabled(env = {}) {
  const v = String(env.LESSON_NOTES ?? 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** On, and migration 007 has run. */
export async function lessonsReady(env) {
  return lessonsEnabled(env) && (await hasLessonTables(env));
}

/** The Monday of the week holding `date`. */
export function weekStartOf(date) {
  if (!DATE_RE.test(String(date || ''))) throw Object.assign(new Error('date must be YYYY-MM-DD'), { status: 400 });
  return shiftDate(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

function clean(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_LESSON_CHARS) {
    throw Object.assign(new Error(`a lesson note is at most ${MAX_LESSON_CHARS} characters`), { status: 400 });
  }
  return text;
}

async function requireTables(env) {
  if (!lessonsEnabled(env)) throw Object.assign(new Error('lesson notes are off'), { status: 404 });
  if (!(await hasLessonTables(env))) {
    throw Object.assign(new Error('lesson tables missing: run src/db/migrations/007_lessons.sql'), { status: 503 });
  }
}

/**
 * The lesson for one class: its own note and its program's week plan.
 * Returns null when lessons are off or the migration is pending.
 */
export async function lessonFor(env, schedule, startLocal, className) {
  if (!(await lessonsReady(env))) return null;
  const date = String(startLocal).slice(0, 10);
  const cls = classesOn(schedule, date).find((c) => c.startLocal === startLocal && c.name === className);
  if (!cls) return { enabled: true, scheduled: false };
  const weekStart = weekStartOf(date);
  const [note, plan] = await Promise.all([
    env.DB.prepare('SELECT body FROM class_notes WHERE class_start_local = ? AND class_name = ?').bind(startLocal, className).first(),
    env.DB.prepare('SELECT body FROM lesson_plans WHERE week_start = ? AND program = ?').bind(weekStart, cls.program).first(),
  ]);
  return {
    enabled: true,
    scheduled: true,
    weekStart,
    program: cls.program,
    programLabel: cls.programLabel,
    note: note ? note.body : '',
    plan: plan ? plan.body : '',
  };
}

/**
 * Notes and plans for every class on one date, keyed for the Tonight
 * screen: Map<"startLocal|name", { note, plan }>. Empty when not ready.
 */
export async function lessonsOn(env, schedule, date) {
  const out = new Map();
  if (!(await lessonsReady(env))) return out;
  const classes = classesOn(schedule, date);
  if (classes.length === 0) return out;
  const weekStart = weekStartOf(date);
  const [notes, plans] = await Promise.all([
    env.DB.prepare('SELECT class_start_local, class_name, body FROM class_notes WHERE class_start_local >= ? AND class_start_local < ?')
      .bind(`${date}T00:00`, `${date}T24:00`).all(),
    env.DB.prepare('SELECT program, body FROM lesson_plans WHERE week_start = ?').bind(weekStart).all(),
  ]);
  const noteBy = new Map(notes.results.map((r) => [`${r.class_start_local}|${r.class_name}`, r.body]));
  const planBy = new Map(plans.results.map((r) => [r.program, r.body]));
  for (const c of classes) {
    out.set(`${c.startLocal}|${c.name}`, { note: noteBy.get(`${c.startLocal}|${c.name}`) || '', plan: planBy.get(c.program) || '' });
  }
  return out;
}

/**
 * One week laid out for the Plan screen: each program with its week plan
 * and its classes that week, each class with its note.
 */
export async function weekPlan(env, schedule, anyDate) {
  await requireTables(env);
  const weekStart = weekStartOf(anyDate);
  const weekEnd = shiftDate(weekStart, 6);
  const [notes, plans] = await Promise.all([
    env.DB.prepare('SELECT class_start_local, class_name, body FROM class_notes WHERE class_start_local >= ? AND class_start_local < ?')
      .bind(`${weekStart}T00:00`, `${shiftDate(weekStart, 7)}T00:00`).all(),
    env.DB.prepare('SELECT program, body, updated_at FROM lesson_plans WHERE week_start = ?').bind(weekStart).all(),
  ]);
  const noteBy = new Map(notes.results.map((r) => [`${r.class_start_local}|${r.class_name}`, r.body]));
  const planBy = new Map(plans.results.map((r) => [r.program, r]));
  const programs = Object.entries(schedule.programs).map(([key, p]) => ({ key, label: p.label, plan: planBy.get(key)?.body || '', classes: [] }));
  const byKey = new Map(programs.map((p) => [p.key, p]));
  for (let d = 0; d < 7; d += 1) {
    const date = shiftDate(weekStart, d);
    for (const c of classesOn(schedule, date)) {
      byKey.get(c.program)?.classes.push({
        day: WEEKDAYS[d],
        date,
        name: c.name,
        start: c.start,
        startLocal: c.startLocal,
        note: noteBy.get(`${c.startLocal}|${c.name}`) || '',
      });
    }
  }
  return { enabled: true, weekStart, weekEnd, programs: programs.filter((p) => p.classes.length > 0) };
}

/** Save a program's plan for a week. A blank body removes it. */
export async function savePlan(env, schedule, { weekStart, program, body, now = new Date() }) {
  await requireTables(env);
  if (!DATE_RE.test(String(weekStart || '')) || weekStartOf(weekStart) !== weekStart) {
    throw Object.assign(new Error('weekStart must be a Monday, YYYY-MM-DD'), { status: 400 });
  }
  const key = String(program || '').trim().toLowerCase();
  if (!schedule.programs[key]) throw Object.assign(new Error('unknown program'), { status: 400 });
  const text = clean(body);
  if (!text) {
    await env.DB.prepare('DELETE FROM lesson_plans WHERE week_start = ? AND program = ?').bind(weekStart, key).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO lesson_plans (week_start, program, body, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(week_start, program) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    ).bind(weekStart, key, text, now.toISOString()).run();
  }
  return { ok: true, weekStart, program: key, plan: text };
}

/** Save the note for one scheduled class. A blank body removes it. */
export async function saveNote(env, schedule, { classStartLocal, className, body, now = new Date() }) {
  await requireTables(env);
  const startLocal = String(classStartLocal || '');
  const date = startLocal.slice(0, 10);
  if (!DATE_RE.test(date)) throw Object.assign(new Error('classStartLocal must be YYYY-MM-DDTHH:MM'), { status: 400 });
  const cls = classesOn(schedule, date).find((c) => c.startLocal === startLocal && c.name === className);
  if (!cls) throw Object.assign(new Error('no such class on the schedule'), { status: 400 });
  const text = clean(body);
  if (!text) {
    await env.DB.prepare('DELETE FROM class_notes WHERE class_start_local = ? AND class_name = ?').bind(startLocal, cls.name).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO class_notes (class_start_local, class_name, body, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(class_start_local, class_name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    ).bind(startLocal, cls.name, text, now.toISOString()).run();
  }
  return { ok: true, classStartLocal: startLocal, className: cls.name, note: text };
}
