import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRollup, mondayOf, runRollup, resetFieldCache, rollupBatch, FIELD_KEYS, DEFAULT_ROLLUP_BATCH, MAX_ROLLUP_BATCH } from '../src/rollup.js';
import { fetchCustomFieldIds, ghlPutContactCustomFields } from '../src/ghl.js';
import { loadSchedule } from '../src/schedule.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const rows = (...dates) => dates.map((d) => ({ class_start_local: d.length === 10 ? `${d}T16:30` : d }));

test('mondayOf finds the Mon-Sun week', () => {
  assert.equal(mondayOf('2026-09-05'), '2026-08-31'); // Sat
  assert.equal(mondayOf('2026-09-06'), '2026-08-31'); // Sun stays in the week that started Mon Aug 31
  assert.equal(mondayOf('2026-09-07'), '2026-09-07'); // Mon
  assert.equal(mondayOf('2026-01-01'), '2025-12-29'); // Thu across a year boundary
});

test('rollup math: last, 30d, week, lifetime, label', () => {
  const today = '2026-09-05'; // Saturday
  const r = computeRollup(
    rows(
      '2026-09-05T11:00', // today, this week
      '2026-09-03', // Thu, this week
      '2026-09-01', // Tue, this week
      '2026-08-29', // last Sat, in 30d, not this week
      '2026-08-07', // exactly 29 days back: in 30d window
      '2026-08-06', // 30 days back: out
      '2026-07-01', // lifetime only
    ),
    today,
  );
  assert.deepEqual(r, {
    attendance_last: '2026-09-05',
    attendance_30d: 5,
    attendance_lifetime: 7,
    attendance_week: 3,
    attendance_class_count_label: 'Class #7',
  });
});

test('rollup math: Sunday counts the week that ends on it, Monday 03:00 starts fresh', () => {
  const sun = computeRollup(rows('2026-09-01', '2026-09-05', '2026-09-06T00:00'), '2026-09-06');
  assert.equal(sun.attendance_week, 3);
  const mon = computeRollup(rows('2026-09-01', '2026-09-05', '2026-09-06T00:00'), '2026-09-07');
  assert.equal(mon.attendance_week, 0);
  assert.equal(mon.attendance_30d, 3);
});

test('rollup math: no attendance', () => {
  assert.deepEqual(computeRollup([], '2026-09-05'), {
    attendance_last: '',
    attendance_30d: 0,
    attendance_lifetime: 0,
    attendance_week: 0,
    attendance_class_count_label: 'Class #0',
  });
});

test('fetchCustomFieldIds maps keys to ids and strips the contact. prefix', async () => {
  const impl = async () =>
    Response.json({
      customFields: [
        { id: 'f1', fieldKey: 'contact.attendance_last', name: 'Attendance last' },
        { id: 'f2', fieldKey: 'contact.attendance_30d' },
        { id: 'f3', name: 'attendance_lifetime' },
        { id: 'f4', fieldKey: 'contact.Attendance_Week' },
        { id: 'zz', fieldKey: 'contact.something_else' },
      ],
    });
  const map = await fetchCustomFieldIds({ GHL_TOKEN: 't', GHL_LOCATION_ID: 'LOC' }, impl);
  assert.equal(map.get('attendance_last'), 'f1');
  assert.equal(map.get('attendance_30d'), 'f2');
  assert.equal(map.get('attendance_lifetime'), 'f3');
  assert.equal(map.get('attendance_week'), 'f4');
  assert.equal(map.get('attendance_class_count_label'), undefined);
});

