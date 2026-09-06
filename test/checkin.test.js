import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordCheckin } from '../src/checkin.js';
import { UNSCHEDULED_CLASS } from '../src/classes.js';
import { loadSchedule } from '../src/schedule.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const NOW = new Date('2026-09-05T14:55:00Z'); // Sat 10:55 ET
const TODAY = '2026-09-05';

function base(overrides = {}) {
  return {
    contactId: 'c_jack',
    className: 'Kids 6-9',
    classStartLocal: '2026-09-05T11:00',
    clientTs: NOW.toISOString(),
    method: 'kiosk',
    memberActive: true,
    now: NOW,
    todayLocal: TODAY,
    ...overrides,
  };
}

test('first check-in inserts a row, queues a rollup, and counts 1', async () => {
  const DB = memoryD1();
  const r = await recordCheckin({ DB }, schedule, base());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ok: true,
    duplicate: false,
    className: 'Kids 6-9',
    classStartLocal: '2026-09-05T11:00',
    classCount: 1,
    classCountLabel: 'Class #1',
  });
  const row = DB.raw.prepare('SELECT * FROM attendance').get();
  assert.equal(row.ghl_contact_id, 'c_jack');
  assert.equal(row.checked_in_at, NOW.toISOString());
  assert.equal(row.method, 'kiosk');
  assert.equal(row.status, 'attended');
  assert.equal(row.status_at_checkin, 'active');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pending_rollups').get().n, 1);
});

test('duplicate guard: same member + same class start = one row, still ok', async () => {
  const DB = memoryD1();
  await recordCheckin({ DB }, schedule, base());
  const later = new Date(NOW.getTime() + 60_000);
  const r = await recordCheckin({ DB }, schedule, base({ now: later, clientTs: later.toISOString() }));
  assert.equal(r.status, 200);
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.classCount, 1);
  const rows = DB.raw.prepare('SELECT * FROM attendance').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].checked_in_at, NOW.toISOString(), 'original tap time kept');
});

test('a voided row is set back to attended by a new check-in', async () => {
  const DB = memoryD1();
  await recordCheckin({ DB }, schedule, base());
  DB.raw.prepare("UPDATE attendance SET status = 'voided'").run();
  const later = new Date(NOW.getTime() + 120_000);
  const r = await recordCheckin({ DB }, schedule, base({ now: later, clientTs: later.toISOString(), method: 'staff' }));
  assert.equal(r.body.duplicate, false);
  assert.equal(r.body.classCount, 1);
  const row = DB.raw.prepare('SELECT * FROM attendance').get();
  assert.equal(row.status, 'attended');
  assert.equal(row.method, 'staff');
  assert.equal(row.checked_in_at, later.toISOString());
});

test('class count is lifetime attended, excluding voided', async () => {
  const DB = memoryD1();
  await recordCheckin({ DB }, schedule, base({ classStartLocal: '2026-09-01T16:30', now: new Date('2026-09-01T20:30:00Z'), todayLocal: '2026-09-01' }));
  await recordCheckin({ DB }, schedule, base({ classStartLocal: '2026-09-03T16:30', now: new Date('2026-09-03T20:30:00Z'), todayLocal: '2026-09-03' }));
  DB.raw.prepare("UPDATE attendance SET status = 'voided' WHERE class_start_local = '2026-09-01T16:30'").run();
  const r = await recordCheckin({ DB }, schedule, base());
  assert.equal(r.body.classCount, 2);
  assert.equal(r.body.classCountLabel, 'Class #2');
});

test('inactive member is still checked in, with status_at_checkin = inactive', async () => {
  const DB = memoryD1();
  const r = await recordCheckin({ DB }, schedule, base({ memberActive: false }));
  assert.equal(r.status, 200);
  assert.equal(DB.raw.prepare('SELECT status_at_checkin FROM attendance').get().status_at_checkin, 'inactive');
});

test('unscheduled check-in records open mat once per day', async () => {
  const DB = memoryD1();
  const a = await recordCheckin({ DB }, schedule, base({ className: UNSCHEDULED_CLASS, classStartLocal: '2026-09-05T00:00' }));
  const b = await recordCheckin({ DB }, schedule, base({ className: UNSCHEDULED_CLASS, classStartLocal: '2026-09-05T00:00' }));
  assert.equal(a.body.duplicate, false);
  assert.equal(b.body.duplicate, true);
  assert.equal(DB.raw.prepare('SELECT class_name FROM attendance').get().class_name, UNSCHEDULED_CLASS);
});

test('rejects a class that is not on the schedule for that day', async () => {
  const DB = memoryD1();
  const r = await recordCheckin({ DB }, schedule, base({ classStartLocal: '2026-09-05T16:30' }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no such class/);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM attendance').get().n, 0);
});

test('rejects future dates and dates older than the retry window', async () => {
  const DB = memoryD1();
  const future = await recordCheckin({ DB }, schedule, base({ classStartLocal: '2026-09-08T16:30' }));
  assert.equal(future.status, 400);
  assert.match(future.body.error, /future/);
  const old = await recordCheckin({ DB }, schedule, base({ classStartLocal: '2026-09-01T16:30' }));
  assert.equal(old.status, 400);
  assert.match(old.body.error, /past/);
  // Three days back is allowed (queued kiosk retries).
  const ok = await recordCheckin({ DB }, schedule, base({ classStartLocal: '2026-09-02T16:30' }));
  assert.equal(ok.status, 200);
});

test('clientTs is kept when sane, replaced by server time otherwise', async () => {
  const DB = memoryD1();
  const earlier = new Date(NOW.getTime() - 40 * 60_000).toISOString();
  await recordCheckin({ DB }, schedule, base({ clientTs: earlier }));
  assert.equal(DB.raw.prepare('SELECT checked_in_at FROM attendance').get().checked_in_at, earlier);

  const DB2 = memoryD1();
  for (const bad of ['garbage', '2030-01-01T00:00:00Z', undefined, 12345]) {
    DB2.raw.prepare('DELETE FROM attendance').run();
    await recordCheckin({ DB: DB2 }, schedule, base({ clientTs: bad }));
    assert.equal(DB2.raw.prepare('SELECT checked_in_at FROM attendance').get().checked_in_at, NOW.toISOString(), String(bad));
  }
});
