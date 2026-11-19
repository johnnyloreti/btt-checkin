// The member progress page (§15.7). A token in a link shows one member, or
// a parent's kids: class count, recent classes, belt and stripes. Read-only,
// no contact ids, nothing about money.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { progressToken, progressEnabled, progressFieldKey, weekStreak, nextMilestone, writeProgressLink, RECENT_CLASSES } from '../src/progress.js';
import { requiredFieldKeys } from '../src/fields.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { resetSchemaCaps } from '../src/schema-caps.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-23T15:00:00Z'); // Wed Sep 23, 11:00 ET
const PARENT = 'PARENTcontact0000001'; // a parent who does not train: not in members

async function setup({ noBelt = false, extraEnv = {}, deps = {} } = {}) {
  resetFallback();
  const DB = memoryD1({ noBelt });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York',
    PUBLIC_ORIGIN: 'https://checkin.bttbridgewater.com', PROGRESS_FIELD: 'progress_link', DB, ...extraEnv,
  };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => NOW, ...deps });
  let cookie = '';
  const call = (path, { method = 'GET', body, anon = false } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(cookie && !anon ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const attend = (contactId, startLocal, className = 'Kids 6-9', status = 'attended') =>
    DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status) VALUES (?, ?, ?, ?, 'kiosk', ?)")
      .run(contactId, className, startLocal, `${startLocal}:00Z`, status);
  const link = (kid, parent) => DB.raw.prepare('UPDATE members SET payer_contact_id = ? WHERE ghl_contact_id = ?').run(parent, kid);
  const page = async (contactId) => call(`/api/progress?t=${await progressToken(contactId, SALT)}`, { anon: true });
  return { env, DB, call, attend, link, page };
}

// ---------- pure ----------

test('the token is 32 hex, stable, one per contact, and not the kiosk id', async () => {
  const a = await progressToken('c_jack', SALT);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, await progressToken('c_jack', SALT));
  assert.notEqual(a, await progressToken('c_emma', SALT));
  assert.notEqual(a, await progressToken('c_jack', 'another-salt-value'));
  assert.ok(!a.startsWith(await opaqueId('c_jack', SALT)), 'a kiosk id never opens a progress page');
});

test('config: on unless switched off; the field only counts while the page is on', () => {
  assert.equal(progressEnabled({}), true);
  for (const off of ['off', '0', 'false']) assert.equal(progressEnabled({ PROGRESS_PAGE: off }), false, off);
  assert.equal(progressFieldKey({ PROGRESS_FIELD: ' progress_link ' }), 'progress_link');
  assert.equal(progressFieldKey({}), '');
  assert.equal(progressFieldKey({ PROGRESS_FIELD: 'progress_link', PROGRESS_PAGE: 'off' }), '');
  assert.ok(requiredFieldKeys({ PROGRESS_FIELD: 'progress_link' }).includes('progress_link'), '/health names it until it exists');
  assert.ok(!requiredFieldKeys({}).includes('progress_link'));
  assert.ok(!requiredFieldKeys({ PROGRESS_FIELD: 'progress_link', PROGRESS_PAGE: 'off' }).includes('progress_link'));
});

test('weekStreak counts back from this week, or from last week when this one is empty', () => {
  const today = '2026-09-23'; // Wed; this week starts Mon Sep 21
  assert.equal(weekStreak([], today), 0);
  assert.equal(weekStreak(['2026-09-22'], today), 1);
  assert.equal(weekStreak(['2026-09-22', '2026-09-15', '2026-09-12', '2026-09-01'], today), 4, 'two classes in one week count once');
  assert.equal(weekStreak(['2026-09-19', '2026-09-08'], today), 2, 'nothing yet this week: last week still holds the streak');
  assert.equal(weekStreak(['2026-09-22', '2026-09-08'], today), 1, 'a missed week breaks it');
  assert.equal(weekStreak(['2026-09-08'], today), 0, 'two weeks ago is not a streak');
});

test('nextMilestone is the next round number', () => {
  assert.deepEqual(nextMilestone(0), { at: 10, toGo: 10 });
  assert.deepEqual(nextMilestone(37), { at: 50, toGo: 13 });
  assert.deepEqual(nextMilestone(50), { at: 75, toGo: 25 });
  assert.equal(nextMilestone(1000), null);
});

// ---------- the page ----------