test('ghlPutContactCustomFields sends exactly one PUT to /contacts/{id} with custom fields only', async () => {
  const calls = [];
  const impl = async (url, init) => (calls.push({ url, init }), Response.json({ contact: { id: 'c1' } }));
  await ghlPutContactCustomFields({ GHL_TOKEN: 't', GHL_LOCATION_ID: 'LOC' }, 'c1', [{ id: 'f1', field_value: '2026-09-05' }], impl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].url, 'https://services.leadconnectorhq.com/contacts/c1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { customFields: [{ id: 'f1', field_value: '2026-09-05' }] });
  assert.equal(calls[0].init.headers.authorization, 'Bearer t');
  await assert.rejects(() => ghlPutContactCustomFields({ GHL_TOKEN: 't' }, 'c1', [], impl), /no fields/);
  const bad = async () => new Response('nope', { status: 422 });
  await assert.rejects(() => ghlPutContactCustomFields({ GHL_TOKEN: 't' }, 'c1', [{ id: 'f1', field_value: 'x' }], bad), /GHL 422/);
});

// ---------- runRollup ----------
const NOW = new Date('2026-09-06T07:00:00Z'); // 03:00 EDT Sunday Sep 6
const ALL_FIELDS = new Map(FIELD_KEYS.map((k, i) => [k, `id_${i}`]));

function seeded() {
  const DB = memoryD1();
  const ins = DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status) VALUES (?, 'Kids 6-9', ?, ?, 'kiosk', ?)");
  ins.run('c_jack', '2026-09-05T11:00', '2026-09-05T14:55:00Z', 'attended');
  ins.run('c_jack', '2026-09-03T16:30', '2026-09-03T20:25:00Z', 'attended');
  ins.run('c_jack', '2026-08-01T16:30', '2026-08-01T20:25:00Z', 'voided');
  ins.run('c_emma', '2026-09-05T11:00', '2026-09-05T14:56:00Z', 'attended');
  ins.run('c_leo', '2026-07-05T11:00', '2026-07-05T14:56:00Z', 'attended'); // not pending
  DB.raw.prepare("INSERT INTO pending_rollups VALUES ('c_jack', '2026-09-05T14:55:00Z'), ('c_emma', '2026-09-05T14:56:00Z')").run();
  return DB;
}

test('runRollup pushes only pending contacts, clears them, logs ok', async () => {
  resetFieldCache();
  const DB = seeded();
  const puts = [];
  const r = await runRollup({ DB, TZ: 'America/New_York' }, schedule, {
    fetchFields: async () => ALL_FIELDS,
    putContact: async (id, fields) => puts.push({ id, fields }),
    now: NOW,
  });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.pushed, 2);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.missingFields, []);
  assert.deepEqual(puts.map((p) => p.id), ['c_jack', 'c_emma']);
  const jack = Object.fromEntries(puts[0].fields.map((f) => [f.id, f.field_value]));
  assert.deepEqual(jack, { id_0: '2026-09-05', id_1: '2', id_2: '2', id_3: '2', id_4: 'Class #2' }, 'voided row excluded, week is Mon Aug 31 to Sun Sep 6');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pending_rollups').get().n, 0);
  const log = DB.raw.prepare("SELECT outcome, detail FROM sync_log WHERE job = 'rollup'").all();
  assert.equal(log.length, 1);
  assert.equal(log[0].outcome, 'ok');
});

test('runRollup: a missing custom field is skipped and logged degraded, the rest push', async () => {
  resetFieldCache();
  const DB = seeded();
  const fields = new Map(ALL_FIELDS);
  fields.delete('attendance_class_count_label');
  const puts = [];
  const r = await runRollup({ DB, TZ: 'America/New_York' }, schedule, {
    fetchFields: async () => fields,
    putContact: async (id, f) => puts.push(f),
    now: NOW,
  });
  assert.equal(r.outcome, 'degraded');
  assert.deepEqual(r.missingFields, ['attendance_class_count_label']);
  assert.equal(r.pushed, 2);
  assert.equal(puts[0].length, 4);
  assert.ok(!puts[0].some((f) => f.id === 'id_4'));
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pending_rollups').get().n, 0);
  assert.match(DB.raw.prepare("SELECT detail FROM sync_log WHERE job = 'rollup'").get().detail, /attendance_class_count_label/);
});

