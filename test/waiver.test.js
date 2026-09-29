import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster, classifyContact, rosterConfig } from '../src/roster.js';
import { notifyWaiverCheckin, payerNudgeValue } from '../src/waiver.js';
import { resetFieldCache } from '../src/rollup.js';
import { requiredFieldKeys } from '../src/fields.js';
import { health } from '../src/app.js';
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
  assert.deepEqual(await notifyWaiverCheckin(env, deps, 'c_emma', now), { ok: true, to: 'self' });
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

test('a nudge that fails is written to sync_log and counted on /health', async () => {
  resetFallback();
  resetFieldCache();
  const DB = memoryD1();
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', WAIVER_TAG: 'waiver-signed', WAIVER_FIELD: 'checkin_last_at', DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: WITH_WAIVERS, pages: 1 }), now: new Date(SAT_1055.getTime() - 3600_000) });
  const app = createApp(schedule, {
    runRosterSync: async () => ({ outcome: 'ok' }),
    notifyWaiver: async () => ({ ok: false, reason: 'custom field checkin_last_at not found in GHL' }),
    now: () => SAT_1055,
  });
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  const res = await app.fetch(
    new Request('https://x.test/api/checkin', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1' }, body: JSON.stringify({ contactId: await opaqueId('c_emma', SALT), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' }) }),
    env,
    ctx,
  );
  assert.equal(res.status, 200, 'the check-in itself is untouched');
  await Promise.all(waited);
  const rows = DB.raw.prepare("SELECT ran_at, outcome, detail FROM sync_log WHERE job = 'waiver'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'failed');
  assert.equal(rows[0].ran_at, SAT_1055.toISOString());
  const detail = JSON.parse(rows[0].detail);
  assert.equal(detail.contactId, 'c_emma');
  assert.match(detail.reason, /checkin_last_at not found/);

  const h = await (await app.fetch(new Request('https://x.test/health'), env, ctx)).json();
  assert.equal(h.waiverFailures24h, 1);
  assert.match(h.waiverLastFailure, /checkin_last_at not found/);
});

test('kiosk page carries the waiver line and the QR slot', () => {
  const html = readRepoFile('public/index.html');
  assert.match(html, /One thing before class: sign the waiver/);
  assert.match(html, /waiver-qr\.png/);
  const block = /<div id="waiver"[\s\S]*?<\/div>/.exec(html);
  assert.ok(block, 'waiver block present');
  assert.doesNotMatch(block[0], /!/, 'member-facing copy takes no exclamation points (§0.9)');
  assert.doesNotMatch(block[0], /—/);
});

// ---- Phase 1b: a kid's reminder goes to the payer ----

const PAYER = 'parentContact01';
const FIELDS = new Map([
  ['checkin_last_at', 'f_ck'], ['waiver_reminder_for', 'f_wr'], ['payer_contact_id', 'f_pc'],
  ['attendance_last', 'f_al'], ['attendance_30d', 'f_a30'], ['attendance_lifetime', 'f_alt'], ['attendance_week', 'f_aw'], ['attendance_class_count_label', 'f_acl'],
]);
const KID_ENV = { WAIVER_TAG: 'waiver-signed', WAIVER_FIELD: 'checkin_last_at', WAIVER_PAYER_FIELD: 'waiver_reminder_for', PAYER_FIELD: 'payer_contact_id' };
// Tue Sep 29 2026, 4:40 PM ET.
const TUE = new Date('2026-09-29T20:40:00Z');

test('the payer field value names the kid and the ET day, with no em dash', () => {
  assert.equal(payerNudgeValue('Emma Jones', TUE), 'Emma Jones, checked in Tue Sep 29');
  // 11:30 PM ET on the 29th is the 30th in UTC; the day is ET's.
  assert.equal(payerNudgeValue('Emma Jones', new Date('2026-09-30T03:30:00Z')), 'Emma Jones, checked in Tue Sep 29');
  assert.equal(payerNudgeValue('', TUE), 'Your child, checked in Tue Sep 29');
  assert.doesNotMatch(payerNudgeValue('A B', TUE), /—|!/);
});

test('a kid with a payer: the payer is written, in its own field, and the kid is not', async () => {
  resetFieldCache();
  const puts = [];
  const deps = { fetchFields: async () => FIELDS, putContact: async (id, fields) => puts.push({ id, fields }) };
  const r = await notifyWaiverCheckin(KID_ENV, deps, 'c_emma', TUE, { payerId: PAYER, name: 'Emma Jones' });
  assert.deepEqual(r, { ok: true, to: 'payer' });
  assert.deepEqual(puts, [{ id: PAYER, fields: [{ id: 'f_wr', field_value: 'Emma Jones, checked in Tue Sep 29' }] }]);
  resetFieldCache();
});

