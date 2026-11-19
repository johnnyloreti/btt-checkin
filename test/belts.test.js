// Belts (§15.4). Rank is a belt plus the stripes on it, read from the same
// promotions table the stripe tab writes. Migration 006 adds the columns;
// a deploy ahead of it hides rank and leaves stripes working.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, health } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { beltConfig, beltsEnabled, beltOptionsFor, beltLabel, rankFrom, degreeStripes, degreeText, kidsStripesMonthly, KIDS_DEGREES, DEFAULT_BELTS_KIDS, DEFAULT_BELTS_ADULT } from '../src/promotions.js';
import { hasBeltColumns, resetSchemaCaps } from '../src/schema-caps.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-23T15:00:00Z'); // Wed 11:00 ET

async function setup({ noBelt = false, extraEnv = {} } = {}) {
  resetFallback();
  const DB = memoryD1({ noBelt });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234',
    ID_SALT: SALT, TZ: 'America/New_York',
    STRIPE_CLASSES: '7', STRIPE_PROGRAMS: 'kids-3-5,kids-6-9,kids-10-14', DB, ...extraEnv,
  };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
  let at = NOW;
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => at });
  let cookie = '';
  const call = (path, { method = 'GET', body } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
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
  // Each write a second later, so "most recent" is never a tie.
  const tick = () => { at = new Date(at.getTime() + 1000); };
  const promote = async (contactId, body) => { tick(); return call('/api/staff/promote', { method: 'POST', body: { contactId: await opaqueId(contactId, SALT), ...body } }); };
  const member = async (contactId) => (await call(`/api/staff/member?id=${await opaqueId(contactId, SALT)}`)).json();
  return { env, DB, call, give, promote, member, id: (c) => opaqueId(c, SALT) };
}

// A kid's rank on the monthly degrees (§15.12), as the API returns it.
const BELT = (key) => `${key.charAt(0).toUpperCase()}${key.slice(1)} belt`;
function kidRank(belt, stripes, recorded) {
  const next = DEFAULT_BELTS_KIDS[DEFAULT_BELTS_KIDS.indexOf(belt) + 1] || null;
  return {
    belt, label: BELT(belt), stripes, recorded,
    maxStripes: 11, colours: degreeStripes(stripes), coloursText: degreeText(stripes), full: stripes >= 11,
    nextBelt: next, nextLabel: next ? BELT(next) : null,
  };
}

// ---------- pure ----------

test('beltConfig: defaults when unset, a blank list is empty, both blank is off', () => {
  assert.deepEqual(beltConfig({}), { kids: DEFAULT_BELTS_KIDS, adult: DEFAULT_BELTS_ADULT, kidsMonthly: true });
  assert.equal(DEFAULT_BELTS_KIDS[0], 'white');
  assert.deepEqual(DEFAULT_BELTS_ADULT, ['white', 'blue', 'purple', 'brown', 'black']);
  assert.deepEqual(beltConfig({ BELTS_KIDS: ' White , Grey ', BELTS_ADULT: '', KIDS_STRIPES: 'plain' }), { kids: ['white', 'grey'], adult: [], kidsMonthly: false });
  assert.equal(beltsEnabled({}), true);
  assert.equal(beltsEnabled({ BELTS_KIDS: '', BELTS_ADULT: 'white' }), true);
  assert.equal(beltsEnabled({ BELTS_KIDS: '', BELTS_ADULT: '' }), false);
  assert.equal(beltLabel('grey-white'), 'Grey-white');
});

test('belt options follow the program: kids list, adult list, or both', () => {
  const cfg = { kids: ['white', 'grey', 'yellow'], adult: ['white', 'blue'] };
  assert.deepEqual(beltOptionsFor(['kids-6-9'], cfg), ['white', 'grey', 'yellow']);
  assert.deepEqual(beltOptionsFor(['adult'], cfg), ['white', 'blue']);
  assert.deepEqual(beltOptionsFor(['kids-10-14', 'adult'], cfg), ['white', 'grey', 'yellow', 'blue'], 'both, white once');
  assert.deepEqual(beltOptionsFor([], cfg), ['white', 'blue'], 'no program reads as adult');
});

