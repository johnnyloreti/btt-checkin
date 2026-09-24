// A deploy that runs ahead of its migration must degrade, never break.
//
// 2026-09-17: the waiver code (§15.1) went out before 002_waiver.sql had been
// applied. Every check-in read members.waiver, threw "no such column", and
// returned 500. The kiosk never shows a student an error, so it queued each
// one and showed the checkmark. Attendance stopped recording and nothing said
// so. These tests pin the behaviour that prevents a repeat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, health } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { hasWaiverColumn, resetSchemaCaps } from '../src/schema-caps.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const SAT_1055 = new Date('2026-09-05T14:55:00Z');

async function setup({ legacy } = {}) {
  resetFallback();
  const DB = memoryD1({ legacy });
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', WAIVER_TAG: 'waiver-signed', WAIVER_FIELD: 'checkin_last_at', DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(SAT_1055.getTime() - 3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => SAT_1055 });
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  return { env, call, id: (c) => opaqueId(c, SALT) };
}

test('the column check reports what the database actually has', async () => {
  const modern = await setup();
  assert.equal(await hasWaiverColumn(modern.env), true);
  const old = await setup({ legacy: true });
  assert.equal(await hasWaiverColumn(old.env), false);
  resetSchemaCaps();
  // A database that cannot answer at all is treated as not having it.
  assert.equal(await hasWaiverColumn({ DB: { prepare() { throw new Error('offline'); } } }), false);
  resetSchemaCaps();
});

test('roster sync succeeds against a pre-migration database', async () => {
  const DB = memoryD1({ legacy: true });
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', WAIVER_TAG: 'waiver-signed', DB };
  const r = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: SAT_1055 });
  assert.equal(r.outcome, 'ok', 'a pending migration must not fail the sync');
  assert.equal(r.members, 9);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM members').get().n, 9);
});

test('check-in works against a pre-migration database, and reports no waiver prompt', async () => {
  const { call, id } = await setup({ legacy: true });
  const res = await call('/api/checkin', { method: 'POST', body: { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' } });
  assert.equal(res.status, 200, 'attendance must record even with the migration pending');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.classCountLabel, 'Class #1');
  assert.equal(body.waiverNeeded, false, 'unknown waiver status is never a prompt');
});

test('staff screens work against a pre-migration database', async () => {
  const { call, id } = await setup({ legacy: true });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await call('/api/staff/add', { method: 'POST', body: { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' }, headers: { cookie } });
  const roster = await (await call('/api/staff/class?start=2026-09-05T11:00', { headers: { cookie } })).json();
  assert.deepEqual(roster.rows.map((r) => [r.first, r.waiver]), [['Emma', null]], 'waiver unknown, not false');
  const member = await (await call(`/api/staff/member?id=${await id('c_emma')}`, { headers: { cookie } })).json();
  assert.equal(member.waiver, true, 'defaults to on file when the column is absent');
});

test('/health fails loudly while a migration is pending', async () => {
  const pending = await setup({ legacy: true });
  const body = await health(pending.env, schedule);
  assert.equal(body.schemaCurrent, false);
  assert.equal(body.ok, false, 'a half-applied deploy must not read as healthy');
  assert.match(body.error, /002_waiver\.sql/);
  const res = await pending.call('/health');
  assert.equal(res.status, 503);

  const current = await setup();
  const ok = await health(current.env, schedule);
  assert.equal(ok.schemaCurrent, true);
  assert.equal(ok.ok, true);
  assert.equal(ok.error, undefined);
});

test('the kiosk drains its queue when the page returns to the foreground', () => {
  const html = readRepoFile('public/index.html');
  assert.match(html, /visibilitychange/, 'iOS suspends timers on a sleeping iPad');
  assert.match(html, /pageshow/);
});