test('no payer, a payer equal to the kid, or a junk payer id: the kid is written as before', async () => {
  for (const payerId of [null, 'c_emma', 'not a contact id!']) {
    resetFieldCache();
    const puts = [];
    const deps = { fetchFields: async () => FIELDS, putContact: async (id, fields) => puts.push({ id, fields }) };
    const r = await notifyWaiverCheckin(KID_ENV, deps, 'c_emma', TUE, { payerId, name: 'Emma Jones' });
    assert.deepEqual(r, { ok: true, to: 'self' }, String(payerId));
    assert.deepEqual(puts, [{ id: 'c_emma', fields: [{ id: 'f_ck', field_value: TUE.toISOString() }] }]);
  }
  // Routing off (WAIVER_PAYER_FIELD blank) ignores a linked payer.
  resetFieldCache();
  const puts = [];
  const deps = { fetchFields: async () => FIELDS, putContact: async (id, fields) => puts.push({ id, fields }) };
  const r = await notifyWaiverCheckin({ ...KID_ENV, WAIVER_PAYER_FIELD: '' }, deps, 'c_emma', TUE, { payerId: PAYER, name: 'Emma Jones' });
  assert.equal(r.to, 'self');
  assert.equal(puts[0].id, 'c_emma');
  resetFieldCache();
});

test('the payer field missing in GHL, or the payer write failing, falls back to the kid and still counts as a failure', async () => {
  resetFieldCache();
  let puts = [];
  const noPayerField = new Map([...FIELDS].filter(([k]) => k !== 'waiver_reminder_for'));
  let r = await notifyWaiverCheckin(KID_ENV, { fetchFields: async () => noPayerField, putContact: async (id, f) => puts.push({ id, f }) }, 'c_emma', TUE, { payerId: PAYER, name: 'Emma Jones' });
  assert.equal(r.ok, false);
  assert.equal(r.to, 'self');
  assert.match(r.reason, /waiver_reminder_for not found in GHL; wrote the member's own contact instead/);
  assert.deepEqual(puts.map((p) => p.id), ['c_emma']);

  resetFieldCache();
  puts = [];
  const putContact = async (id, f) => { if (id === PAYER) throw new Error('GHL 400 on /contacts/parentContact01: contact not found'); puts.push({ id, f }); };
  r = await notifyWaiverCheckin(KID_ENV, { fetchFields: async () => FIELDS, putContact }, 'c_emma', TUE, { payerId: PAYER, name: 'Emma Jones' });
  assert.equal(r.ok, false);
  assert.equal(r.to, 'self');
  assert.match(r.reason, /payer write failed: GHL 400.*contact not found; wrote the member's own contact instead/);
  assert.deepEqual(puts.map((p) => p.id), ['c_emma']);
  resetFieldCache();
});

test('the payer field is required once set, so /health names it before the first kid checks in', () => {
  assert.deepEqual(requiredFieldKeys(KID_ENV).slice(-2), ['checkin_last_at', 'waiver_reminder_for']);
  assert.equal(requiredFieldKeys({ ...KID_ENV, WAIVER_PAYER_FIELD: '' }).includes('waiver_reminder_for'), false);
  assert.equal(requiredFieldKeys({ ...KID_ENV, WAIVER_TAG: '' }).includes('waiver_reminder_for'), false);
});

// Emma (kid, no waiver) is linked to a parent; Leo (kid + adult) is not.
const LINKED = WITH_WAIVERS.map((c) => {
  if (c.id === 'c_emma') return { ...c, customFields: [{ id: 'f_pc', value: PAYER }] };
  if (c.id === 'c_nora' || c.id === 'c_newkid') return { ...c, customFields: [{ id: 'f_pc', value: 'bad id!' }] };
  return { ...c, customFields: [] };
});

async function linkedSetup({ contacts = LINKED, fields = FIELDS, noPayer = false, now = SAT_1055 } = {}) {
  resetFallback();
  resetFieldCache();
  const DB = memoryD1({ noPayer });
  const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', ...KID_ENV, DB };
  const sync = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts, pages: 1 }), fetchFields: async () => fields, now: new Date(now.getTime() - 3600_000) });
  const nudges = [];
  const app = createApp(schedule, {
    runRosterSync: async () => ({ outcome: 'ok' }),
    notifyWaiver: async (e, contactId, at, opts) => (nudges.push({ contactId, opts }), { ok: true, to: opts.payerId ? 'payer' : 'self' }),
    now: () => now,
  });
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  const post = (path, body, headers = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...headers }, body: JSON.stringify(body) }), env, ctx);
  const get = (path, headers = {}) => app.fetch(new Request(`https://x.test${path}`, { headers: { 'cf-connecting-ip': '10.0.0.1', ...headers } }), env, ctx);
  return { env, DB, sync, app, post, get, nudges, waited, id: (c) => opaqueId(c, SALT) };
}

