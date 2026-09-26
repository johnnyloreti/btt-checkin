import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, health } from '../src/app.js';
import { loadSchedule } from '../src/schedule.js';
import { fakeD1, readRepoFile } from './helpers.js';
import { resetSchemaCaps } from '../src/schema-caps.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));

// The waiver column check is cached per isolate; each fake database re-asks.
const migrated = { 'pragma_table_info': [{ name: 'waiver' }] };
const fake = (opts = {}) => {
  resetSchemaCaps();
  return fakeD1({ ...opts, rows: { ...migrated, ...(opts.rows || {}) } });
};

test('/health reports counts and last roster sync', async () => {
  const DB = fake({
    rows: {
      'FROM members': { n: 42 },
      "job = 'roster'": { ran_at: '2026-09-06T14:00:00.000Z', outcome: 'ok' },
      "job = 'rollup'": { ran_at: '2026-09-06T07:00:00.000Z', outcome: 'degraded' },
      'FROM pending_rollups': { n: 3 },
    },
  });
  const app = createApp(schedule);
  const res = await app.fetch(new Request('https://x.test/health'), { DB });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = await res.json();
  assert.deepEqual(body, {
    ok: true,
    lastRosterSync: '2026-09-06T14:00:00.000Z',
    lastRosterOutcome: 'ok',
    memberCount: 42,
    lastRollup: '2026-09-06T07:00:00.000Z',
    lastRollupOutcome: 'degraded',
    pendingRollups: 3,
    lastTabRun: null,
    lastTabOutcome: null,
    missingFields: null,
    waiverFailures24h: 0,
    waiverLastFailure: null,
    schemaCurrent: true,
    schedulePresent: true,
    tab: { enabled: false, schema: false, error: null },
  });
});

test('/health goes ok=false naming a custom field the last sync found missing', async () => {
  const DB = fake({
    rows: {
      'FROM members': { n: 42 },
      "job = 'roster'": { ran_at: '2026-09-25T14:00:00.000Z', outcome: 'degraded', detail: JSON.stringify({ members: 42, missingFields: ['checkin_last_at'] }) },
    },
  });
  const app = createApp(schedule);
  const res = await app.fetch(new Request('https://x.test/health'), { DB });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.missingFields, ['checkin_last_at']);
  assert.match(body.error, /checkin_last_at/);
  assert.match(body.error, /being lost/);
});

test('/health: a sync that checked and found every field is ok with an empty list', async () => {
  const DB = fake({
    rows: {
      'FROM members': { n: 1 },
      "job = 'roster'": { ran_at: '2026-09-25T14:00:00.000Z', outcome: 'ok', detail: JSON.stringify({ missingFields: [] }) },
    },
  });
  const body = await health({ DB }, schedule);
  assert.equal(body.ok, true);
  assert.deepEqual(body.missingFields, []);
});

test('/health counts waiver nudge failures in the last day and shows the latest reason', async () => {
  const now = new Date('2026-09-25T15:00:00.000Z');
  const DB = fake({
    rows: {
      'FROM members': { n: 1 },
      "job = 'waiver' AND ran_at >=": { n: 3 },
      "job = 'waiver' ORDER BY": { ran_at: '2026-09-25T14:30:00.000Z', detail: JSON.stringify({ contactId: 'c_emma', reason: 'GHL 401' }) },
    },
  });
  const body = await health({ DB }, schedule, now);
  assert.equal(body.ok, true, 'reported, like a rollup outcome; the field check owns ok');
  assert.equal(body.waiverFailures24h, 3);
  assert.equal(body.waiverLastFailure, '2026-09-25T14:30:00.000Z GHL 401');
  // A failure older than a day is not "the latest" any more.
  const stale = fake({ rows: { 'FROM members': { n: 1 }, "job = 'waiver' AND ran_at >=": { n: 0 }, "job = 'waiver' ORDER BY": { ran_at: '2026-09-01T00:00:00.000Z', detail: '{}' } } });
  const old = await health({ DB: stale }, schedule, now);
  assert.equal(old.waiverFailures24h, 0);
  assert.equal(old.waiverLastFailure, null);
});

test('/health reports both a missing field and a pending migration', async () => {
  resetSchemaCaps();
  const DB = fakeD1({
    rows: {
      'pragma_table_info': [],
      'FROM members': { n: 1 },
      "job = 'roster'": { ran_at: '2026-09-25T14:00:00.000Z', outcome: 'degraded', detail: JSON.stringify({ missingFields: ['attendance_week'] }) },
    },
  });
  const body = await health({ DB }, schedule);
  assert.equal(body.ok, false);
  assert.match(body.error, /attendance_week/);
  assert.match(body.error, /002_waiver/);
});

test('/health with an empty database is ok with zero members and no sync', async () => {
  const DB = fake({ rows: { 'FROM members': { n: 0 } } });
  const body = await health({ DB }, schedule);
  assert.equal(body.ok, true);
  assert.equal(body.memberCount, 0);
  assert.equal(body.lastRosterSync, null);
});

test('/health is 503 with ok=false when D1 fails', async () => {
  const DB = fake({ fail: 'no such table: members' });
  const app = createApp(schedule);
  const res = await app.fetch(new Request('https://x.test/health'), { DB });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /no such table/);
  assert.equal(body.schedulePresent, true);
});

test('/health is not ok without a schedule', async () => {
  const DB = fake({ rows: { 'FROM members': { n: 1 } } });
  const body = await health({ DB }, { classes: [] });
  assert.equal(body.ok, false);
  assert.equal(body.schedulePresent, false);
});

test('unknown routes are 404 JSON', async () => {
  const app = createApp(schedule);
  const res = await app.fetch(new Request('https://x.test/nope'), { DB: fake() });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
});