test('runRollup: a failed push stays pending for the next night', async () => {
  resetFieldCache();
  const DB = seeded();
  const r = await runRollup({ DB, TZ: 'America/New_York' }, schedule, {
    fetchFields: async () => ALL_FIELDS,
    putContact: async (id) => {
      if (id === 'c_emma') throw new Error('GHL 429 on /contacts/c_emma');
    },
    now: NOW,
  });
  assert.equal(r.outcome, 'degraded');
  assert.equal(r.pushed, 1);
  assert.equal(r.failed, 1);
  assert.match(r.failures[0], /c_emma.*429/);
  assert.deepEqual(DB.raw.prepare('SELECT ghl_contact_id FROM pending_rollups').all().map((x) => x.ghl_contact_id), ['c_emma']);
});

test('runRollup: every push failing is failed, nothing cleared', async () => {
  resetFieldCache();
  const DB = seeded();
  const r = await runRollup({ DB, TZ: 'America/New_York' }, schedule, {
    fetchFields: async () => ALL_FIELDS,
    putContact: async () => {
      throw new Error('GHL 401');
    },
    now: NOW,
  });
  assert.equal(r.outcome, 'failed');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pending_rollups').get().n, 2);
});

test('runRollup: cannot resolve fields, or none exist, is failed and touches nothing', async () => {
  resetFieldCache();
  const DB = seeded();
  let r = await runRollup({ DB, TZ: 'America/New_York' }, schedule, {
    fetchFields: async () => {
      throw new Error('GHL 403 on /locations/x/customFields');
    },
    putContact: async () => assert.fail('must not push'),
    now: NOW,
  });
  assert.equal(r.outcome, 'failed');
  assert.match(r.error, /403/);
  r = await runRollup({ DB, TZ: 'America/New_York' }, schedule, {
    fetchFields: async () => new Map([['unrelated', 'x']]),
    putContact: async () => assert.fail('must not push'),
    now: NOW,
  });
  assert.equal(r.outcome, 'failed');
  assert.equal(r.missingFields.length, 5);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pending_rollups').get().n, 2);
  assert.deepEqual(DB.raw.prepare("SELECT outcome FROM sync_log WHERE job = 'rollup' ORDER BY id").all().map((x) => x.outcome), ['failed', 'failed']);
});

test('runRollup: nothing pending is ok and cheap', async () => {
  resetFieldCache();
  const DB = memoryD1();
  let fetched = 0;
  const r = await runRollup({ DB, TZ: 'America/New_York' }, schedule, {
    fetchFields: async () => (fetched += 1, ALL_FIELDS),
    putContact: async () => assert.fail('must not push'),
    now: NOW,
  });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.pushed, 0);
  // Field ids are cached for an hour.
  await runRollup({ DB, TZ: 'America/New_York' }, schedule, { fetchFields: async () => (fetched += 1, ALL_FIELDS), putContact: async () => {}, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(fetched, 1);
  resetFieldCache();
});

// ---------- batches across ticks ----------
//
// One GHL call per contact, and an invocation only gets so many. A night
// with more pending than one batch is finished on the ticks that follow.

function crowd(n, { at = '2026-09-05T15:00:00Z' } = {}) {
  const DB = memoryD1();
  const att = DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status) VALUES (?, 'Adult BJJ', '2026-09-05T13:00', ?, 'kiosk', 'attended')");
  const pend = DB.raw.prepare('INSERT INTO pending_rollups VALUES (?, ?)');
  for (let i = 0; i < n; i += 1) {
    const id = `c_${String(i).padStart(3, '0')}`;
    att.run(id, at);
    // Several share a queue time, as they do when a class checks in together.
    pend.run(id, new Date(Date.parse(at) + Math.floor(i / 3) * 1000).toISOString());
  }
  return DB;
}
const tick = (n) => new Date(NOW.getTime() + n * 30 * 60_000);