test('a member sees their own count, week, month, streak, milestone and recent classes', async () => {
  const { attend, page } = await setup();
  attend('c_jack', '2026-09-22T16:30');              // Tue this week
  attend('c_jack', '2026-09-17T16:30');              // last week
  attend('c_jack', '2026-09-12T11:00');              // the week before
  attend('c_jack', '2026-08-20T16:30');              // more than 30 days back
  attend('c_jack', '2026-09-19T00:00', 'open mat / unscheduled');
  attend('c_jack', '2026-09-16T16:30', 'Kids 6-9', 'voided'); // removed: not a class
  const res = await page('c_jack');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.today, '2026-09-23');
  assert.equal(body.people.length, 1);
  const jack = body.people[0];
  assert.deepEqual([jack.first, jack.last, jack.programLabels], ['Jack', 'Silva', ['Kids 6-9']]);
  assert.equal(jack.lifetime, 5);
  assert.equal(jack.week, 1);
  assert.equal(jack.last30, 4);
  assert.equal(jack.streakWeeks, 3);
  assert.deepEqual(jack.nextMilestone, { at: 10, toGo: 5 });
  assert.deepEqual(jack.recent.map((r) => [r.date, r.className, r.start]), [
    ['2026-09-22', 'Kids 6-9', '16:30'],
    ['2026-09-19', 'Open mat', null],
    ['2026-09-17', 'Kids 6-9', '16:30'],
    ['2026-09-12', 'Kids 6-9', '11:00'],
    ['2026-08-20', 'Kids 6-9', '16:30'],
  ]);
  assert.deepEqual(jack.rank, { belt: 'white', label: 'White belt', stripes: 0 });
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /c_jack|ghl_contact_id|payer/, 'no contact ids');
  assert.doesNotMatch(text, /tab|waiver|balance|billing|@/i, 'nothing about money, waivers or contact details');
});

test('recent classes stop at ten, newest first', async () => {
  const { attend, page } = await setup();
  for (let d = 1; d <= 14; d += 1) attend('c_jack', `2026-09-${String(d).padStart(2, '0')}T16:30`);
  const jack = (await (await page('c_jack')).json()).people[0];
  assert.equal(jack.lifetime, 14);
  assert.equal(jack.recent.length, RECENT_CLASSES);
  assert.equal(jack.recent[0].date, '2026-09-14');
  assert.equal(jack.recent[9].date, '2026-09-05');
});

test('rank follows the belt record, and is left off before migration 006', async () => {
  const ready = await setup();
  ready.DB.raw.prepare("INSERT INTO promotions (ghl_contact_id, kind, awarded_on, at_class_count, created_at, belt, stripes) VALUES ('c_jack', 'belt', '2026-09-01', 0, '2026-09-01T00:00:00Z', 'grey', 2)").run();
  assert.deepEqual((await (await ready.page('c_jack')).json()).people[0].rank, { belt: 'grey', label: 'Grey belt', stripes: 2 });

  const pending = await setup({ noBelt: true });
  const res = await pending.page('c_jack');
  assert.equal(res.status, 200, 'the page still opens');
  assert.equal((await res.json()).people[0].rank, null);
  resetSchemaCaps();
});

test('a parent who does not train sees every kid linked to them, by name', async () => {
  const { link, attend, page } = await setup();
  link('c_jack', PARENT);
  link('c_emma', PARENT);
  attend('c_emma', '2026-09-22T16:30');
  const body = await (await page(PARENT)).json();
  assert.deepEqual(body.people.map((p) => [p.first, p.lifetime]), [['Emma', 1], ['Jack', 0]]);
  // Each kid's own link still shows just that kid.
  assert.deepEqual((await (await page('c_jack')).json()).people.map((p) => p.first), ['Jack']);
});

test('a parent who trains comes first, then their kids', async () => {
  const { DB, attend, page } = await setup();
  // Dan trains and pays for Jack. Fixture ids are short, so write the link directly.
  DB.raw.prepare("UPDATE members SET ghl_contact_id = 'DANcontact0000000001' WHERE ghl_contact_id = 'c_dan'").run();
  DB.raw.prepare("UPDATE members SET payer_contact_id = 'DANcontact0000000001' WHERE ghl_contact_id = 'c_jack'").run();
  attend('DANcontact0000000001', '2026-09-22T18:15', 'Adult BJJ');
  const body = await (await page('DANcontact0000000001')).json();
  assert.deepEqual(body.people.map((p) => [p.first, p.programLabels[0]]), [['Dan', 'Adult'], ['Jack', 'Kids 6-9']]);
});

test('a wrong, malformed or stale token shows nothing and says nothing', async () => {
  const { DB, call, page } = await setup();
  for (const t of ['', 'nope', 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), await opaqueId('c_jack', SALT)]) {
    const res = await call(`/api/progress?t=${t}`, { anon: true });
    assert.equal(res.status, 404, JSON.stringify(t));
    assert.deepEqual(await res.json(), { ok: false });
  }
  assert.equal((await call('/api/progress', { anon: true })).status, 404);
  // A parent with nobody linked, and a member who left.
  assert.equal((await page(PARENT)).status, 404);
  DB.raw.prepare("UPDATE members SET active = 0 WHERE ghl_contact_id = 'c_jack'").run();
  assert.equal((await page('c_jack')).status, 404);
});

test('the page needs no PIN, and /me serves it', async () => {
  const { env, call, page } = await setup();
  env.ASSETS = { fetch: async (req) => new Response(new URL(req.url).pathname) };
  assert.equal((await page('c_jack')).status, 200, 'the token is the key');
  const me = await call('/me?t=abc', { anon: true });
  assert.equal(me.status, 200);
  assert.equal(await me.text(), '/me.html');
});

