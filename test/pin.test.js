// §15.3 step 3: the purchase PIN. Hashing, the setup link, lockouts, and
// the routes around them. Fixtures only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPin, constantTimeEqual, verifyPin, createSetupToken, readSetupToken, completeSetup, clearLockout, pinStatus, pinActivity,
  writePinLink, requirePepper, LOCK_AFTER, LOCK_MS, LOCK_WINDOW_MS, TOKEN_TTL_MS, LINK_MIN_GAP_MS,
} from '../src/pin.js';
import { requiredFieldKeys } from '../src/fields.js';
import { FIELD_KEYS } from '../src/rollup.js';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { loadSchedule } from '../src/schedule.js';
import { loadTabItems } from '../src/tab.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const ITEMS = loadTabItems(readRepoFile('tab-items.json'));
const PEPPER = 'a-long-pepper-for-tests';
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-25T15:00:00Z');
const at = (ms) => new Date(NOW.getTime() + ms);

const envFor = (DB, extra = {}) => ({ PIN_PEPPER: PEPPER, DB, ...extra });

test('hashPin is deterministic, depends on the pepper, salt, contact and pin, and needs a real pepper', async () => {
  const env = envFor(null);
  const a = await hashPin(env, 'c_x', 'salt1', '1234');
  assert.equal(a, await hashPin(env, 'c_x', 'salt1', '1234'));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, await hashPin(env, 'c_x', 'salt2', '1234'));
  assert.notEqual(a, await hashPin(env, 'c_y', 'salt1', '1234'));
  assert.notEqual(a, await hashPin(env, 'c_x', 'salt1', '1235'));
  assert.notEqual(a, await hashPin({ PIN_PEPPER: 'a-different-long-pepper' }, 'c_x', 'salt1', '1234'));
  for (const bad of [undefined, '', 'short']) assert.throws(() => requirePepper({ PIN_PEPPER: bad }), /PIN_PEPPER/);
});

test('constantTimeEqual', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'ab'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(null, undefined), true);
});

async function withPin(pin = '1234') {
  const env = envFor(memoryD1());
  const t = await createSetupToken(env, 'c_x', 'staff', NOW);
  assert.equal((await completeSetup(env, t.token, pin, NOW)).ok, true);
  return env;
}

test('setup: token is single use, expires at 30 minutes, and sets the PIN with a fresh salt', async () => {
  const env = envFor(memoryD1());
  assert.deepEqual(await pinStatus(env, 'c_x', NOW), { hasPin: false, locked: false, lockedUntil: null });
  const t = await createSetupToken(env, 'c_x', 'link', NOW);
  assert.equal(t.ok, true);
  assert.match(t.token, /^[0-9a-f]{64}$/);
  assert.equal(t.expiresAt, at(TOKEN_TTL_MS).toISOString());
  // Only the hash is stored.
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM pin_setup_tokens WHERE token_hash = ?').get(t.token).n, 0);
  assert.equal(env.DB.raw.prepare('SELECT via FROM pin_setup_tokens').get().via, 'link');

  assert.deepEqual(await readSetupToken(env, t.token, NOW), { ok: true, contactId: 'c_x', via: 'link' });
  assert.deepEqual(await readSetupToken(env, t.token, at(TOKEN_TTL_MS)), { ok: false, reason: 'expired' });
  assert.deepEqual(await readSetupToken(env, t.token, at(TOKEN_TTL_MS - 1000)), { ok: true, contactId: 'c_x', via: 'link' });
  assert.deepEqual(await readSetupToken(env, 'nope', NOW), { ok: false, reason: 'invalid' });
  assert.deepEqual(await readSetupToken(env, 'f'.repeat(64), NOW), { ok: false, reason: 'invalid' });

  assert.deepEqual(await completeSetup(env, t.token, '12345', NOW), { ok: false, reason: 'bad_format' });
  assert.deepEqual(await completeSetup(env, t.token, '1234', at(60_000)), { ok: true, contactId: 'c_x' });
  const row = env.DB.raw.prepare('SELECT * FROM purchase_pins').get();
  assert.equal(row.set_by, 'link');
  assert.equal(row.set_at, at(60_000).toISOString());
  assert.match(row.salt, /^[0-9a-f]{32}$/);
  assert.equal(row.pin_hash, await hashPin(env, 'c_x', row.salt, '1234'));
  assert.deepEqual(await readSetupToken(env, t.token, at(120_000)), { ok: false, reason: 'used' });
  assert.deepEqual(await completeSetup(env, t.token, '1234', at(120_000)), { ok: false, reason: 'used' });
  assert.deepEqual(await pinStatus(env, 'c_x', NOW), { hasPin: true, locked: false, lockedUntil: null });

  // Setting again (a second link) replaces hash and salt and clears any lock.
  env.DB.raw.prepare("UPDATE purchase_pins SET failed_count = 3, locked_until = '2099-01-01T00:00:00.000Z'").run();
  const t2 = await createSetupToken(env, 'c_x', 'staff', at(3600_000));
  assert.equal((await completeSetup(env, t2.token, '9999', at(3600_000))).ok, true);
  const row2 = env.DB.raw.prepare('SELECT * FROM purchase_pins').get();
  assert.notEqual(row2.salt, row.salt);
  assert.equal(row2.set_by, 'staff');
  assert.equal(row2.failed_count, 0);
  assert.equal(row2.locked_until, null);
  assert.equal((await verifyPin(env, 'c_x', '9999', at(3600_000))).ok, true);
  assert.equal((await verifyPin(env, 'c_x', '1234', at(3600_000))).ok, false);
});

