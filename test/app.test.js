import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { loadSchedule } from '../src/schedule.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const ENV = () => ({ MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', DB: memoryD1() });

function appWith(contacts) {
  return createApp(schedule, {
    runRosterSync: (env, sched, now) =>
      import('../src/roster.js').then((m) => m.syncRoster(env, sched, { fetchContacts: async () => ({ contacts, pages: 1 }), now })),
  });
}

test('POST /api/staff/sync needs the PIN', async () => {
  const app = appWith(CONTACTS);
  const env = ENV();
  for (const headers of [{}, { 'x-staff-pin': '0000' }, { 'x-staff-pin': '12345' }]) {
    const res = await app.fetch(new Request('https://x.test/api/staff/sync', { method: 'POST', headers }), env);
    assert.equal(res.status, 401);
  }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM sync_log').get().n, 0);
});

test('POST /api/staff/sync with the PIN runs the sync and /health reflects it', async () => {
  const app = appWith(CONTACTS);
  const env = ENV();
  const res = await app.fetch(
    new Request('https://x.test/api/staff/sync', { method: 'POST', headers: { 'x-staff-pin': '1234' } }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.outcome, 'ok');
  assert.equal(body.members, 7);

  const h = await (await app.fetch(new Request('https://x.test/health'), env)).json();
  assert.equal(h.ok, true);
  assert.equal(h.memberCount, 7);
  assert.equal(h.lastRosterOutcome, 'ok');
  assert.ok(h.lastRosterSync);
});

test('sync with no PIN configured is always unauthorized', async () => {
  const app = appWith(CONTACTS);
  const env = { ...ENV(), STAFF_PIN: undefined };
  const res = await app.fetch(
    new Request('https://x.test/api/staff/sync', { method: 'POST', headers: { 'x-staff-pin': '' } }),
    env,
  );
  assert.equal(res.status, 401);
});

test('degraded sync still returns 200 so the caller sees the reason', async () => {
  const app = appWith([]);
  const env = ENV();
  const res = await app.fetch(
    new Request('https://x.test/api/staff/sync', { method: 'POST', headers: { 'x-staff-pin': '1234' } }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).outcome, 'degraded');
});