test('rank: first belt until one is recorded, a belt sets belt and stripes, each stripe adds one', () => {
  const cfg = { kids: ['white', 'grey', 'yellow'], adult: ['white', 'blue'] };
  assert.deepEqual(rankFrom([], ['kids-6-9'], cfg), { belt: 'white', label: 'White belt', stripes: 0, recorded: false });
  const two = [{ kind: 'stripe' }, { kind: 'stripe' }];
  assert.deepEqual(rankFrom(two, ['kids-6-9'], cfg), { belt: 'white', label: 'White belt', stripes: 2, recorded: false });
  // A new belt wipes the stripes; later stripes count on the new belt.
  const promoted = [...two, { kind: 'belt', belt: 'grey', stripes: 0 }, { kind: 'stripe' }];
  assert.deepEqual(rankFrom(promoted, ['kids-6-9'], cfg), { belt: 'grey', label: 'Grey belt', stripes: 1, recorded: true });
  // A rank set with stripes already on it.
  assert.deepEqual(rankFrom([{ kind: 'belt', belt: 'blue', stripes: 3 }, { kind: 'stripe' }], ['adult'], cfg), { belt: 'blue', label: 'Blue belt', stripes: 4, recorded: true });
  // A belt row written before migration 006 has no belt name: keep the current one.
  assert.deepEqual(rankFrom([{ kind: 'stripe' }, { kind: 'belt', belt: null, stripes: 0 }], ['adult'], cfg), { belt: 'white', label: 'White belt', stripes: 0, recorded: false });
  assert.equal(rankFrom([], ['adult'], { kids: [], adult: [] }), null, 'no belts configured');
});

// ---------- routes ----------

test('recording a belt needs a known belt and a sane stripe count', async () => {
  const { promote, DB } = await setup();
  assert.equal((await promote('c_jack', { kind: 'belt' })).status, 400, 'no belt named');
  assert.equal((await promote('c_jack', { kind: 'belt', belt: 'plaid' })).status, 400);
  for (const stripes of [-1, 1.5, 13, 'two']) {
    assert.equal((await promote('c_jack', { kind: 'belt', belt: 'grey', stripes })).status, 400, String(stripes));
  }
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM promotions').get().n, 0, 'nothing written');
  const ok = await (await promote('c_jack', { kind: 'belt', belt: 'Grey', stripes: 2 })).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.belt, 'grey');
  assert.equal(ok.stripes, 2);
  assert.equal(ok.starting, false);
  const row = DB.raw.prepare('SELECT kind, belt, stripes, starting FROM promotions').get();
  assert.deepEqual([row.kind, row.belt, row.stripes, row.starting], ['belt', 'grey', 2, 0]);
});

test('a belt promotion starts a new stripe interval; a rank already held does not', async () => {
  const { give, promote, call } = await setup();
  const stripeRows = async () => (await (await call('/api/staff/stripes')).json()).rows.map((r) => [r.first, r.since]);

  // Jack is 8 classes in and due. Setting the rank he walked in with keeps him due.
  give('c_jack', 8);
  assert.deepEqual(await stripeRows(), [['Jack', 8]]);
  await promote('c_jack', { kind: 'belt', belt: 'grey', stripes: 1, starting: true });
  assert.deepEqual(await stripeRows(), [['Jack', 8]], 'the class count is left alone');

  // A real belt promotion clears him and counts from here.
  await promote('c_jack', { kind: 'belt', belt: 'grey-black' });
  assert.deepEqual(await stripeRows(), []);
  give('c_jack', 7);
  const again = (await (await call('/api/staff/stripes')).json()).rows[0];
  assert.equal(again.since, 7);
  assert.equal(again.lastKind, 'belt');
  assert.deepEqual(again.rank, kidRank('grey-black', 0, true), 'rank rides along on the stripe list');
});

