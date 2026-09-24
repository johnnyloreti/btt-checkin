// Stripe tracking (§15.2). The tab surfaces who has crossed a threshold; it
// never asserts a promotion is owed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { stripeConfig, eligibleForStripe, stripesEnabled, DEFAULT_STRIPE_CLASSES } from '../src/promotions.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-23T15:00:00Z'); // Wed 11:00 ET

async function setup({ noPromotions = false } = {}) {
  resetFallback();
  const DB = memoryD1({ noPromotions });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234',
    ID_SALT: SALT, TZ: 'America/New_York',
    STRIPE_CLASSES: '7', STRIPE_PROGRAMS: 'kids-3-5,kids-6-9,kids-10-14', DB,
  };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => NOW });
  let cookie = '';
  const call = (path, { method = 'GET', body } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  // Give a member n attended classes on distinct past dates. Repeated calls
  // continue from where the last left off: attendance is UNIQUE on
  // (contact, class start), so reusing a date would collide.
  const issued = new Map();
  const give = (contactId, n, className = 'Kids 6-9') => {
    const ins = DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method) VALUES (?, ?, ?, ?, 'kiosk')");
    let i = issued.get(contactId) || 0;
    for (let k = 0; k < n; k += 1, i += 1) {
      const d = `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
      ins.run(contactId, className, `${d}T16:30`, `${d}T20:30:00Z`);
    }
    issued.set(contactId, i);
  };
  return { env, DB, call, give, id: (c) => opaqueId(c, SALT) };
}

// ---------- pure ----------

test('stripeConfig reads the threshold, falls back, and treats empty programs as off', () => {
  assert.deepEqual(stripeConfig({ STRIPE_CLASSES: '7', STRIPE_PROGRAMS: 'kids-6-9' }), { threshold: 7, programs: ['kids-6-9'] });
  assert.equal(stripeConfig({ STRIPE_CLASSES: '12' }).threshold, 12);
  for (const bad of ['', '0', '-3', 'seven', '1.5', undefined]) {
    assert.equal(stripeConfig({ STRIPE_CLASSES: bad }).threshold, DEFAULT_STRIPE_CLASSES, String(bad));
  }
  assert.equal(DEFAULT_STRIPE_CLASSES, 7);
  assert.equal(stripesEnabled({ STRIPE_PROGRAMS: '' }), false);
  assert.equal(stripesEnabled({ STRIPE_PROGRAMS: 'kids-6-9' }), true);
});

test('eligibility counts classes since the last award, most overdue first', () => {
  const cfg = { threshold: 7, programs: ['kids-6-9', 'kids-3-5'] };
  const members = [
    { ghl_contact_id: 'exactly', first_name: 'Exactly', last_name: 'Seven', programs: ['kids-6-9'], lifetime: 7 },
    { ghl_contact_id: 'short', first_name: 'One', last_name: 'Short', programs: ['kids-6-9'], lifetime: 6 },
    { ghl_contact_id: 'way', first_name: 'Way', last_name: 'Past', programs: ['kids-3-5'], lifetime: 30 },
    { ghl_contact_id: 'adult', first_name: 'An', last_name: 'Adult', programs: ['adult'], lifetime: 99 },
    { ghl_contact_id: 'fresh', first_name: 'Just', last_name: 'Promoted', programs: ['kids-6-9'], lifetime: 15 },
  ];
  const last = new Map([
    ['way', { at_class_count: 2, awarded_on: '2026-06-01', kind: 'stripe' }],
    ['fresh', { at_class_count: 15, awarded_on: '2026-09-20', kind: 'stripe' }],
  ]);
  const rows = eligibleForStripe(members, last, cfg);
  assert.deepEqual(rows.map((r) => [r.ghl_contact_id, r.since, r.worth]), [['way', 28, 4], ['exactly', 7, 1]]);
  assert.equal(rows[0].lastAwardedOn, '2026-06-01');
  assert.equal(rows[1].lastAwardedOn, null, 'never promoted: counts from their first class');
});

test('a voided class after an award never drives the count negative', () => {
  const cfg = { threshold: 7, programs: ['kids-6-9'] };
  const members = [{ ghl_contact_id: 'x', first_name: 'X', last_name: 'Y', programs: ['kids-6-9'], lifetime: 3 }];
  const last = new Map([['x', { at_class_count: 9, awarded_on: '2026-09-01', kind: 'stripe' }]]);
  assert.deepEqual(eligibleForStripe(members, last, cfg), []);
});

test('no covered programs means nobody is listed', () => {
  const members = [{ ghl_contact_id: 'x', first_name: 'X', last_name: 'Y', programs: ['kids-6-9'], lifetime: 99 }];
  assert.deepEqual(eligibleForStripe(members, new Map(), { threshold: 7, programs: [] }), []);
});

// ---------- routes ----------

test('the stripe routes are behind the PIN', async () => {
  const { env } = await setup();
  const app = createApp(schedule, { now: () => NOW });
  const anon = (path, method = 'GET') => app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }), env, { waitUntil: () => {} });
  assert.equal((await anon('/api/staff/stripes')).status, 401);
  assert.equal((await anon('/api/staff/promote', 'POST')).status, 401);
  assert.equal((await anon('/api/staff/promote/undo', 'POST')).status, 401);
});

test('the list shows eligible kids only, with opaque ids and no raw contact ids', async () => {
  const { call, give } = await setup();
  give('c_jack', 7);   // kids-6-9, eligible
  give('c_emma', 6);   // kids-6-9, one short
  give('c_dan', 40);   // adult, not covered
  const body = await (await call('/api/staff/stripes')).json();
  assert.equal(body.enabled, true);
  assert.equal(body.threshold, 7);
  assert.deepEqual(body.rows.map((r) => `${r.first} ${r.last}`), ['Jack Silva']);
  assert.equal(body.rows[0].since, 7);
  assert.match(body.rows[0].id, /^[0-9a-f]{20}$/);
  assert.doesNotMatch(JSON.stringify(body), /c_[a-z]+/, 'no raw GHL contact ids');
});

test('recording a stripe clears the row and starts the next interval', async () => {
  const { call, give, id, DB } = await setup();
  give('c_jack', 9);
  const jack = await id('c_jack');
  const rec = await (await call('/api/staff/promote', { method: 'POST', body: { contactId: jack, kind: 'stripe' } })).json();
  assert.equal(rec.ok, true);
  assert.equal(rec.atClassCount, 9, 'stores the count at the moment of the award');
  assert.equal(rec.awardedOn, '2026-09-23');

  assert.deepEqual((await (await call('/api/staff/stripes')).json()).rows, [], 'cleared from the list');

  give('c_jack', 6);
  assert.deepEqual((await (await call('/api/staff/stripes')).json()).rows, [], 'six more is not yet another stripe');
  give('c_jack', 1);
  const again = await (await call('/api/staff/stripes')).json();
  assert.equal(again.rows.length, 1);
  assert.equal(again.rows[0].since, 7, 'counts from the award, not from zero');
  assert.equal(again.rows[0].lastAwardedOn, '2026-09-23');
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM promotions').get().n, 1);
});

test('undo removes only the most recent award', async () => {
  const { call, give, id, DB } = await setup();
  give('c_jack', 20);
  const jack = await id('c_jack');
  await call('/api/staff/promote', { method: 'POST', body: { contactId: jack } });
  await call('/api/staff/promote', { method: 'POST', body: { contactId: jack, kind: 'belt' } });
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM promotions').get().n, 2);

  const undone = await (await call('/api/staff/promote/undo', { method: 'POST', body: { contactId: jack } })).json();
  assert.equal(undone.removed, 1);
  assert.equal(undone.kind, 'belt', 'the most recent one');
  const left = DB.raw.prepare('SELECT kind FROM promotions').all();
  assert.deepEqual(left.map((r) => r.kind), ['stripe']);

  // Undo with nothing left is a no-op, not an error.
  await call('/api/staff/promote/undo', { method: 'POST', body: { contactId: jack } });
  const empty = await (await call('/api/staff/promote/undo', { method: 'POST', body: { contactId: jack } })).json();
  assert.deepEqual(empty, { ok: true, removed: 0 });
});

test('member lookup carries the award history, newest first', async () => {
  const { call, give, id } = await setup();
  give('c_jack', 8);
  const jack = await id('c_jack');
  await call('/api/staff/promote', { method: 'POST', body: { contactId: jack, note: 'good week' } });
  const m = await (await call(`/api/staff/member?id=${jack}`)).json();
  assert.equal(m.first, 'Jack');
  assert.equal(m.promotions.length, 1);
  assert.equal(m.promotions[0].kind, 'stripe');
  assert.equal(m.promotions[0].atClassCount, 8);
  assert.equal(m.promotions[0].note, 'good week');
});

test('bad input is refused', async () => {
  const { call, give, id } = await setup();
  give('c_jack', 8);
  assert.equal((await call('/api/staff/promote', { method: 'POST', body: { contactId: await id('c_jack'), kind: 'sandwich' } })).status, 400);
  assert.equal((await call('/api/staff/promote', { method: 'POST', body: { contactId: 'c_jack' } })).status, 404, 'raw id refused');
  assert.equal((await call('/api/staff/promote', { method: 'POST', body: {} })).status, 404);
});

test('with the feature off the tab reports it and writes are refused', async () => {
  const { env, call, give } = await setup();
  give('c_jack', 20);
  env.STRIPE_PROGRAMS = '';
  const body = await (await call('/api/staff/stripes')).json();
  assert.equal(body.enabled, false);
  assert.deepEqual(body.rows, []);
  assert.equal((await call('/api/staff/promote', { method: 'POST', body: { contactId: 'x' } })).status, 404);
});

// ---------- pending migration (§15.1 rule) ----------

test('a pending promotions migration hides the tab and leaves the staff page working', async () => {
  const { call, give } = await setup({ noPromotions: true });
  give('c_jack', 20);
  const body = await (await call('/api/staff/stripes')).json();
  assert.equal(body.enabled, false);
  assert.equal(body.pendingMigration, true);
  assert.deepEqual(body.rows, []);

  // Everything else still works.
  assert.equal((await call('/api/staff/today')).status, 200);
  assert.equal((await call('/api/staff/class?start=2026-01-01T16:30')).status, 200);
});

test('recording against a pending migration says so instead of a 500', async () => {
  const { call, give, id } = await setup({ noPromotions: true });
  give('c_jack', 20);
  const res = await call('/api/staff/promote', { method: 'POST', body: { contactId: await id('c_jack') } });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /003_promotions\.sql/);
});

test('member lookup survives a pending migration with an empty history', async () => {
  const { call, id } = await setup({ noPromotions: true });
  const m = await (await call(`/api/staff/member?id=${await id('c_jack')}`)).json();
  assert.deepEqual(m.promotions, []);
  assert.equal(m.first, 'Jack');
});

test('the staff page uses review wording, never "due"', () => {
  const html = readRepoFile('public/staff.html');
  assert.match(html, /Eligible for review/);
  assert.match(html, /Record stripe/);
  assert.doesNotMatch(html, /due for a stripe/i);
});
