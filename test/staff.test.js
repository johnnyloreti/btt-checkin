import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { COOKIE_NAME } from '../src/staff-auth.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const SAT_1105 = new Date('2026-09-05T15:05:00Z'); // Sat 11:05 ET

async function setup(now = SAT_1105) {
  resetFallback();
  const DB = memoryD1();
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(now.getTime() - 3600_000) });
  const clock = { now };
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), runRollup: async () => ({ outcome: 'ok', pushed: 0 }), now: () => clock.now });
  let cookie = '';
  const call = (path, { method = 'GET', body, headers = {}, ip = '10.0.0.1' } = {}) =>
    app.fetch(
      new Request(`https://x.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
  const login = async (pin = '1234') => {
    const res = await call('/api/staff/login', { method: 'POST', body: { pin } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const id = (contact) => opaqueId(contact, SALT);
  const kioskCheckin = async (contact, className, classStartLocal) =>
    call('/api/checkin', { method: 'POST', body: { contactId: await id(contact), className, classStartLocal } });
  return { env, app, call, login, id, kioskCheckin, clock, cookieRef: () => cookie };
}

test('staff API is closed without a cookie or header', async () => {
  const { call } = await setup();
  for (const [path, method] of [['/api/staff/today', 'GET'], ['/api/staff/class?start=2026-09-05T11:00', 'GET'], ['/api/staff/add', 'POST'], ['/api/staff/void', 'POST'], ['/api/staff/member?id=x', 'GET'], ['/api/staff/sync', 'POST']]) {
    const res = await call(path, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('login: wrong PIN is 401, right PIN sets a 12h HttpOnly cookie, logout clears it', async () => {
  const { call, login, cookieRef } = await setup();
  assert.equal((await login('0000')).status, 401);
  assert.equal(cookieRef(), '');
  const res = await login('1234');
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie');
  assert.match(set, new RegExp(`^${COOKIE_NAME}=\\d+\\.[0-9a-f]{64}; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict; Secure$`));
  assert.equal((await call('/api/staff/today')).status, 200);
  const out = await call('/api/staff/logout', { method: 'POST' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('/api/staff/login', { method: 'POST', body: '{bad' })).status, 401);
});

test('login is limited to 5 attempts a minute per IP', async () => {
  const { call } = await setup();
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await call('/api/staff/login', { method: 'POST', body: { pin: '0000' }, ip: '7.7.7.7' })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  assert.equal((await call('/api/staff/login', { method: 'POST', body: { pin: '1234' }, ip: '8.8.8.8' })).status, 200, 'other IPs fine');
});

test('cookie expires after 12 hours', async () => {
  const { call, login, clock } = await setup();
  await login();
  assert.equal((await call('/api/staff/today')).status, 200);
  clock.now = new Date(SAT_1105.getTime() + 12 * 3600_000 + 1000);
  assert.equal((await call('/api/staff/today')).status, 401);
});

test('today: every class on the date with attended counts, open mat only when used', async () => {
  const { call, login, kioskCheckin } = await setup();
  await login();
  await kioskCheckin('c_jack', 'Kids 6-9', '2026-09-05T11:00');
  await kioskCheckin('c_emma', 'Kids 6-9', '2026-09-05T11:00');
  await kioskCheckin('c_leo', 'Kids 10-14', '2026-09-05T11:45');
  let t = await (await call('/api/staff/today')).json();
  assert.equal(t.date, '2026-09-05');
  assert.equal(t.weekday, 'Sat');
  assert.equal(t.timezone, 'America/New_York');
  assert.deepEqual(t.classes.map((c) => [c.name, c.start, c.count]), [
    ['Kids 3-5', '10:30', 0],
    ['Kids 6-9', '11:00', 2],
    ['Kids 10-14', '11:45', 1],
    ['Adult BJJ', '13:00', 0],
  ]);
  await kioskCheckin('c_maria', 'open mat / unscheduled', '2026-09-05T00:00');
  t = await (await call('/api/staff/today')).json();
  assert.equal(t.classes.at(-1).name, 'open mat / unscheduled');
  assert.equal(t.classes.at(-1).count, 1);
  const tue = await (await call('/api/staff/today?date=2026-09-08')).json();
  assert.deepEqual(tue.classes.map((c) => c.name), ['Kids 3-5', 'Kids 6-9', 'Kids 10-14', 'Adult BJJ']);
  assert.equal((await call('/api/staff/today?date=nope')).status, 400);
  const sun = await (await call('/api/staff/today?date=2026-09-06')).json();
  assert.deepEqual(sun.classes, []);
});

test('class roster lists attended rows in tap order with names', async () => {
  const { call, login, kioskCheckin } = await setup();
  await login();
  await kioskCheckin('c_emma', 'Kids 6-9', '2026-09-05T11:00');
  await kioskCheckin('c_jack', 'Kids 6-9', '2026-09-05T11:00');
  const r = await (await call('/api/staff/class?start=2026-09-05T11:00')).json();
  assert.equal(r.className, 'Kids 6-9');
  assert.deepEqual(r.rows.map((x) => `${x.first} ${x.last}`), ['Emma Jones', 'Jack Silva']);
  assert.equal(r.rows[0].method, 'kiosk');
  assert.equal(r.rows[0].statusAtCheckin, 'active');
  assert.ok(Number.isInteger(r.rows[0].attendanceId));
  assert.equal((await call('/api/staff/class?start=bad')).status, 400);
  assert.deepEqual((await (await call('/api/staff/class?start=2026-09-05T13:00')).json()).rows, []);
});

test('add: staff check-in records method=staff and respects the duplicate guard', async () => {
  const { call, login, id, env } = await setup();
  await login();
  const body = { contactId: await id('c_dan'), className: 'Adult BJJ', classStartLocal: '2026-09-05T13:00' };
  const a = await call('/api/staff/add', { method: 'POST', body });
  assert.equal(a.status, 200);
  assert.equal((await a.json()).duplicate, false);
  const b = await call('/api/staff/add', { method: 'POST', body });
  assert.equal((await b.json()).duplicate, true);
  assert.equal(env.DB.raw.prepare('SELECT method FROM attendance').get().method, 'staff');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM attendance').get().n, 1);
  assert.equal((await call('/api/staff/add', { method: 'POST', body: { ...body, contactId: 'c_dan' } })).status, 404);
});

test('void: sets status to voided, never deletes, count drops, re-add restores', async () => {
  const { call, login, kioskCheckin, id, env } = await setup();
  await login();
  await kioskCheckin('c_jack', 'Kids 6-9', '2026-09-05T11:00');
  const before = await (await call('/api/staff/class?start=2026-09-05T11:00')).json();
  const attendanceId = before.rows[0].attendanceId;

  const v = await call('/api/staff/void', { method: 'POST', body: { attendanceId } });
  assert.deepEqual(await v.json(), { ok: true, attendanceId, changed: 1 });
  const row = env.DB.raw.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId);
  assert.ok(row, 'row still exists');
  assert.equal(row.status, 'voided');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM attendance').get().n, 1);

  const after = await (await call('/api/staff/class?start=2026-09-05T11:00')).json();
  assert.deepEqual(after.rows, []);
  const t = await (await call('/api/staff/today')).json();
  assert.equal(t.classes.find((c) => c.name === 'Kids 6-9').count, 0);

  const again = await call('/api/staff/void', { method: 'POST', body: { attendanceId } });
  assert.equal((await again.json()).changed, 0, 'voiding twice is a no-op');
  assert.equal((await call('/api/staff/void', { method: 'POST', body: { attendanceId: 'x' } })).status, 400);
  assert.equal((await call('/api/staff/void', { method: 'POST', body: { attendanceId: 999 } })).status, 200);

  const re = await call('/api/staff/add', { method: 'POST', body: { contactId: await id('c_jack'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' } });
  assert.equal((await re.json()).duplicate, false);
  assert.equal(env.DB.raw.prepare('SELECT status, method FROM attendance WHERE id = ?').get(attendanceId).status, 'attended');
});

test('member lookup: last 30 days, lifetime, sync status', async () => {
  const { call, login, kioskCheckin, id, env } = await setup();
  await login();
  // Old row outside 30 days, inserted directly.
  env.DB.raw
    .prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method) VALUES ('c_jack', 'Kids 6-9', '2026-07-01T16:30', '2026-07-01T20:30:00Z', 'kiosk')")
    .run();
  env.DB.raw
    .prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status) VALUES ('c_jack', 'Kids 6-9', '2026-08-20T16:30', '2026-08-20T20:30:00Z', 'kiosk', 'voided')")
    .run();
  await kioskCheckin('c_jack', 'Kids 6-9', '2026-09-05T11:00');
  const m = await (await call(`/api/staff/member?id=${await id('c_jack')}`)).json();
  assert.equal(m.first, 'Jack');
  assert.equal(m.last, 'Silva');
  assert.deepEqual(m.programs, ['kids-6-9']);
  assert.deepEqual(m.programLabels, ['Kids 6-9']);
  assert.equal(m.active, true);
  assert.equal(m.lifetime, 2, 'old attended + today, voided excluded');
  assert.deepEqual(m.last30.map((r) => [r.classStartLocal, r.status]), [
    ['2026-09-05T11:00', 'attended'],
    ['2026-08-20T16:30', 'voided'],
  ]);
  assert.ok(m.syncedAt);
  assert.ok(m.rollupPending, 'queued for the nightly rollup');
  assert.equal((await call('/api/staff/member?id=nope')).status, 404);
  assert.equal((await call('/api/staff/member')).status, 404);
});

test('GET /staff serves the login page without a cookie and the app with one', async () => {
  const { env, call, login } = await setup();
  const served = [];
  env.ASSETS = { fetch: async (req) => (served.push(new URL(req.url).pathname), new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })) };
  assert.equal((await call('/staff')).status, 200);
  await login();
  assert.equal((await call('/staff')).status, 200);
  assert.deepEqual(served, ['/staff-login.html', '/staff.html']);
  assert.equal((await call('/staff.html')).status, 404);
  assert.equal((await call('/staff-login.html')).status, 404);
});

test('header PIN still works for the shell sync trigger', async () => {
  const { call } = await setup();
  const res = await call('/api/staff/sync', { method: 'POST', headers: { 'x-staff-pin': '1234' } });
  assert.equal(res.status, 200);
});

test('POST /api/staff/rollup runs the push on demand', async () => {
  const { call, login } = await setup();
  await login();
  const res = await call('/api/staff/rollup', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).outcome, 'ok');
});
