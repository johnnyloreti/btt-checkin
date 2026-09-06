import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRollup, mondayOf, runRollup, resetFieldCache, FIELD_KEYS } from '../src/rollup.js';
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