test('one kiosk-requested link per member per 10 minutes; staff-opened setup has no gap', async () => {
  const env = envFor(memoryD1());
  assert.equal((await createSetupToken(env, 'c_x', 'link', NOW)).ok, true);
  const again = await createSetupToken(env, 'c_x', 'link', at(LINK_MIN_GAP_MS - 1000));
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'recent');
  assert.equal(again.retryAt, at(LINK_MIN_GAP_MS).toISOString());
  assert.equal((await createSetupToken(env, 'c_y', 'link', NOW)).ok, true, 'another member is not blocked');
  assert.equal((await createSetupToken(env, 'c_x', 'staff', NOW)).ok, true, 'staff at the desk is not blocked');
  assert.equal((await createSetupToken(env, 'c_x', 'link', at(LINK_MIN_GAP_MS))).ok, true, 'the gap has passed');
  await assert.rejects(() => createSetupToken(env, 'c_x', 'sms', NOW), /bad via/);
});

test('verifyPin: right, wrong, malformed, and no PIN at all', async () => {
  const env = await withPin('1234');
  assert.deepEqual(await verifyPin(env, 'c_x', '1234', NOW), { ok: true });
  assert.deepEqual(await verifyPin(env, 'c_x', '0000', NOW), { ok: false, reason: 'wrong' });
  assert.deepEqual(await verifyPin(env, 'c_x', '12', NOW), { ok: false, reason: 'bad_format' });
  assert.deepEqual(await verifyPin(env, 'c_x', 1234, NOW), { ok: true }, 'a number is fine, it reads as four digits');
  assert.deepEqual(await verifyPin(env, 'c_nobody', '1234', NOW), { ok: false, reason: 'no_pin' });
  // A malformed PIN is not counted as a failure.
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM pin_failures').get().n, 1);
});

