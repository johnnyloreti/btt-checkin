// Lesson notes and week plans (§15.8). Staff side only: a plan per program
// per week, a note per scheduled class, and the class shows its own note or
// falls back to the week plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, health } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { lessonsEnabled, weekStartOf, MAX_LESSON_CHARS } from '../src/lessons.js';
import { hasLessonTables, resetSchemaCaps } from '../src/schema-caps.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
// Wed Sep 23 2026, 11:00 ET. The week is Mon Sep 21 to Sun Sep 27.
const NOW = new Date('2026-09-23T15:00:00Z');

async function setup({ noLessons = false, extraEnv = {} } = {}) {
  resetFallback();
  const DB = memoryD1({ noLessons });
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', DB, ...extraEnv };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => NOW });
  let cookie = '';
  const call = (path, { method = 'GET', body, anon = false } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(cookie && !anon ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, body) => call(path, { method: 'POST', body });
  return { env, DB, call, post };
}

const WED_KIDS = { classStartLocal: '2026-09-23T16:30', className: 'Kids 6-9' };

test('lessonsEnabled: on unless switched off; weekStartOf finds the Monday', () => {
  assert.equal(lessonsEnabled({}), true);
  assert.equal(lessonsEnabled({ LESSON_NOTES: 'on' }), true);
  for (const off of ['off', 'OFF', '0', 'false']) assert.equal(lessonsEnabled({ LESSON_NOTES: off }), false, off);
  assert.equal(weekStartOf('2026-09-23'), '2026-09-21');
  assert.equal(weekStartOf('2026-09-21'), '2026-09-21', 'a Monday is its own week start');
  assert.equal(weekStartOf('2026-09-27'), '2026-09-21', 'Sunday closes the week');
  assert.throws(() => weekStartOf('next week'), /YYYY-MM-DD/);
});

test('the lesson routes are behind the PIN', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/staff/lessons', { anon: true })).status, 401);
  assert.equal((await call('/api/staff/lessons/plan', { method: 'POST', body: {}, anon: true })).status, 401);
  assert.equal((await call('/api/staff/lessons/note', { method: 'POST', body: {}, anon: true })).status, 401);
});

test('a week plan is per program per week; a class shows its note, or the plan', async () => {
  const { call, post } = await setup();
  assert.equal((await post('/api/staff/lessons/plan', { weekStart: '2026-09-21', program: 'kids-6-9', body: '  Closed guard.\r\nScissor sweep.  ' })).status, 200);

  // Tonight: the Kids 6-9 class carries the plan; the others carry nothing.
  let day = await (await call('/api/staff/today?date=2026-09-23')).json();
  assert.equal(day.lessons, true);
  const kids = (d) => d.classes.find((c) => c.name === 'Kids 6-9');
  assert.deepEqual(kids(day).lesson, { note: '', plan: 'Closed guard.\nScissor sweep.' }, 'trimmed, line endings normalised');
  assert.deepEqual(day.classes.find((c) => c.name === 'Kids 10-14').lesson, { note: '', plan: '' });

  // A note for tonight's class sits on top of the plan.
  assert.equal((await post('/api/staff/lessons/note', { ...WED_KIDS, body: 'No-gi day: sweep from shin-to-shin.' })).status, 200);
  day = await (await call('/api/staff/today?date=2026-09-23')).json();
  assert.deepEqual(kids(day).lesson, { note: 'No-gi day: sweep from shin-to-shin.', plan: 'Closed guard.\nScissor sweep.' });

  // The class roster carries both, with the program and the week.
  const roster = await (await call('/api/staff/class?start=2026-09-23T16:30&name=Kids%206-9')).json();
  assert.deepEqual(roster.lesson, {
    enabled: true, scheduled: true, weekStart: '2026-09-21', program: 'kids-6-9', programLabel: 'Kids 6-9',
    note: 'No-gi day: sweep from shin-to-shin.', plan: 'Closed guard.\nScissor sweep.',
  });

  // Thursday's class in the same week gets the plan but not Wednesday's note.
  const thu = await (await call('/api/staff/class?start=2026-09-24T16:30&name=Kids%206-9')).json();
  assert.equal(thu.lesson.plan, 'Closed guard.\nScissor sweep.');
  assert.equal(thu.lesson.note, '');

  // Next week starts clean.
  const next = await (await call('/api/staff/class?start=2026-09-29T16:30&name=Kids%206-9')).json();
  assert.deepEqual([next.lesson.weekStart, next.lesson.plan, next.lesson.note], ['2026-09-28', '', '']);
});

test('the week view lays out each program with its plan and its classes', async () => {
  const { call, post } = await setup();
  await post('/api/staff/lessons/plan', { weekStart: '2026-09-21', program: 'adult', body: 'Half guard week.' });
  await post('/api/staff/lessons/note', { classStartLocal: '2026-09-26T13:00', className: 'Adult BJJ', body: 'Knee shield to underhook.' });
  // Any day in the week finds the week.
  const week = await (await call('/api/staff/lessons?week=2026-09-25')).json();
  assert.equal(week.weekStart, '2026-09-21');
  assert.equal(week.weekEnd, '2026-09-27');
  assert.deepEqual(week.programs.map((p) => p.key), ['kids-3-5', 'kids-6-9', 'kids-10-14', 'adult']);
  const adult = week.programs.find((p) => p.key === 'adult');
  assert.equal(adult.label, 'Adult');
  assert.equal(adult.plan, 'Half guard week.');
  assert.deepEqual(adult.classes.map((c) => [c.day, c.date, c.name, c.start, c.note]), [
    ['Tue', '2026-09-22', 'Adult BJJ', '18:15', ''],
    ['Wed', '2026-09-23', 'Adult No-Gi', '18:15', ''],
    ['Thu', '2026-09-24', 'Adult BJJ', '18:15', ''],
    ['Sat', '2026-09-26', 'Adult BJJ', '13:00', 'Knee shield to underhook.'],
  ]);
  // With no week given it is this week.
  assert.equal((await (await call('/api/staff/lessons')).json()).weekStart, '2026-09-21');
});