test('member lookup carries rank, the belts on offer, and belt history', async () => {
  const { give, promote, member } = await setup();
  give('c_jack', 9);
  let m = await member('c_jack');
  assert.equal(m.rank.enabled, true);
  assert.deepEqual(m.rank.rank, kidRank('white', 0, false), 'white until told otherwise');
  assert.deepEqual(m.rank.options.map((o) => o.key), DEFAULT_BELTS_KIDS);
  assert.equal(m.rank.options[1].label, 'Grey-white belt');
  assert.equal(m.canRecordStripe, true);

  await promote('c_jack', { kind: 'stripe' });
  await promote('c_jack', { kind: 'stripe' });
  assert.deepEqual((await member('c_jack')).rank.rank, kidRank('white', 2, false));

  await promote('c_jack', { kind: 'belt', belt: 'grey-white' });
  await promote('c_jack', { kind: 'stripe' });
  m = await member('c_jack');
  assert.deepEqual(m.rank.rank, kidRank('grey-white', 1, true));
  assert.deepEqual(m.promotions.map((p) => [p.kind, p.beltLabel, p.starting]), [['stripe', null, false], ['belt', 'Grey-white belt', false], ['stripe', null, false], ['stripe', null, false]]);

  // An adult gets the adult list.
  const dan = await member('c_dan');
  assert.deepEqual(dan.rank.options.map((o) => o.key), DEFAULT_BELTS_ADULT);
});

test('undo removes the last belt and the rank falls back', async () => {
  const { promote, member, call, id } = await setup();
  await promote('c_dan', { kind: 'belt', belt: 'blue', stripes: 2, starting: true });
  let dan = await member('c_dan');
  assert.deepEqual(dan.rank.rank, { belt: 'blue', label: 'Blue belt', stripes: 2, recorded: true });
  assert.equal(dan.promotions[0].starting, true);
  await call('/api/staff/promote/undo', { method: 'POST', body: { contactId: await id('c_dan') } });
  dan = await member('c_dan');
  assert.deepEqual(dan.rank.rank, { belt: 'white', label: 'White belt', stripes: 0, recorded: false });
});

test('the class roster shows rank beside each name', async () => {
  const { promote, call, id } = await setup();
  await promote('c_jack', { kind: 'belt', belt: 'grey', stripes: 3, starting: true });
  for (const c of ['c_jack', 'c_emma']) {
    const res = await call('/api/staff/add', { method: 'POST', body: { contactId: await id(c), className: 'Kids 6-9', classStartLocal: '2026-09-23T16:30' } });
    assert.equal(res.status, 200);
  }
  const roster = await (await call('/api/staff/class?start=2026-09-23T16:30&name=Kids%206-9')).json();
  assert.deepEqual(roster.rows.map((r) => [r.first, r.rank.label, r.rank.stripes]), [['Jack', 'Grey belt', 3], ['Emma', 'White belt', 0]]);
});

test('an adult can hold a belt while stripe tracking is kids only, and belts switch off on their own', async () => {
  const stripesOff = await setup({ extraEnv: { STRIPE_PROGRAMS: '' } });
  assert.equal((await stripesOff.promote('c_dan', { kind: 'belt', belt: 'blue' })).status, 200, 'belts work with the stripe tab off');
  assert.equal((await stripesOff.promote('c_dan', { kind: 'stripe' })).status, 404);
  assert.equal((await stripesOff.member('c_dan')).canRecordStripe, false);

  const beltsOff = await setup({ extraEnv: { BELTS_KIDS: '', BELTS_ADULT: '' } });
  assert.equal((await beltsOff.promote('c_jack', { kind: 'belt', belt: 'grey' })).status, 404);
  assert.equal((await beltsOff.promote('c_jack', { kind: 'stripe' })).status, 200, 'stripes are untouched');
  assert.deepEqual((await beltsOff.member('c_jack')).rank, { enabled: false });
});

// ---------- migration 006 pending ----------