test('the roster sync stores the payer link, flags a junk one by name, and reports kids without one', async () => {
  const { DB, sync } = await linkedSetup();
  const rows = Object.fromEntries(DB.raw.prepare('SELECT ghl_contact_id, payer_contact_id FROM members').all().map((r) => [r.ghl_contact_id, r.payer_contact_id]));
  assert.equal(rows.c_emma, PAYER);
  assert.equal(rows.c_jack, null);
  assert.equal(rows.c_newkid, null, 'a value that is not a contact id is not used');
  assert.ok(sync.flagged.some((f) => /Nora Newkid: payer link is not a contact id/.test(f)));
  assert.equal(sync.payerLinks.field, 'ok');
  assert.equal(sync.payerLinks.stored, true);
  assert.equal(sync.payerLinks.linked, 1);
  assert.equal(sync.payerLinks.kidsWithout, sync.payerLinks.kids - 1);
  assert.ok(sync.payerLinks.kidsWithoutNames.includes('Jack Silva'));
  assert.equal(sync.payerLinks.kidsWithoutNames.includes('Emma Jones'), false);
  assert.equal(sync.outcome, 'ok', 'kids without a payer are reported, not a failure');
});

test('links are left as they were when they cannot be read: field missing in GHL, fields unreadable, or no custom fields on the list', async () => {
  const { env, DB } = await linkedSetup();
  assert.equal(DB.raw.prepare("SELECT payer_contact_id FROM members WHERE ghl_contact_id = 'c_emma'").get().payer_contact_id, PAYER);
  const bare = LINKED.map(({ customFields, ...c }) => c);
  const cases = [
    { deps: { fetchFields: async () => new Map([['checkin_last_at', 'f_ck']]) }, contacts: LINKED, state: 'missing in GHL' },
    { deps: { fetchFields: async () => { throw new Error('GHL 503'); } }, contacts: LINKED, state: /^unreadable: GHL 503/ },
    { deps: { fetchFields: async () => FIELDS }, contacts: bare, state: /no custom fields/ },
  ];
  for (const c of cases) {
    resetFieldCache();
    const r = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: c.contacts, pages: 1 }), ...c.deps, now: new Date() });
    if (c.state instanceof RegExp) assert.match(r.payerLinks.field, c.state); else assert.equal(r.payerLinks.field, c.state);
    assert.equal(r.payerLinks.linked, null, 'not read is null, never zero');
    assert.equal(DB.raw.prepare("SELECT payer_contact_id FROM members WHERE ghl_contact_id = 'c_emma'").get().payer_contact_id, PAYER, 'kept');
  }
  // A link removed in GHL, read properly, is cleared.
  resetFieldCache();
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: LINKED.map((c) => ({ ...c, customFields: [] })), pages: 1 }), fetchFields: async () => FIELDS, now: new Date() });
  assert.equal(DB.raw.prepare("SELECT payer_contact_id FROM members WHERE ghl_contact_id = 'c_emma'").get().payer_contact_id, null);
  resetFieldCache();
});

