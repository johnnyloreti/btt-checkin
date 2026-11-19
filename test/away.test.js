// Away list (§15.5). Staff see who has gone quiet: active members whose last
// class was AWAY_DAYS or more days ago, and members who never checked in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { awayConfig, DEFAULT_AWAY_DAYS } from '../src/staff.js';
import { loadSchedule } from '../src/schedule.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-23T15:00:00Z'); // Wed Sep 23, 11:00 ET

async function setup(extraEnv = {}) {
  resetFallback();
  const DB = memoryD1();
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', DB, ...extraEnv };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => NOW });
  let cookie = '';
  const call = (path, { method = 'GET', body, anon = false } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(cookie && !anon ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const attend = (contactId, date, status = 'attended') =>
    DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status) VALUES (?, 'Kids 6-9', ?, ?, 'kiosk', ?)")
      .run(contactId, `${date}T16:30`, `${date}T20:30:00Z`, status);
  const away = async () => (await call('/api/staff/away')).json();
  return { env, DB, call, attend, away };
}

test('awayConfig: default 14, a whole number overrides, "0" is off, junk falls back', () => {
  assert.equal(DEFAULT_AWAY_DAYS, 14);
  assert.deepEqual(awayConfig({}), { enabled: true, days: 14 });
  assert.deepEqual(awayConfig({ AWAY_DAYS: '21' }), { enabled: true, days: 21 });
  assert.deepEqual(awayConfig({ AWAY_DAYS: '0' }), { enabled: false, days: 0 });
  for (const bad of ['', '-3', '1.5', 'two weeks']) assert.deepEqual(awayConfig({ AWAY_DAYS: bad }), { enabled: true, days: 14 }, bad);
});

test('the away list is behind the PIN', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/staff/away', { anon: true })).status, 401);
});

test('listed at exactly 14 days, not at 13, longest away first', async () => {
  const { attend, away } = await setup();
  attend('c_jack', '2026-09-09'); // 14 days before Sep 23
  attend('c_emma', '2026-09-10'); // 13 days
  attend('c_dan', '2026-08-01');  // 53 days
  attend('c_dan', '2026-07-01');  // an older class does not matter
  const body = await away();
  assert.equal(body.enabled, true);
  assert.equal(body.days, 14);
  assert.equal(body.today, '2026-09-23');
  assert.deepEqual(body.away.map((r) => [r.first, r.lastDate, r.daysAway, r.lifetime]), [['Dan', '2026-08-01', 53, 2], ['Jack', '2026-09-09', 14, 1]]);
  assert.deepEqual(body.away[1].programLabels, ['Kids 6-9']);
  assert.match(body.away[0].id, /^[0-9a-f]{20}$/);
  assert.doesNotMatch(JSON.stringify(body), /c_[a-z]+/, 'no raw GHL contact ids');
  assert.ok(!body.away.some((r) => r.first === 'Emma'), '13 days is not away yet');
});

test('members who never checked in are a separate list, by name', async () => {
  const { attend, away, DB } = await setup();
  const everyone = DB.raw.prepare('SELECT COUNT(*) AS n FROM members WHERE active = 1').get().n;
  attend('c_jack', '2026-09-22');
  const body = await away();
  assert.deepEqual(body.away, [], 'Jack was in yesterday');
  assert.equal(body.never.length, everyone - 1);
  assert.ok(!body.never.some((r) => r.first === 'Jack'));
  const names = body.never.map((r) => r.first);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.equal(body.never[0].daysAway, undefined);
});

test('a removed check-in is not a class, and an inactive member is not listed', async () => {
  const { attend, away, DB } = await setup();
  // Jack's only recent class was voided: his last real class is the old one.
  attend('c_jack', '2026-09-01');
  attend('c_jack', '2026-09-22', 'voided');
  // Emma only ever has a voided row: she has never checked in.
  attend('c_emma', '2026-09-22', 'voided');
  // Dan left: off the roster, so off this list.
  attend('c_dan', '2026-08-01');
  DB.raw.prepare("UPDATE members SET active = 0 WHERE ghl_contact_id = 'c_dan'").run();
  const body = await away();
  assert.deepEqual(body.away.map((r) => [r.first, r.daysAway, r.lifetime]), [['Jack', 22, 1]]);
  assert.ok(body.never.some((r) => r.first === 'Emma'));
  assert.ok(![...body.away, ...body.never].some((r) => r.first === 'Dan'));
});

test('AWAY_DAYS moves the line, and "0" turns the list off', async () => {
  const week = await setup({ AWAY_DAYS: '7' });
  week.attend('c_emma', '2026-09-16'); // 7 days
  week.attend('c_jack', '2026-09-17'); // 6 days
  assert.deepEqual((await week.away()).away.map((r) => [r.first, r.daysAway]), [['Emma', 7]]);

  const off = await setup({ AWAY_DAYS: '0' });
  off.attend('c_emma', '2026-01-01');
  assert.deepEqual(await off.away(), { enabled: false, days: 0, away: [], never: [] });
});

test('days are counted on the ET calendar, not UTC', async () => {
  // 03:30 UTC on Sep 24 is still 11:30 PM on Sep 23 in New York.
  resetFallback();
  const DB = memoryD1();
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', DB };
  const late = new Date('2026-09-24T03:30:00Z');
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(late.getTime() - 3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), now: () => late });
  const req = (path, init = {}) => app.fetch(new Request(`https://x.test${path}`, { ...init, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(init.headers || {}) } }), env, { waitUntil: () => {} });
  const login = await req('/api/staff/login', { method: 'POST', body: JSON.stringify({ pin: '1234' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method) VALUES ('c_jack', 'Kids 6-9', '2026-09-10T16:30', '2026-09-10T20:30:00Z', 'kiosk')").run();
  const body = await (await req('/api/staff/away', { headers: { cookie } })).json();
  assert.equal(body.today, '2026-09-23');
  assert.deepEqual(body.away, [], '13 days on the ET calendar, 14 on the UTC one');
});