test('rollupBatch: 20 unless set, never under 1, never over the cap', () => {
  assert.equal(rollupBatch({}), DEFAULT_ROLLUP_BATCH);
  assert.equal(DEFAULT_ROLLUP_BATCH, 20);
  assert.equal(rollupBatch({ ROLLUP_BATCH: '8' }), 8);
  assert.equal(rollupBatch({ ROLLUP_BATCH: '0' }), 20);
  assert.equal(rollupBatch({ ROLLUP_BATCH: 'lots' }), 20);
  assert.equal(rollupBatch({ ROLLUP_BATCH: '500' }), MAX_ROLLUP_BATCH);
});

test('a night bigger than one batch is pushed over several ticks, each contact once, oldest first', async () => {
  resetFieldCache();
  const DB = crowd(47);
  const env = { DB, TZ: 'America/New_York' };
  const puts = [];
  const deps = (now, resume) => ({ fetchFields: async () => ALL_FIELDS, putContact: async (id) => puts.push(id), now, resume });

  const first = await runRollup(env, schedule, deps(tick(0), false));
  assert.deepEqual([first.outcome, first.pushed, first.remaining, first.pending], ['ok', 20, 27, 47]);
  assert.equal(puts.length, 20, 'no more GHL calls than the batch');
  const second = await runRollup(env, schedule, deps(tick(1), true));
  assert.deepEqual([second.pushed, second.remaining], [20, 7]);
  const third = await runRollup(env, schedule, deps(tick(2), true));
  assert.deepEqual([third.pushed, third.remaining], [7, 0]);

  assert.equal(puts.length, 47);
  assert.equal(new Set(puts).size, 47, 'nobody pushed twice');
  assert.deepEqual(puts, [...puts].sort(), 'oldest first; ties by id');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pending_rollups').get().n, 0);

  // Done: the ticks after it are one read and nothing else.
  const idle = await runRollup(env, schedule, deps(tick(3), true));
  assert.deepEqual(idle, { did: false, outcome: 'ok' });
  assert.equal(puts.length, 47);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE job = 'rollup'").get().n, 3, 'an idle tick writes no log row');
});

test('a check-in during the day waits for the night, even while a run is still being finished', async () => {
  resetFieldCache();
  const DB = crowd(25);
  const env = { DB, TZ: 'America/New_York' };
  const puts = [];
  const deps = (now, resume) => ({ fetchFields: async () => ALL_FIELDS, putContact: async (id) => puts.push(id), now, resume });
  await runRollup(env, schedule, deps(tick(0), false));
  // Someone checks in after the run began.
  DB.raw.prepare('INSERT INTO pending_rollups VALUES (?, ?)').run('c_late', tick(0.5).toISOString());
  const more = await runRollup(env, schedule, deps(tick(1), true));
  assert.deepEqual([more.pushed, more.remaining], [5, 0]);
  assert.ok(!puts.includes('c_late'));
  assert.deepEqual(DB.raw.prepare('SELECT ghl_contact_id FROM pending_rollups').all().map((r) => r.ghl_contact_id), ['c_late']);
  // With no run in flight, a tick during the day pushes nothing.
  assert.deepEqual(await runRollup(env, schedule, deps(tick(2), true)), { did: false, outcome: 'ok' });
  // That night it goes.
  const night = await runRollup(env, schedule, deps(tick(48), false));
  assert.equal(night.pushed, 1);
  assert.equal(puts.at(-1), 'c_late');
});