test('lockout: the fifth wrong PIN in 15 minutes locks for 15 minutes; a right PIN resets the count', async () => {
  const env = await withPin('1234');
  for (let i = 0; i < LOCK_AFTER - 1; i += 1) {
    assert.deepEqual(await verifyPin(env, 'c_x', '0000', at(i * 1000)), { ok: false, reason: 'wrong' }, `wrong #${i + 1}`);
  }
  const fifth = await verifyPin(env, 'c_x', '0000', at(4000));
  assert.equal(fifth.reason, 'locked');
  assert.equal(fifth.lockedUntil, at(4000 + LOCK_MS).toISOString());
  // Locked: even the right PIN is refused, and nothing more is counted.
  const during = await verifyPin(env, 'c_x', '1234', at(5000));
  assert.equal(during.reason, 'locked');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM pin_failures').get().n, LOCK_AFTER);
  assert.equal((await pinStatus(env, 'c_x', at(5000))).locked, true);
  // Lock expires on the dot.
  assert.equal((await verifyPin(env, 'c_x', '1234', at(4000 + LOCK_MS - 1))).reason, 'locked');
  assert.deepEqual(await verifyPin(env, 'c_x', '1234', at(4000 + LOCK_MS)), { ok: true });
  assert.equal(env.DB.raw.prepare('SELECT failed_count FROM purchase_pins').get().failed_count, 0);

  // Four wrong, then a right one, then four wrong: never locks.
  for (let i = 0; i < 4; i += 1) await verifyPin(env, 'c_x', '0000', at(LOCK_MS + 10_000 + i * 1000));
  assert.deepEqual(await verifyPin(env, 'c_x', '1234', at(LOCK_MS + 20_000)), { ok: true });
  for (let i = 0; i < 4; i += 1) assert.equal((await verifyPin(env, 'c_x', '0000', at(LOCK_MS + 30_000 + i * 1000))).reason, 'wrong');
});

test('lockout window: wrong PINs spread over more than 15 minutes do not add up', async () => {
  const env = await withPin('1234');
  for (let i = 0; i < 4; i += 1) await verifyPin(env, 'c_x', '0000', at(i * 1000));
  // The fifth arrives after the window has closed: the count restarts at 1.
  const late = await verifyPin(env, 'c_x', '0000', at(LOCK_WINDOW_MS + 1000));
  assert.equal(late.reason, 'wrong');
  assert.equal(env.DB.raw.prepare('SELECT failed_count FROM purchase_pins').get().failed_count, 1);
});

test('clearLockout and pinActivity', async () => {
  const env = await withPin('1234');
  for (let i = 0; i < LOCK_AFTER; i += 1) await verifyPin(env, 'c_x', '0000', at(i * 1000));
  const a = await pinActivity(env, NOW.toISOString(), at(10_000));
  assert.equal(a.failed, 5);
  assert.deepEqual(a.locked.map((l) => l.contactId), ['c_x']);
  assert.deepEqual(await clearLockout(env, 'c_x'), { ok: true, cleared: true });
  assert.deepEqual(await clearLockout(env, 'c_nobody'), { ok: true, cleared: false });
  assert.deepEqual(await verifyPin(env, 'c_x', '1234', at(10_000)), { ok: true });
  const after = await pinActivity(env, NOW.toISOString(), at(10_000));
  assert.equal(after.failed, 5, 'the record of failures stays');
  assert.deepEqual(after.locked, []);
  assert.equal((await pinActivity(env, at(3000).toISOString(), at(10_000))).failed, 2, 'since is honoured');
});

test('writePinLink writes purchase_pin_link with the one allowed write, and reports a missing field', async () => {
  const puts = [];
  const deps = { getFieldIds: async () => new Map([['purchase_pin_link', 'f_pl']]), putContact: async (id, fields) => puts.push({ id, fields }) };
  assert.deepEqual(await writePinLink({}, deps, 'c_x', 'https://x/pin?t=abc', NOW), { ok: true });
  assert.deepEqual(puts, [{ id: 'c_x', fields: [{ id: 'f_pl', field_value: 'https://x/pin?t=abc' }] }]);
  const missing = await writePinLink({}, { ...deps, getFieldIds: async () => new Map() }, 'c_x', 'https://x', NOW);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /purchase_pin_link not found/);
  const failing = await writePinLink({}, { ...deps, putContact: async () => { throw new Error('GHL 401'); } }, 'c_x', 'https://x', NOW);
  assert.match(failing.reason, /401/);
});

