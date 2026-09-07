import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster, classifyContact, rosterConfig } from '../src/roster.js';
import { notifyWaiverCheckin } from '../src/waiver.js';
import { resetFieldCache } from '../src/rollup.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const SAT_1055 = new Date('2026-09-05T14:55:00Z');

// Jack has signed, Emma has not.
const WITH_WAIVERS = CONTACTS.map((c) => (c.id === 'c_jack' ? { ...c, tags: [...c.tags, 'Waiver-Signed'] } : c));

async function setup({ waiverTag = 'waiver-signed', contacts = WITH_WAIVERS } = {}) {
  resetFallback();
  resetFieldCache();
  const DB = memoryD1();
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', WAIVER_TAG: waiverTag, WAIVER_FIELD: 'checkin_last_at', DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts, pages: 1 }), now: new Date(SAT_1055.getTime() - 3600_000) });
  const nudges = [];
  const app = createApp(schedule, {
    runRosterSync: async () => ({ outcome: 'ok' }),
    notifyWaiver: async (e, contactId, now) => (nudges.push({ contactId, now }), { ok: true }),
    now: () => SAT_1055,
  });
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  const post = (path, body, headers = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...headers }, body: JSON.stringify(body) }), env, ctx);
  const get = (path, headers = {}) => app.fetch(new Request(`https://x.test${path}`, { headers: { 'cf-connecting-ip': '10.0.0.1', ...headers } }), env, ctx);
  return { env, post, get, nudges, waited, id: (c) => opaqueId(c, SALT) };
}

test('sync reads the waiver tag, case-insensitively, and counts who is missing', async () => {
  const { env } = await setup();
  const rows = Object.fromEntries(env.DB.raw.prepare('SELECT ghl_contact_id, waiver FROM members').all().map((r) => [r.ghl_contact_id, r.waiver]));
  assert.equal(rows.c_jack, 1);
  assert.equal(rows.c_emma, 0);
  const log = env.DB.raw.prepare("SELECT detail FROM sync_log WHERE job = 'roster' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(log.detail).waiverMissing, 8);
});

test('with WAIVER_TAG empty everyone counts as signed and nothing is nudged', async () => {
  const { env, post, nudges, id } = await setup({ waiverTag: '' });
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM members WHERE waiver = 0').get().n, 0);
  const res = await post('/api/checkin', { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' });
  assert.equal((await res.json()).waiverNeeded, false);
  assert.equal(nudges.length, 0);
  const cfg = rosterConfig({ WAIVER_TAG: '' }, schedule);
  assert.equal(classifyContact({ id: 'x', tags: ['program:adult'] }, cfg).waiver, true);
});

test('check-in without a waiver still succeeds, says so, and nudges GHL after the response', async () => {
  const { post, nudges, waited, id } = await setup();
  const res = await post('/api/checkin', { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, false);
  assert.equal(body.waiverNeeded, true);
  assert.equal(waited.length, 1, 'nudge runs in waitUntil, not before the response');
  await Promise.all(waited);
  assert.deepEqual(nudges.map((n) => n.contactId), ['c_emma']);
  assert.equal(nudges[0].now.toISOString(), SAT_1055.toISOString());
});

test('a duplicate tap shows the prompt again but does not nudge twice', async () => {
  const { post, nudges, waited, id } = await setup();
  const body = { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' };
  await post('/api/checkin', body);
  const again = await (await post('/api/checkin', body)).json();
  assert.equal(again.duplicate, true);
  assert.equal(again.waiverNeeded, true);
  await Promise.all(waited);
  assert.equal(nudges.length, 1);
});

test('a member with the waiver on file is not prompted or nudged', async () => {
  const { post, nudges, waited, id } = await setup();
  const body = await (await post('/api/checkin', { contactId: await id('c_jack'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' })).json();
  assert.equal(body.waiverNeeded, false);
  await Promise.all(waited);
  assert.equal(nudges.length, 0);
});

test('staff add nudges too, and the roster row and member lookup show waiver status', async () => {
  const { post, get, nudges, waited, id } = await setup();
  const login = await post('/api/staff/login', { pin: '1234' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await post('/api/staff/add', { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' }, { cookie });
  await post('/api/staff/add', { contactId: await id('c_jack'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' }, { cookie });
  await Promise.all(waited);
  assert.deepEqual(nudges.map((n) => n.contactId), ['c_emma']);
  const roster = await (await get('/api/staff/class?start=2026-09-05T11:00', { cookie })).json();
  assert.deepEqual(roster.rows.map((r) => [r.first, r.waiver]), [['Emma', false], ['Jack', true]]);
  const emma = await (await get(`/api/staff/member?id=${await id('c_emma')}`, { cookie })).json();
  assert.equal(emma.waiver, false);
  const jack = await (await get(`/api/staff/member?id=${await id('c_jack')}`, { cookie })).json();
  assert.equal(jack.waiver, true);
});

test('notifyWaiverCheckin writes the one field, and never throws', async () => {
  resetFieldCache();
  const env = { WAIVER_TAG: 'waiver-signed', WAIVER_FIELD: 'checkin_last_at' };
  const puts = [];
  const now = new Date('2026-09-05T14:55:00Z');
  const deps = { fetchFields: async () => new Map([['checkin_last_at', 'f_ck'], ['attendance_last', 'f_al']]), putContact: async (id, fields) => puts.push({ id, fields }) };
  assert.deepEqual(await notifyWaiverCheckin(env, deps, 'c_emma', now), { ok: true });
  assert.deepEqual(puts, [{ id: 'c_emma', fields: [{ id: 'f_ck', field_value: '2026-09-05T14:55:00.000Z' }] }]);

  resetFieldCache();
  const missing = await notifyWaiverCheckin(env, { ...deps, fetchFields: async () => new Map([['attendance_last', 'f_al']]) }, 'c_emma', now);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /checkin_last_at not found/);

  resetFieldCache();
  const failing = await notifyWaiverCheckin(env, { ...deps, putContact: async () => { throw new Error('GHL 429'); } }, 'c_emma', now);
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /429/);

  assert.equal((await notifyWaiverCheckin({ WAIVER_TAG: '' }, deps, 'c_emma', now)).ok, false);
  assert.equal((await notifyWaiverCheckin({ WAIVER_TAG: 'x', WAIVER_FIELD: '' }, deps, 'c_emma', now)).ok, false);
  resetFieldCache();
});

test('kiosk page carries the waiver line and the QR slot', () => {
  const html = readRepoFile('public/index.html');
  assert.match(html, /One thing before class: sign the waiver/);
  assert.match(html, /waiver-qr\.png/);
  assert.doesNotMatch(html, /waiver[^<]*!/);
});
