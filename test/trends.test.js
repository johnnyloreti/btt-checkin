// Attendance trends (§15.6): headcount per class for the last four weeks,
// Monday to Sunday on the ET calendar, the current week last.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { TREND_WEEKS } from '../src/staff.js';
import { loadSchedule } from '../src/schedule.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
// Wed Sep 23 2026, 11:00 ET. This week is Mon Sep 21 to Sun Sep 27.
const NOW = new Date('2026-09-23T15:00:00Z');

async function setup(now = NOW) {
  resetFallback();
  const DB = memoryD1();
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(now.getTime() - 3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), now: () => now });
  let cookie = '';
  const call = (path, { method = 'GET', body, anon = false } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(cookie && !anon ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const attend = (contactId, startLocal, className, status = 'attended') =>
    DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status) VALUES (?, ?, ?, ?, 'kiosk', ?)")
      .run(contactId, className, startLocal, `${startLocal}:00Z`, status);
  const trends = async () => (await call('/api/staff/trends')).json();
  return { call, attend, trends };
}

const row = (body, day, name) => body.rows.find((r) => r.day === day && r.name === name);

test('trends are behind the PIN', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/staff/trends', { anon: true })).status, 401);
});

test('four Monday-to-Sunday weeks, oldest first, this week last', async () => {
  const { trends } = await setup();
  const body = await trends();
  assert.equal(TREND_WEEKS, 4);
  assert.equal(body.today, '2026-09-23');
  assert.deepEqual(body.weeks.map((w) => [w.start, w.end, w.current]), [
    ['2026-08-31', '2026-09-06', false],
    ['2026-09-07', '2026-09-13', false],
    ['2026-09-14', '2026-09-20', false],
    ['2026-09-21', '2026-09-27', true],
  ]);
  // One row per scheduled class, in week order then by start time.
  assert.deepEqual(body.rows.map((r) => `${r.day} ${r.start} ${r.name}`), [
    'Tue 16:00 Kids 3-5', 'Tue 16:30 Kids 6-9', 'Tue 17:15 Kids 10-14', 'Tue 18:15 Adult BJJ',
    'Wed 16:30 Kids 6-9', 'Wed 17:15 Kids 10-14', 'Wed 18:15 Adult No-Gi',
    'Thu 16:00 Kids 3-5', 'Thu 16:30 Kids 6-9', 'Thu 17:15 Kids 10-14', 'Thu 18:15 Adult BJJ',
    'Sat 10:30 Kids 3-5', 'Sat 11:00 Kids 6-9', 'Sat 11:45 Kids 10-14', 'Sat 13:00 Adult BJJ',
  ]);
  assert.deepEqual(body.other, [0, 0, 0, 0]);
});

test('counts land on their class and week; a class later this week is blank, not zero', async () => {
  const { attend, trends } = await setup();
  attend('c_jack', '2026-09-01T16:30', 'Kids 6-9'); // Tue, week 1
  attend('c_emma', '2026-09-01T16:30', 'Kids 6-9');
  attend('c_jack', '2026-09-15T16:30', 'Kids 6-9'); // Tue, week 3
  attend('c_jack', '2026-09-22T16:30', 'Kids 6-9'); // Tue, this week
  attend('c_dan', '2026-09-19T13:00', 'Adult BJJ'); // Sat, week 3
  const body = await trends();
  assert.deepEqual(row(body, 'Tue', 'Kids 6-9').counts, [2, 0, 1, 1]);
  assert.deepEqual(row(body, 'Sat', 'Adult BJJ').counts, [0, 0, 1, null], 'Saturday has not come round yet');
  assert.deepEqual(row(body, 'Wed', 'Kids 6-9').counts, [0, 0, 0, 0], 'today counts, even at zero');
  assert.deepEqual(row(body, 'Thu', 'Kids 6-9').counts, [0, 0, 0, null]);
  assert.deepEqual(body.weeks.map((w) => w.total), [2, 0, 2, 1]);
  assert.deepEqual(body.weeks.map((w) => w.people), [2, 0, 2, 1]);
});

test('members who trained counts a person once a week, however many classes', async () => {
  const { attend, trends } = await setup();
  attend('c_jack', '2026-09-15T16:30', 'Kids 6-9');
  attend('c_jack', '2026-09-16T16:30', 'Kids 6-9');
  attend('c_jack', '2026-09-17T16:30', 'Kids 6-9');
  attend('c_emma', '2026-09-17T16:30', 'Kids 6-9');
  const body = await trends();
  assert.equal(body.weeks[2].total, 4);
  assert.equal(body.weeks[2].people, 2);
});

test('removed check-ins are not counted, and anything older than four weeks is left out', async () => {
  const { attend, trends } = await setup();
  attend('c_jack', '2026-09-15T16:30', 'Kids 6-9', 'voided');
  attend('c_emma', '2026-08-29T11:00', 'Kids 6-9'); // the Saturday before week 1
  attend('c_emma', '2026-08-31T00:00', 'open mat / unscheduled'); // Monday of week 1
  const body = await trends();
  assert.deepEqual(row(body, 'Tue', 'Kids 6-9').counts, [0, 0, 0, 0]);
  assert.deepEqual(body.weeks.map((w) => w.total), [1, 0, 0, 0]);
});

test('open mat and off-schedule check-ins go to the other row', async () => {
  const { attend, trends } = await setup();
  attend('c_dan', '2026-09-14T00:00', 'open mat / unscheduled'); // Monday, no classes
  attend('c_dan', '2026-09-18T18:15', 'Adult BJJ');               // a Friday class that is not on the schedule
  attend('c_dan', '2026-09-17T18:15', 'Adult BJJ');               // a real Thursday class
  const body = await trends();
  assert.deepEqual(body.other, [0, 0, 2, 0]);
  assert.deepEqual(row(body, 'Thu', 'Adult BJJ').counts, [0, 0, 1, null]);
  assert.equal(body.weeks[2].total, 3);
  assert.equal(body.weeks[2].people, 1);
});

test('the week turns over on the ET calendar', async () => {
  // 03:30 UTC Monday Sep 28 is still Sunday Sep 27 in New York.
  const sundayNight = await setup(new Date('2026-09-28T03:30:00Z'));
  const a = await sundayNight.trends();
  assert.equal(a.today, '2026-09-27');
  assert.equal(a.weeks[3].start, '2026-09-21');
  assert.deepEqual(row(a, 'Sat', 'Adult BJJ').counts, [0, 0, 0, 0], 'the whole week has happened');

  const mondayMorning = await setup(new Date('2026-09-28T13:00:00Z'));
  const b = await mondayMorning.trends();
  assert.equal(b.weeks[3].start, '2026-09-28');
  assert.deepEqual(row(b, 'Tue', 'Kids 6-9').counts, [0, 0, 0, null]);
});