test('purchase_pin_link is a required field once the tab is on', () => {
  assert.deepEqual(requiredFieldKeys({ TAB_ITEMS: 'water' }), [...FIELD_KEYS, 'purchase_pin_link']);
  assert.deepEqual(requiredFieldKeys({ TAB_ITEMS: '' }), FIELD_KEYS);
});

// ---------- routes ----------

async function setup({ tabOn = true, noTab = false, pinLink } = {}) {
  resetFallback();
  const DB = memoryD1({ noTab });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York',
    PIN_PEPPER: PEPPER, PUBLIC_ORIGIN: 'https://checkin.bttbridgewater.com', DB,
    ...(tabOn ? { TAB_ITEMS: 'water,hydration', TAB_PROGRAMS: 'adult' } : {}),
  };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: at(-3600_000) });
  const links = [];
  const app = createApp(schedule, {
    runRosterSync: async () => ({ outcome: 'ok' }),
    pinLink: pinLink || (async (e, contactId, link, now) => (links.push({ contactId, link, now }), { ok: true })),
    now: () => NOW,
  }, { tabItems: ITEMS });
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    app.fetch(new Request(`https://kiosk.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const staff = (path, opts = {}) => call(path, { ...opts, headers: { 'x-staff-pin': '1234', ...(opts.headers || {}) } });
  return { env, call, staff, links, id: (c) => opaqueId(c, SALT) };
}

test('pin-link: an adult gets a link written to GHL, a kid is refused, a second tap inside 10 minutes is not resent', async () => {
  const { call, links, id, env } = await setup();
  const res = await call('/api/tab/pin-link', { method: 'POST', body: { contactId: await id('c_dan') } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, sent: true });
  assert.equal(links.length, 1);
  assert.equal(links[0].contactId, 'c_dan');
  assert.match(links[0].link, /^https:\/\/checkin\.bttbridgewater\.com\/pin\?t=[0-9a-f]{64}$/, 'PUBLIC_ORIGIN, not the request host');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM pin_setup_tokens WHERE payer_contact_id = 'c_dan'").get().n, 1);

  const again = await call('/api/tab/pin-link', { method: 'POST', body: { contactId: await id('c_dan') } });
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.sent, false);
  assert.equal(body.reason, 'recent');
  assert.equal(links.length, 1, 'no second write, no second text');

  const kid = await call('/api/tab/pin-link', { method: 'POST', body: { contactId: await id('c_jack') } });
  assert.equal(kid.status, 403);
  const teen = await call('/api/tab/pin-link', { method: 'POST', body: { contactId: await id('c_leo') } });
  assert.equal(teen.status, 403, 'kids-10-14 plus adult waits for Phase 1b');
  assert.equal((await call('/api/tab/pin-link', { method: 'POST', body: { contactId: 'nope' } })).status, 404);
  assert.equal((await call('/api/tab/pin-link', { method: 'POST', body: 'x' })).status, 400);
});

test('pin-link: when the GHL write fails the kiosk hears it, and sync_log records it', async () => {
  const { call, id, env } = await setup({ pinLink: async () => ({ ok: false, reason: 'custom field purchase_pin_link not found in GHL' }) });
  const res = await call('/api/tab/pin-link', { method: 'POST', body: { contactId: await id('c_dan') } });
  assert.equal(res.status, 502);
  const rows = env.DB.raw.prepare("SELECT outcome, detail FROM sync_log WHERE job = 'pin_link'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'failed');
  assert.match(rows[0].detail, /purchase_pin_link not found/);
});

test('the setup page flow: read the token, set the PIN, the token is spent', async () => {
  const { call, links, id, env } = await setup();
  await call('/api/tab/pin-link', { method: 'POST', body: { contactId: await id('c_dan') } });
  const token = new URL(links[0].link).searchParams.get('t');

  const page = await call('/pin?t=' + token);
  assert.equal(page.status, 404, 'no ASSETS binding in tests; the route is public and maps to pin.html');

  const read = await (await call(`/api/tab/pin-token?t=${token}`)).json();
  assert.deepEqual(read, { ok: true, first: 'Dan' });
  assert.deepEqual(await (await call('/api/tab/pin-token?t=zzz')).json(), { ok: false, reason: 'invalid' });

  const bad = await call('/api/tab/pin-set', { method: 'POST', body: { token, pin: '12' } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).reason, 'bad_format');
  const ok = await call('/api/tab/pin-set', { method: 'POST', body: { token, pin: '4321' } });
  assert.equal(ok.status, 200);
  assert.equal(env.DB.raw.prepare("SELECT set_by FROM purchase_pins WHERE payer_contact_id = 'c_dan'").get().set_by, 'link');
  const spent = await call('/api/tab/pin-set', { method: 'POST', body: { token, pin: '4321' } });
  assert.equal(spent.status, 400);
  assert.equal((await spent.json()).reason, 'used');
  assert.deepEqual(await (await call(`/api/tab/pin-token?t=${token}`)).json(), { ok: false, reason: 'used' });
});

test('staff: open setup for a member at the desk, clear a lockout, read activity', async () => {
  const { call, staff, id, env } = await setup();
  assert.equal((await call('/api/staff/tab/pin-setup', { method: 'POST', body: { contactId: await id('c_dan') } })).status, 401);
  const open = await staff('/api/staff/tab/pin-setup', { method: 'POST', body: { contactId: await id('c_dan') } });
  assert.equal(open.status, 200);
  const { url } = await open.json();
  assert.match(url, /^https:\/\/checkin\.bttbridgewater\.com\/pin\?t=[0-9a-f]{64}$/);
  const token = new URL(url).searchParams.get('t');
  assert.equal((await call('/api/tab/pin-set', { method: 'POST', body: { token, pin: '2468' } })).status, 200);
  assert.equal(env.DB.raw.prepare("SELECT set_by FROM purchase_pins WHERE payer_contact_id = 'c_dan'").get().set_by, 'staff');
  // Staff can open it again straight away: no 10-minute gap at the desk.
  assert.equal((await staff('/api/staff/tab/pin-setup', { method: 'POST', body: { contactId: await id('c_dan') } })).status, 200);

  for (let i = 0; i < LOCK_AFTER; i += 1) await verifyPin(env, 'c_dan', '0000', at(i * 1000));
  const activity = await (await staff('/api/staff/tab/activity')).json();
  assert.equal(activity.date, '2026-09-25');
  assert.equal(activity.failedToday, 5);
  assert.equal(activity.locked.length, 1);
  assert.equal(activity.locked[0].first, 'Dan');
  assert.equal(activity.locked[0].id, await id('c_dan'));
  assert.ok(!('contactId' in activity.locked[0]), 'never the GHL id');

  const cleared = await staff('/api/staff/tab/clear-lockout', { method: 'POST', body: { contactId: await id('c_dan') } });
  assert.deepEqual(await cleared.json(), { ok: true, cleared: true });
  assert.deepEqual((await (await staff('/api/staff/tab/activity')).json()).locked, []);
});

test('with the tab off, or its migration pending, every tab route is 404 and check-in is untouched', async () => {
  for (const opts of [{ tabOn: false }, { noTab: true }]) {
    const { call, staff, id } = await setup(opts);
    assert.equal((await call('/api/tab/pin-link', { method: 'POST', body: { contactId: await id('c_dan') } })).status, 404, JSON.stringify(opts));
    assert.equal((await call('/api/tab/pin-token?t=x')).status, 404);
    assert.equal((await staff('/api/staff/tab/activity')).status, 404);
    const checkin = await call('/api/checkin', { method: 'POST', body: { contactId: await id('c_dan'), className: 'Adult BJJ', classStartLocal: '2026-09-24T18:15' } });
    assert.equal(checkin.status, 200);
  }
});

test('tab routes are rate limited like the other public routes', async () => {
  const { call } = await setup();
  let last;
  for (let i = 0; i < 61; i += 1) last = await call('/api/tab/pin-token?t=x');
  assert.equal(last.status, 429);
});