test('before migration 006: rank is hidden, stripes still work, a belt is refused with the filename', async () => {
  const { env, give, promote, member, call, id } = await setup({ noBelt: true });
  assert.equal(await hasBeltColumns(env), false);
  give('c_jack', 7);

  const list = await (await call('/api/staff/stripes')).json();
  assert.equal(list.enabled, true);
  assert.deepEqual(list.rows.map((r) => [r.first, r.since, r.rank]), [['Jack', 7, null]]);

  assert.equal((await promote('c_jack', { kind: 'stripe' })).status, 200, 'the stripe tab keeps working');
  const refused = await promote('c_jack', { kind: 'belt', belt: 'grey' });
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /006_belts\.sql/);

  const m = await member('c_jack');
  assert.deepEqual(m.rank, { enabled: false });
  assert.deepEqual(m.promotions.map((p) => [p.kind, p.belt, p.starting]), [['stripe', null, false]]);

  const add = await call('/api/staff/add', { method: 'POST', body: { contactId: await id('c_jack'), className: 'Kids 6-9', classStartLocal: '2026-09-23T16:30' } });
  assert.equal(add.status, 200);
  const roster = await (await call('/api/staff/class?start=2026-09-23T16:30&name=Kids%206-9')).json();
  assert.deepEqual(roster.rows.map((r) => [r.first, r.rank]), [['Jack', null]]);

  // The kiosk check-in path never touches these columns.
  const checkin = await call('/api/checkin', { method: 'POST', body: { contactId: await id('c_emma'), className: 'Kids 6-9', classStartLocal: '2026-09-23T16:30' } });
  assert.equal(checkin.status, 200);

  const h = await health(env, schedule, NOW);
  assert.equal(h.ok, false);
  assert.equal(h.schemaCurrent, false);
  assert.match(JSON.stringify(h), /006_belts\.sql/);
  resetSchemaCaps();
});

test('after migration 006, /health has no belt complaint', async () => {
  const { env } = await setup();
  const h = await health(env, schedule, NOW);
  assert.doesNotMatch(JSON.stringify(h), /006_belts/);
});

// ---------- kids' coloured stripes: the IBJJF monthly system (§15.12) ----------

test('the eleven degrees: four white, then red takes the place of white, then yellow takes the place of red', () => {
  assert.equal(KIDS_DEGREES, 11);
  const W = 'white'; const R = 'red'; const Y = 'yellow';
  assert.deepEqual([0, 1, 2, 3, 4].map(degreeStripes), [[], [W], [W, W], [W, W, W], [W, W, W, W]]);
  assert.deepEqual([5, 6, 7, 8].map(degreeStripes), [[R, W, W, W], [R, R, W, W], [R, R, R, W], [R, R, R, R]]);
  assert.deepEqual([9, 10, 11].map(degreeStripes), [[Y, R, R, R], [Y, Y, R, R], [Y, Y, Y, R]]);
  for (let d = 0; d <= 11; d += 1) assert.ok(degreeStripes(d).length <= 4, 'never more than four on the belt');
  // Past eleven the belt cannot show more; it stays on the eleventh.
  assert.deepEqual(degreeStripes(14), degreeStripes(11));
  assert.deepEqual(degreeStripes(-2), []);
  assert.deepEqual([0, 3, 6, 8, 11].map(degreeText), ['', '3 white', '2 red, 2 white', '4 red', '3 yellow, 1 red']);
});

test('the monthly system is on unless KIDS_STRIPES says plain', () => {
  assert.equal(kidsStripesMonthly({}), true);
  assert.equal(kidsStripesMonthly({ KIDS_STRIPES: 'ibjjf-monthly' }), true);
  for (const v of ['plain', 'PLAIN', 'off', '0', 'false']) assert.equal(kidsStripesMonthly({ KIDS_STRIPES: v }), false, v);
});

test('rank: a kid carries colours and what comes next; an adult, and a kid under plain stripes, do not', () => {
  const cfg = beltConfig({});
  const six = rankFrom([{ kind: 'belt', belt: 'grey', stripes: 4 }, { kind: 'stripe' }, { kind: 'stripe' }], ['kids-6-9'], cfg);
  assert.deepEqual(six, kidRank('grey', 6, true));
  assert.equal(six.coloursText, '2 red, 2 white');
  assert.equal(six.nextLabel, 'Grey-black belt');
  // The last kids belt has nothing after it.
  const top = rankFrom([{ kind: 'belt', belt: 'green-black', stripes: 11 }], ['kids-10-14'], cfg);
  assert.deepEqual([top.full, top.nextBelt, top.nextLabel], [true, null, null]);
  // Adults: plain stripes, exactly as before.
  assert.deepEqual(rankFrom([{ kind: 'belt', belt: 'blue', stripes: 3 }], ['adult'], cfg), { belt: 'blue', label: 'Blue belt', stripes: 3, recorded: true });
  // A teen in both programs who holds an adult belt is on the adult system.
  assert.equal(rankFrom([{ kind: 'belt', belt: 'blue', stripes: 1 }], ['kids-10-14', 'adult'], cfg).colours, undefined);
  // Switched to plain, a kid is as before too.
  assert.deepEqual(rankFrom([{ kind: 'stripe' }], ['kids-6-9'], beltConfig({ KIDS_STRIPES: 'plain' })), { belt: 'white', label: 'White belt', stripes: 1, recorded: false });
});

