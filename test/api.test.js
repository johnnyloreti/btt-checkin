import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const SAT_1055 = new Date('2026-09-05T14:55:00Z'); // Sat 10:55 ET

async function setup(now = SAT_1055) {
  resetFallback();
  const DB = memoryD1();
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(now.getTime() - 3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), now: () => now });
  const get = (path, headers = {}) => app.fetch(new Request(`https://x.test${path}`, { headers: { 'cf-connecting-ip': '10.0.0.1', ...headers } }), env);
  const post = (path, body, headers = {}) =>
    app.fetch(
      new Request(`https://x.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
    );
  return { env, app, get, post };
}

test('GET /api/roster returns opaque ids, names, program labels only', async () => {
  const { get } = await setup();
  const res = await get('/api/roster');
  assert.equal(res.status, 200);
  const roster = await res.json();
  assert.equal(roster.length, 9);
  const jack = roster.find((r) => r.first === 'Jack');
  assert.deepEqual(jack, { id: await opaqueId('c_jack', SALT), first: 'Jack', last: 'Silva', program: 'Kids 6-9', programs: ['kids-6-9'] });
  const leo = roster.find((r) => r.first === 'Leo');
  assert.equal(leo.program, 'Kids 10-14 / Adult');
  assert.deepEqual(leo.programs, ['kids-10-14', 'adult']);
  const text = JSON.stringify(roster);
  assert.doesNotMatch(text, /c_[a-z]+/, 'no GHL contact ids');
  assert.doesNotMatch(text, /@|phone|billing|active|inactive/i);
  for (const r of roster) assert.deepEqual(Object.keys(r).sort(), ['first', 'id', 'last', 'program', 'programs']);
});

test('GET /api/roster fails closed without ID_SALT', async () => {
  const { env, app } = await setup();
  env.ID_SALT = '';
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await app.fetch(new Request('https://x.test/api/roster'), env);
    assert.equal(res.status, 500);
  } finally {
    console.error = orig;
  }
});

test('GET /api/current-class computes matches server-side, with ?at for testing', async () => {
  const { get } = await setup();
  const live = await (await get('/api/current-class')).json();
  assert.equal(live.nowLocal, '2026-09-05T10:55');
  assert.deepEqual(live.matches.map((m) => m.name), ['Kids 6-9', 'Kids 10-14']); // 3-5 closed at 10:50, Adult opens at 11:00
  assert.equal(live.matches[0].startLocal, '2026-09-05T11:00');
  assert.deepEqual(live.window, { earlyMin: 120, lateMin: 20 });

  const at = await (await get('/api/current-class?at=2026-09-08T22:00:00Z')).json(); // Tue 18:00 ET
  assert.deepEqual(at.matches.map((m) => m.name), ['Adult BJJ']);
  assert.equal((await get('/api/current-class?at=nope')).status, 400);
});

test('POST /api/checkin records attendance and the duplicate guard holds', async () => {
  const { get, post, env } = await setup();
  const id = await opaqueId('c_jack', SALT);
  const body = { contactId: id, className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00', clientTs: SAT_1055.toISOString() };
  const first = await post('/api/checkin', body);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    ok: true,
    duplicate: false,
    className: 'Kids 6-9',
    classStartLocal: '2026-09-05T11:00',
    classCount: 1,
    classCountLabel: 'Class #1',
    waiverNeeded: false,
  });
  const second = await post('/api/checkin', body);
  assert.equal((await second.json()).duplicate, true);
  const rows = env.DB.raw.prepare('SELECT * FROM attendance').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ghl_contact_id, 'c_jack', 'stored under the real GHL id');
  assert.equal(rows[0].method, 'kiosk');
  assert.equal(env.DB.raw.prepare('SELECT ghl_contact_id FROM pending_rollups').get().ghl_contact_id, 'c_jack');
  assert.equal((await (await get('/health')).json()).memberCount, 9);
});

test('POST /api/checkin rejects unknown ids, bad bodies, and bad classes', async () => {
  const { post } = await setup();
  assert.equal((await post('/api/checkin', { contactId: 'c_jack', className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' })).status, 404, 'raw GHL id is not accepted');
  assert.equal((await post('/api/checkin', { contactId: '0123456789abcdef0123', className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' })).status, 404);
  assert.equal((await post('/api/checkin', '{not json')).status, 400);
  assert.equal((await post('/api/checkin', [])).status, 400);
  const id = await opaqueId('c_jack', SALT);
  assert.equal((await post('/api/checkin', { contactId: id, className: 'Adult BJJ', classStartLocal: '2026-09-05T11:00' })).status, 400);
});

test('inactive member still checks in and is marked inactive on the record', async () => {
  const { post, env } = await setup();
  env.DB.raw.prepare("UPDATE members SET active = 0 WHERE ghl_contact_id = 'c_jack'").run();
  const id = await opaqueId('c_jack', SALT);
  const res = await post('/api/checkin', { contactId: id, className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' });
  assert.equal(res.status, 200);
  assert.equal(env.DB.raw.prepare('SELECT status_at_checkin FROM attendance').get().status_at_checkin, 'inactive');
});

test('public routes are rate limited per IP', async () => {
  const { app, env } = await setup();
  let blocked = false;
  for (let i = 0; i < 61; i += 1) {
    const res = await app.fetch(new Request('https://x.test/api/current-class', { headers: { 'cf-connecting-ip': '5.5.5.5' } }), env);
    if (res.status === 429) {
      blocked = true;
      assert.equal(res.headers.get('retry-after'), '60');
      assert.equal(i, 60);
      break;
    }
  }
  assert.equal(blocked, true);
  const other = await app.fetch(new Request('https://x.test/api/current-class', { headers: { 'cf-connecting-ip': '6.6.6.6' } }), env);
  assert.equal(other.status, 200);
  const health = await app.fetch(new Request('https://x.test/health', { headers: { 'cf-connecting-ip': '5.5.5.5' } }), env);
  assert.equal(health.status, 200, 'health is not rate limited');
  resetFallback();
});

test('static kiosk files go through the assets binding, nothing else does', async () => {
  const { env, app } = await setup();
  const served = [];
  env.ASSETS = { fetch: async (req) => (served.push(new URL(req.url).pathname), new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })) };
  for (const p of ['/', '/search.js', '/logo.png']) assert.equal((await app.fetch(new Request(`https://x.test${p}`), env)).status, 200);
  assert.deepEqual(served, ['/index.html', '/search.js', '/logo.png']);
  assert.equal((await app.fetch(new Request('https://x.test/staff.html'), env)).status, 404);
  assert.equal((await app.fetch(new Request('https://x.test/anything.js'), env)).status, 404);
  delete env.ASSETS;
  assert.equal((await app.fetch(new Request('https://x.test/'), env)).status, 404);
});

test('checkin on a Wednesday uses the No-Gi name for adults', async () => {
  const wed = new Date('2026-09-09T22:00:00Z'); // Wed 18:00 ET
  const { get, post } = await setup(wed);
  const cc = await (await get('/api/current-class')).json();
  assert.deepEqual(cc.matches.map((m) => m.name), ['Adult No-Gi']);
  const id = await opaqueId('c_dan', SALT);
  const res = await post('/api/checkin', { contactId: id, className: cc.matches[0].name, classStartLocal: cc.matches[0].startLocal });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).className, 'Adult No-Gi');
});
