import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, health } from '../src/app.js';
import { loadSchedule } from '../src/schedule.js';
import { fakeD1, readRepoFile } from './helpers.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));

test('/health reports counts and last roster sync', async () => {
  const DB = fakeD1({
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
    schedulePresent: true,
  });
});

test('/health with an empty database is ok with zero members and no sync', async () => {
  const DB = fakeD1({ rows: { 'FROM members': { n: 0 } } });
  const body = await health({ DB }, schedule);
  assert.equal(body.ok, true);
  assert.equal(body.memberCount, 0);
  assert.equal(body.lastRosterSync, null);
});

test('/health is 503 with ok=false when D1 fails', async () => {
  const DB = fakeD1({ fail: 'no such table: members' });
  const app = createApp(schedule);
  const res = await app.fetch(new Request('https://x.test/health'), { DB });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /no such table/);
  assert.equal(body.schedulePresent, true);
});

test('/health is not ok without a schedule', async () => {
  const DB = fakeD1({ rows: { 'FROM members': { n: 1 } } });
  const body = await health({ DB }, { classes: [] });
  assert.equal(body.ok, false);
  assert.equal(body.schedulePresent, false);
});

test('unknown routes are 404 JSON', async () => {
  const app = createApp(schedule);
  const res = await app.fetch(new Request('https://x.test/nope'), { DB: fakeD1() });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
});