test('check-in passes the payer and the kid name to the nudge; a kid with no payer is nudged on their own contact', async () => {
  const { post, nudges, waited, id } = await linkedSetup();
  await post('/api/checkin', { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' });
  await Promise.all(waited);
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].contactId, 'c_emma');
  assert.deepEqual(nudges[0].opts, { payerId: PAYER, name: 'Emma Jones', tz: 'America/New_York' });

  const { post: post2, nudges: n2, waited: w2, id: id2 } = await linkedSetup({ contacts: WITH_WAIVERS.map((c) => ({ ...c, customFields: [] })) });
  await post2('/api/checkin', { contactId: await id2('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' });
  await Promise.all(w2);
  assert.equal(n2[0].opts.payerId, null);
});

test('member lookup says whether a parent is linked, never the id; /health carries the coverage', async () => {
  const { post, get, env, id } = await linkedSetup();
  const login = await post('/api/staff/login', { pin: '1234' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const emma = await (await get(`/api/staff/member?id=${await id('c_emma')}`, { cookie })).text();
  assert.equal(JSON.parse(emma).payerLinked, true);
  assert.equal(emma.includes(PAYER), false, 'the payer contact id never leaves the Worker');
  const jack = await (await get(`/api/staff/member?id=${await id('c_jack')}`, { cookie })).json();
  assert.equal(jack.payerLinked, false);
  const h = await health(env, schedule, SAT_1055);
  assert.equal(h.payerLinks.linked, 1);
  assert.equal(h.payerLinks.field, 'ok');
});

test('before migration 005: check-in, sync and lookup all work, links are not stored, and /health names the file', async () => {
  const { DB, sync, post, get, nudges, waited, env, id } = await linkedSetup({ noPayer: true });
  assert.equal(sync.outcome, 'ok');
  assert.equal(sync.payerLinks.stored, false);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM members').get().n > 0, true);
  const res = await post('/api/checkin', { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' });
  assert.equal(res.status, 200, 'attendance is untouched');
  await Promise.all(waited);
  assert.equal(nudges[0].opts.payerId, null, 'no column, no payer: the kid is nudged as before');
  const login = await post('/api/staff/login', { pin: '1234' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const emma = await (await get(`/api/staff/member?id=${await id('c_emma')}`, { cookie })).json();
  assert.equal(emma.payerLinked, null);
  const h = await health(env, schedule, SAT_1055);
  assert.equal(h.ok, false);
  assert.match(h.error, /005_payer\.sql/);
  assert.equal(h.schemaCurrent, false);
});

// ---- A parent's signature covers the kid (Johnny, 2026-09-29) ----

// Paula pays for Emma and does not train; she signed. Dan trains and signed
// his own agreement; he is linked as Nora's payer. Nobody signed for Leo.
const PAULA = { id: 'parentPaula01', firstName: 'Paula', lastName: 'Payer', tags: ['founding-member', 'program:none', 'waiver-signed'] };
const DAN_ID = 'danKimAdult01';
const FAMILIES = [
  ...WITH_WAIVERS.filter((c) => c.id !== 'c_dan').map((c) => {
    if (c.id === 'c_emma') return { ...c, customFields: [{ id: 'f_pc', value: PAULA.id }] };
    if (c.id === 'c_newkid') return { ...c, customFields: [{ id: 'f_pc', value: DAN_ID }] };
    if (c.id === 'c_leo') return { ...c, customFields: [{ id: 'f_pc', value: 'parentNoSign01' }] };
    return { ...c, customFields: [] };
  }),
  PAULA,
  { id: DAN_ID, firstName: 'Dan', lastName: 'Kim', tags: ['foundations-oct', 'program:adult', 'waiver-signed'], customFields: [] },
  { id: 'parentNoSign01', firstName: 'Pat', lastName: 'Unsigned', tags: ['program:none'], customFields: [] },
];

test("a kid counts as signed when their non-training parent carries the tag, not when a training parent does", async () => {
  const { DB, sync, post, nudges, waited, id } = await linkedSetup({ contacts: FAMILIES });
  const w = Object.fromEntries(DB.raw.prepare('SELECT ghl_contact_id, waiver FROM members').all().map((r) => [r.ghl_contact_id, r.waiver]));
  assert.equal(w.c_emma, 1, 'Paula signed on her behalf');
  assert.equal(w.c_newkid, 0, "Dan's tag is his own agreement");
  assert.equal(w.c_leo, 0, 'Pat never signed');
  assert.equal(w[DAN_ID], 1, 'Dan himself is signed');
  assert.equal(w.parentPaula01, undefined, 'a program:none parent is never a member row');
  assert.equal(sync.waiverViaPayer, 1);

  // Emma is no longer prompted or nudged; Leo still is, and to his parent.
  const emma = await (await post('/api/checkin', { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-05T11:00' })).json();
  assert.equal(emma.waiverNeeded, false);
  const leo = await (await post('/api/checkin', { contactId: await id('c_leo'), className: 'Kids 10-14', classStartLocal: '2026-09-05T11:45' })).json();
  assert.equal(leo.waiverNeeded, true);
  await Promise.all(waited);
  assert.deepEqual(nudges.map((n) => [n.contactId, n.opts.payerId]), [['c_leo', 'parentNoSign01']]);
});

test('a failed field read keeps a kid signed through the stored link, and a parent losing the tag unsigns the kid', async () => {
  const { env, DB } = await linkedSetup({ contacts: FAMILIES });
  resetFieldCache();
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: FAMILIES, pages: 1 }), fetchFields: async () => { throw new Error('GHL 503'); }, now: new Date() });
  assert.equal(DB.raw.prepare("SELECT waiver FROM members WHERE ghl_contact_id = 'c_emma'").get().waiver, 1, 'stored link used');

  resetFieldCache();
  const unsigned = FAMILIES.map((c) => (c.id === PAULA.id ? { ...c, tags: ['founding-member', 'program:none'] } : c));
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: unsigned, pages: 1 }), fetchFields: async () => FIELDS, now: new Date() });
  assert.equal(DB.raw.prepare("SELECT waiver FROM members WHERE ghl_contact_id = 'c_emma'").get().waiver, 0);
  resetFieldCache();
});