test('saving again replaces, and a blank save removes', async () => {
  const { post, DB } = await setup();
  await post('/api/staff/lessons/note', { ...WED_KIDS, body: 'First draft' });
  await post('/api/staff/lessons/note', { ...WED_KIDS, body: 'Second draft' });
  assert.deepEqual(DB.raw.prepare('SELECT body FROM class_notes').all().map((r) => r.body), ['Second draft']);
  const cleared = await (await post('/api/staff/lessons/note', { ...WED_KIDS, body: '   ' })).json();
  assert.equal(cleared.note, '');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM class_notes').get().n, 0);

  await post('/api/staff/lessons/plan', { weekStart: '2026-09-21', program: 'adult', body: 'One' });
  await post('/api/staff/lessons/plan', { weekStart: '2026-09-21', program: 'adult', body: 'Two' });
  assert.deepEqual(DB.raw.prepare('SELECT body FROM lesson_plans').all().map((r) => r.body), ['Two']);
  await post('/api/staff/lessons/plan', { weekStart: '2026-09-21', program: 'adult', body: '' });
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM lesson_plans').get().n, 0);
});

test('bad input is refused and writes nothing', async () => {
  const { post, DB } = await setup();
  const plan = (b) => post('/api/staff/lessons/plan', { weekStart: '2026-09-21', program: 'adult', body: 'x', ...b });
  assert.equal((await plan({ weekStart: '2026-09-23' })).status, 400, 'not a Monday');
  assert.equal((await plan({ weekStart: 'soon' })).status, 400);
  assert.equal((await plan({ program: 'judo' })).status, 400);
  assert.equal((await plan({ body: 'x'.repeat(MAX_LESSON_CHARS + 1) })).status, 400);
  assert.equal((await plan({ body: 'x'.repeat(MAX_LESSON_CHARS) })).status, 200, 'exactly the limit is fine');

  const note = (b) => post('/api/staff/lessons/note', { ...WED_KIDS, body: 'x', ...b });
  assert.equal((await note({ classStartLocal: '2026-09-25T16:30' })).status, 400, 'no classes on a Friday');
  assert.equal((await note({ className: 'Adult BJJ' })).status, 400, 'not the class at that time');
  assert.equal((await note({ classStartLocal: 'tonight' })).status, 400);
  assert.equal((await note({ classStartLocal: '2026-09-23T00:00', className: 'open mat / unscheduled' })).status, 400, 'open mat has no lesson');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM class_notes').get().n, 0);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM lesson_plans').get().n, 1);
});

test('a lesson is stored as text and comes back as text', async () => {
  const { post, call } = await setup();
  const body = '<script>alert(1)</script> & "quotes"';
  await post('/api/staff/lessons/note', { ...WED_KIDS, body });
  const roster = await (await call('/api/staff/class?start=2026-09-23T16:30&name=Kids%206-9')).json();
  assert.equal(roster.lesson.note, body, 'the page renders it with textContent');
});

test('open mat and off-schedule rosters carry no lesson box', async () => {
  const { call } = await setup();
  const openMat = await (await call('/api/staff/class?start=2026-09-23T00:00&name=open%20mat%20%2F%20unscheduled')).json();
  assert.deepEqual(openMat.lesson, { enabled: true, scheduled: false });
});

test('switched off: no lessons on the screens, the routes are gone, /health is quiet', async () => {
  const { env, call, post } = await setup({ noLessons: true, extraEnv: { LESSON_NOTES: 'off' } });
  const day = await (await call('/api/staff/today?date=2026-09-23')).json();
  assert.equal(day.lessons, false);
  assert.ok(day.classes.every((c) => c.lesson === undefined));
  assert.equal((await call('/api/staff/lessons')).status, 404);
  assert.equal((await post('/api/staff/lessons/note', { ...WED_KIDS, body: 'x' })).status, 404);
  assert.doesNotMatch(JSON.stringify(await health(env, schedule, NOW)), /007_lessons/);
  resetSchemaCaps();
});

test('before migration 007: the staff screens work without lessons, saves name the file, check-in is untouched', async () => {
  const { env, call, post } = await setup({ noLessons: true });
  assert.equal(await hasLessonTables(env), false);

  const day = await call('/api/staff/today?date=2026-09-23');
  assert.equal(day.status, 200, 'Tonight still loads');
  const body = await day.json();
  assert.equal(body.lessons, false);
  assert.equal(body.classes.length, 3);
  assert.ok(body.classes.every((c) => c.lesson === undefined));

  const roster = await call('/api/staff/class?start=2026-09-23T16:30&name=Kids%206-9');
  assert.equal(roster.status, 200, 'the roster still loads');
  assert.equal((await roster.json()).lesson, null);

  const refused = await post('/api/staff/lessons/note', { ...WED_KIDS, body: 'x' });
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /007_lessons\.sql/);
  assert.equal((await call('/api/staff/lessons')).status, 503);

  const checkin = await call('/api/checkin', { method: 'POST', anon: true, body: { contactId: await opaqueId('c_emma', SALT), className: 'Kids 6-9', classStartLocal: '2026-09-23T16:30' } });
  assert.equal(checkin.status, 200);

  const h = await health(env, schedule, NOW);
  assert.equal(h.ok, false);
  assert.match(JSON.stringify(h), /007_lessons\.sql/);
  resetSchemaCaps();
});