test('a contact whose push fails is passed over, not retried every half hour, and goes first the next night', async () => {
  resetFieldCache();
  const DB = crowd(30);
  const env = { DB, TZ: 'America/New_York', ROLLUP_BATCH: '10' };
  const tries = [];
  const deps = (now, resume, bad = ['c_004', 'c_015']) => ({
    fetchFields: async () => ALL_FIELDS,
    putContact: async (id) => { tries.push(id); if (bad.includes(id)) throw new Error('GHL 400'); },
    now, resume,
  });
  const a = await runRollup(env, schedule, deps(tick(0), false));
  assert.deepEqual([a.outcome, a.pushed, a.failed, a.remaining], ['degraded', 9, 1, 20]);
  const b = await runRollup(env, schedule, deps(tick(1), true));
  assert.deepEqual([b.pushed, b.failed, b.remaining], [9, 1, 10]);
  const c = await runRollup(env, schedule, deps(tick(2), true));
  assert.deepEqual([c.outcome, c.pushed, c.failed, c.remaining], ['ok', 10, 0, 0]);
  assert.deepEqual(await runRollup(env, schedule, deps(tick(3), true)), { did: false, outcome: 'ok' });
  assert.equal(tries.filter((id) => id === 'c_004').length, 1, 'tried once that night');
  assert.deepEqual(DB.raw.prepare('SELECT ghl_contact_id FROM pending_rollups ORDER BY 1').all().map((r) => r.ghl_contact_id), ['c_004', 'c_015']);

  const next = await runRollup(env, schedule, deps(tick(48), false, []));
  assert.deepEqual([next.outcome, next.pushed, next.remaining], ['ok', 2, 0]);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pending_rollups').get().n, 0);
});

test('GHL down for a whole night: each tick tries its batch once, then the run ends and everything waits', async () => {
  resetFieldCache();
  const DB = crowd(25);
  const env = { DB, TZ: 'America/New_York' };
  let calls = 0;
  const deps = (now, resume) => ({ fetchFields: async () => ALL_FIELDS, putContact: async () => { calls += 1; throw new Error('GHL 503'); }, now, resume });
  assert.equal((await runRollup(env, schedule, deps(tick(0), false))).outcome, 'failed');
  assert.equal((await runRollup(env, schedule, deps(tick(1), true))).outcome, 'failed');
  assert.deepEqual(await runRollup(env, schedule, deps(tick(2), true)), { did: false, outcome: 'ok' });
  assert.equal(calls, 25, 'one try each, not a retry storm');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pending_rollups').get().n, 25);
});

test('a resume that cannot read the field list keeps its place for the next tick', async () => {
  resetFieldCache();
  const DB = crowd(25);
  const env = { DB, TZ: 'America/New_York' };
  const puts = [];
  await runRollup(env, schedule, { fetchFields: async () => ALL_FIELDS, putContact: async (id) => puts.push(id), now: tick(0) });
  resetFieldCache();
  const stuck = await runRollup(env, schedule, { fetchFields: async () => { throw new Error('GHL 502'); }, putContact: async () => assert.fail('must not push'), now: tick(1), resume: true });
  assert.equal(stuck.outcome, 'failed');
  const again = await runRollup(env, schedule, { fetchFields: async () => ALL_FIELDS, putContact: async (id) => puts.push(id), now: tick(2), resume: true });
  assert.deepEqual([again.pushed, again.remaining], [5, 0]);
  assert.equal(new Set(puts).size, 25);
  resetFieldCache();
});

test('one read of attendance for the batch, and each contact gets their own numbers', async () => {
  resetFieldCache();
  const DB = seeded();
  let attendanceReads = 0;
  const counting = { ...DB, prepare: (sql) => { if (/FROM attendance/.test(sql)) attendanceReads += 1; return DB.prepare(sql); }, batch: (s) => DB.batch(s) };
  const puts = {};
  await runRollup({ DB: counting, TZ: 'America/New_York' }, schedule, {
    fetchFields: async () => ALL_FIELDS,
    putContact: async (id, fields) => { puts[id] = fields.find((f) => f.id === 'id_2').field_value; },
    now: NOW,
  });
  assert.equal(attendanceReads, 1);
  assert.deepEqual(puts, { c_jack: '2', c_emma: '1' }, 'lifetime counts are not mixed between contacts');
});