test('the member screen offers a kid none to eleven stripes, named by colour; an adult gets no such list', async () => {
  const { member } = await setup();
  const jack = await member('c_jack');
  assert.equal(jack.rank.maxStripes, 11);
  assert.equal(jack.rank.stripeOptions.length, 12);
  assert.deepEqual(jack.rank.stripeOptions[0], { value: 0, label: 'No stripes' });
  assert.deepEqual(jack.rank.stripeOptions[1], { value: 1, label: '1 stripe (1 white)' });
  assert.deepEqual(jack.rank.stripeOptions[6], { value: 6, label: '6 stripes (2 red, 2 white)' });
  assert.deepEqual(jack.rank.stripeOptions[11], { value: 11, label: '11 stripes (3 yellow, 1 red)' });
  const dan = await member('c_dan');
  assert.equal(dan.rank.stripeOptions, null);
});

test('the twelfth is the belt: a kid on eleven stripes cannot be given another, and is told what comes next', async () => {
  const { promote, member, DB } = await setup();
  assert.equal((await promote('c_jack', { kind: 'belt', belt: 'grey', stripes: 10, starting: true })).status, 200);
  assert.equal((await promote('c_jack', { kind: 'stripe' })).status, 200);
  let jack = await member('c_jack');
  assert.deepEqual([jack.rank.rank.stripes, jack.rank.rank.full, jack.rank.rank.coloursText], [11, true, '3 yellow, 1 red']);

  const twelfth = await promote('c_jack', { kind: 'stripe' });
  assert.equal(twelfth.status, 409);
  assert.match((await twelfth.json()).error, /already on 11 stripes: the next step is the Grey-black belt/);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM promotions WHERE kind = 'stripe'").get().n, 1, 'nothing was written');

  // The belt is recorded as a belt, and the stripes start again.
  assert.equal((await promote('c_jack', { kind: 'belt', belt: 'grey-black' })).status, 200);
  jack = await member('c_jack');
  assert.deepEqual([jack.rank.rank.belt, jack.rank.rank.stripes, jack.rank.rank.full], ['grey-black', 0, false]);
  assert.equal((await promote('c_jack', { kind: 'stripe' })).status, 200);
});

test('a kids belt takes at most eleven stripes; an adult belt, and plain stripes, keep the old limit', async () => {
  const { promote } = await setup();
  const over = await promote('c_jack', { kind: 'belt', belt: 'grey', stripes: 12 });
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /from 0 to 11/);
  assert.equal((await promote('c_jack', { kind: 'belt', belt: 'grey', stripes: 11 })).status, 200);
  assert.equal((await promote('c_dan', { kind: 'belt', belt: 'black', stripes: 6 })).status, 200, 'black belt degrees go past four');
  const plain = await setup({ extraEnv: { KIDS_STRIPES: 'plain' } });
  assert.equal((await plain.promote('c_jack', { kind: 'belt', belt: 'grey', stripes: 12 })).status, 200);
  for (let i = 0; i < 2; i += 1) assert.equal((await plain.promote('c_jack', { kind: 'stripe' })).status, 200, 'no ceiling on plain stripes');
});

test('before migration 006 a stripe still records for anyone, however many they have', async () => {
  const { promote } = await setup({ noBelt: true });
  for (let i = 0; i < 13; i += 1) assert.equal((await promote('c_jack', { kind: 'stripe' })).status, 200);
});