// ---------- the staff side ----------

test('the member screen carries the link: own for a member, the parent\'s for a linked kid', async () => {
  const { call, link } = await setup();
  const jackId = await opaqueId('c_jack', SALT);
  let m = await (await call(`/api/staff/member?id=${jackId}`)).json();
  assert.deepEqual(m.progress, { enabled: true, url: `https://checkin.bttbridgewater.com/me?t=${await progressToken('c_jack', SALT)}`, to: 'member', canText: true });
  link('c_jack', PARENT);
  m = await (await call(`/api/staff/member?id=${jackId}`)).json();
  assert.deepEqual(m.progress, { enabled: true, url: `https://checkin.bttbridgewater.com/me?t=${await progressToken(PARENT, SALT)}`, to: 'parent', canText: true });
});

test('with no field named, staff can still copy the link but not text it', async () => {
  const { call } = await setup({ extraEnv: { PROGRESS_FIELD: '' } });
  const m = await (await call(`/api/staff/member?id=${await opaqueId('c_jack', SALT)}`)).json();
  assert.equal(m.progress.canText, false);
  assert.match(m.progress.url, /\/me\?t=[0-9a-f]{32}$/);
});

test('texting the link writes it to the right contact, behind the PIN', async () => {
  const written = [];
  const { call, link } = await setup({ deps: { progressLink: async (env, contactId, url) => { written.push([contactId, url]); return { ok: true }; } } });
  const jackId = await opaqueId('c_jack', SALT);
  assert.equal((await call('/api/staff/progress-link', { method: 'POST', body: { contactId: jackId }, anon: true })).status, 401);
  assert.equal((await call('/api/staff/progress-link', { method: 'POST', body: { contactId: 'f'.repeat(20) } })).status, 404);

  let r = await (await call('/api/staff/progress-link', { method: 'POST', body: { contactId: jackId } })).json();
  assert.deepEqual(r, { ok: true, to: 'member' });
  link('c_jack', PARENT);
  r = await (await call('/api/staff/progress-link', { method: 'POST', body: { contactId: jackId } })).json();
  assert.deepEqual(r, { ok: true, to: 'parent' });
  assert.deepEqual(written, [
    ['c_jack', `https://checkin.bttbridgewater.com/me?t=${await progressToken('c_jack', SALT)}`],
    [PARENT, `https://checkin.bttbridgewater.com/me?t=${await progressToken(PARENT, SALT)}`],
  ]);
});

test('a link that could not be written says why', async () => {
  const { call } = await setup({ deps: { progressLink: async () => ({ ok: false, reason: 'custom field progress_link not found in GHL' }) } });
  const r = await (await call('/api/staff/progress-link', { method: 'POST', body: { contactId: await opaqueId('c_jack', SALT) } })).json();
  assert.deepEqual(r, { ok: false, to: 'member', reason: 'custom field progress_link not found in GHL' });
});

test('writeProgressLink puts the link, with the day on the end, in the named field', async () => {
  const puts = [];
  const deps = { getFieldIds: async () => new Map([['progress_link', 'fld_progress']]), putContact: async (id, fields) => { puts.push([id, fields]); } };
  const env = { PROGRESS_FIELD: 'progress_link', TZ: 'America/New_York' };
  // 03:30 UTC on Sep 24 is still Sep 23 in New York.
  assert.deepEqual(await writeProgressLink(env, deps, 'abc', 'https://x.test/me?t=1', new Date('2026-09-24T03:30:00Z')), { ok: true });
  assert.deepEqual(puts, [['abc', [{ id: 'fld_progress', field_value: 'https://x.test/me?t=1&d=20260923' }]]]);

  assert.deepEqual(await writeProgressLink({ ...env, PROGRESS_FIELD: '' }, deps, 'abc', 'u', NOW), { ok: false, reason: 'PROGRESS_FIELD is not set' });
  const missing = { ...deps, getFieldIds: async () => new Map() };
  assert.deepEqual(await writeProgressLink(env, missing, 'abc', 'u', NOW), { ok: false, reason: 'custom field progress_link not found in GHL' });
  const broken = { ...deps, putContact: async () => { throw new Error('GHL 500'); } };
  assert.deepEqual(await writeProgressLink(env, broken, 'abc', 'u', NOW), { ok: false, reason: 'GHL 500' });
  assert.equal(puts.length, 1);
});

test('switched off: no page, no link, no route', async () => {
  const { env, call, page } = await setup({ extraEnv: { PROGRESS_PAGE: 'off' } });
  env.ASSETS = { fetch: async () => new Response('page') };
  assert.equal((await page('c_jack')).status, 404);
  assert.equal((await call('/me', { anon: true })).status, 404);
  const jackId = await opaqueId('c_jack', SALT);
  assert.deepEqual((await (await call(`/api/staff/member?id=${jackId}`)).json()).progress, { enabled: false });
  assert.equal((await call('/api/staff/progress-link', { method: 'POST', body: { contactId: jackId } })).status, 404);
});
