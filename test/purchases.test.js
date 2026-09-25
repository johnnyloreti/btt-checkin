// §15.3 step 4: a drink on the tab from the kiosk. Fixtures only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordPurchase, purchasesBetween, voidPurchase, memberTab, hasNoCardFlag, clearNoCardFlag } from '../src/purchases.js';
import { createSetupToken, completeSetup, verifyPin, LOCK_AFTER } from '../src/pin.js';
import { tabConfig, loadTabItems } from '../src/tab.js';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const ITEMS = loadTabItems(readRepoFile('tab-items.json'));
const PEPPER = 'a-long-pepper-for-tests';
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-24T22:20:00Z'); // Thu 6:20 PM ET, Adult BJJ at 6:15
const at = (ms) => new Date(NOW.getTime() + ms);
const ON = { TAB_ITEMS: 'water,hydration', TAB_PROGRAMS: 'adult', PIN_PEPPER: PEPPER };

async function givePin(env, contactId, pin = '1234') {
  const t = await createSetupToken(env, contactId, 'staff', NOW);
  assert.equal((await completeSetup(env, t.token, pin, NOW)).ok, true);
}

test('recordPurchase copies price and ids at the moment of purchase, and refuses an unknown item', async () => {
  const env = { ...ON, DB: memoryD1() };
  const cfg = tabConfig(env, ITEMS);
  const r = await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'Water', method: 'kiosk', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.label, 'Water');
  assert.equal(r.amountCents, 100);
  assert.equal(r.message, 'Added to your tab. Water, $1.');
  const row = env.DB.raw.prepare('SELECT * FROM purchases').get();
  assert.equal(row.id, r.purchaseId);
  assert.equal(row.item_key, 'water');
  assert.equal(row.product_id, ITEMS.water.product_id);
  assert.equal(row.price_id, ITEMS.water.price_id);
  assert.equal(row.unit_amount_cents, 100);
  assert.equal(row.qty, 1);
  assert.equal(row.status, 'open');
  assert.equal(row.method, 'kiosk');
  assert.equal(row.purchased_at, NOW.toISOString());
  assert.deepEqual(await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'soda', method: 'kiosk', now: NOW }), { ok: false, reason: 'unknown_item' });
  const h = await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'hydration', method: 'staff', now: NOW });
  assert.equal(h.message, 'Added to your tab. Hydration, $3.');
});

test('purchasesBetween, voidPurchase and memberTab', async () => {
  const env = { ...ON, MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', DB: memoryD1() };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: at(-3600_000) });
  const cfg = tabConfig(env, ITEMS);
  const a = await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'water', method: 'kiosk', now: NOW });
  const b = await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'hydration', method: 'kiosk', now: at(60_000) });
  await recordPurchase(env, cfg, { buyerId: 'c_maria', payerId: 'c_maria', itemKey: 'water', method: 'staff', now: at(-86_400_000) });

  const today = await purchasesBetween(env, cfg, NOW.toISOString(), at(3600_000).toISOString());
  assert.deepEqual(today.map((r) => [r.first, r.label, r.amountCents, r.status]), [['Dan', 'Hydration', 300, 'open'], ['Dan', 'Water', 100, 'open']]);
  assert.equal(today[0].purchaseId, b.purchaseId);

  assert.deepEqual(await voidPurchase(env, a.purchaseId), { ok: true, purchaseId: a.purchaseId, changed: 1 });
  assert.deepEqual(await voidPurchase(env, a.purchaseId), { ok: true, purchaseId: a.purchaseId, changed: 0 }, 'already voided');
  await assert.rejects(() => voidPurchase(env, 'x'), /positive integer/);
  env.DB.raw.prepare("UPDATE purchases SET status = 'invoiced' WHERE id = ?").run(b.purchaseId);
  assert.equal((await voidPurchase(env, b.purchaseId)).changed, 0, 'an invoiced line is money already');
  env.DB.raw.prepare("UPDATE purchases SET status = 'open' WHERE id = ?").run(b.purchaseId);

  const tab = await memberTab(env, cfg, 'c_dan');
  assert.deepEqual(tab.open.map((r) => r.label), ['Hydration']);
  assert.equal(tab.openCents, 300);
  assert.deepEqual(tab.recent.map((r) => [r.label, r.status]), [['Hydration', 'open'], ['Water', 'voided']]);
  assert.equal(tab.noCard, false);

  // A label survives the item leaving the config.
  const smaller = tabConfig({ ...env, TAB_ITEMS: 'water' }, ITEMS);
  assert.deepEqual((await memberTab(env, smaller, 'c_dan')).recent.map((r) => r.label), ['hydration', 'Water']);
});

test('the no-card flag', async () => {
  const env = { DB: memoryD1() };
  assert.equal(await hasNoCardFlag(env, 'c_dan'), false);
  env.DB.raw.prepare("INSERT INTO tab_flags VALUES ('c_dan', '2026-09-20T00:00:00Z')").run();
  assert.equal(await hasNoCardFlag(env, 'c_dan'), true);
  assert.deepEqual(await clearNoCardFlag(env, 'c_dan'), { ok: true, cleared: true });
  assert.deepEqual(await clearNoCardFlag(env, 'c_dan'), { ok: true, cleared: false });
  assert.equal(await hasNoCardFlag(env, 'c_dan'), false);
});

// ---------- routes ----------

async function setup({ tabOn = true, noTab = false } = {}) {
  resetFallback();
  const DB = memoryD1({ noTab });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York',
    PIN_PEPPER: PEPPER, DB, ...(tabOn ? { TAB_ITEMS: 'water,hydration', TAB_PROGRAMS: 'adult' } : {}),
  };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: at(-3600_000) });
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), pinLink: async () => ({ ok: true }), now: () => NOW }, { tabItems: ITEMS });
  const call = (path, { method = 'GET', body, headers = {} } = {}) =>
    app.fetch(new Request(`https://kiosk.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const checkin = async (contact, cls = { className: 'Adult BJJ', classStartLocal: '2026-09-24T18:15' }) =>
    (await call('/api/checkin', { method: 'POST', body: { contactId: await opaqueId(contact, SALT), ...cls } })).json();
  return { env, call, checkin, id: (c) => opaqueId(c, SALT) };
}

test('the check-in response carries the drink row for an adult, and nothing for a kid, a teen in both, or a staff add', async () => {
  const { env, call, checkin, id } = await setup();
  const before = await checkin('c_dan');
  assert.deepEqual(before.tab, { items: [{ key: 'water', label: 'Water', amountCents: 100, price: '$1' }, { key: 'hydration', label: 'Hydration', amountCents: 300, price: '$3' }], hasPin: false, locked: false });
  await givePin(env, 'c_dan');
  const after = await checkin('c_dan');
  assert.equal(after.duplicate, true, 'a duplicate check-in still carries the row');
  assert.equal(after.tab.hasPin, true);

  const kid = await checkin('c_jack', { className: 'Kids 6-9', classStartLocal: '2026-09-24T16:30' });
  assert.equal(kid.ok, true);
  assert.equal('tab' in kid, false);
  const teen = await checkin('c_leo', { className: 'Kids 10-14', classStartLocal: '2026-09-24T17:15' });
  assert.equal('tab' in teen, false, 'kids-10-14 plus adult waits for Phase 1b');

  const staff = await (await call('/api/staff/add', { method: 'POST', headers: { 'x-staff-pin': '1234' }, body: { contactId: await id('c_maria'), className: 'Adult BJJ', classStartLocal: '2026-09-24T18:15' } })).json();
  assert.equal('tab' in staff, false, 'the drink row is a kiosk thing');
});

test('the no-card flag hides the row, and the row is gone when the tab is off or its migration is pending', async () => {
  const flagged = await setup();
  flagged.env.DB.raw.prepare("INSERT INTO tab_flags VALUES ('c_dan', '2026-09-20T00:00:00Z')").run();
  assert.equal('tab' in (await flagged.checkin('c_dan')), false);
  for (const opts of [{ tabOn: false }, { noTab: true }]) {
    const { checkin } = await setup(opts);
    const r = await checkin('c_dan');
    assert.equal(r.ok, true, JSON.stringify(opts));
    assert.equal('tab' in r, false, JSON.stringify(opts));
  }
});

test('purchase: right PIN records the drink; wrong, locked, no PIN, kid, unknown item and flag are each refused by status', async () => {
  const { env, call, id } = await setup();
  const dan = await id('c_dan');
  const buy = (body) => call('/api/tab/purchase', { method: 'POST', body: { contactId: dan, item: 'water', pin: '1234', ...body } });

  const noPin = await buy({});
  assert.equal(noPin.status, 409);
  assert.equal((await noPin.json()).reason, 'no_pin');

  await givePin(env, 'c_dan', '1234');
  const ok = await buy({});
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.message, 'Added to your tab. Water, $1.');
  const row = env.DB.raw.prepare('SELECT * FROM purchases').get();
  assert.equal(row.buyer_contact_id, 'c_dan');
  assert.equal(row.payer_contact_id, 'c_dan');
  assert.equal(row.method, 'kiosk');

  const wrong = await buy({ pin: '0000' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).reason, 'wrong');
  assert.equal((await buy({ pin: '12' })).status, 400);
  assert.equal((await buy({ item: 'soda' })).status, 400);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 1, 'nothing else was recorded');

  for (let i = 0; i < LOCK_AFTER; i += 1) await verifyPin(env, 'c_dan', '0000', at(i * 1000));
  const locked = await buy({});
  assert.equal(locked.status, 423);
  const lb = await locked.json();
  assert.equal(lb.reason, 'locked');
  assert.ok(lb.lockedUntil);

  const kid = await call('/api/tab/purchase', { method: 'POST', body: { contactId: await id('c_jack'), item: 'water', pin: '1234' } });
  assert.equal(kid.status, 403);
  assert.equal((await call('/api/tab/purchase', { method: 'POST', body: { contactId: 'zzz', item: 'water', pin: '1234' } })).status, 404);

  env.DB.raw.prepare("INSERT INTO tab_flags VALUES ('c_dan', '2026-09-20T00:00:00Z')").run();
  env.DB.raw.prepare('UPDATE purchase_pins SET locked_until = NULL, failed_count = 0').run();
  assert.equal((await buy({})).status, 403, 'flagged: nothing to charge, so no more drinks until staff clear it');
});

test('purchase is 404 when the tab is off or its migration is pending', async () => {
  for (const opts of [{ tabOn: false }, { noTab: true }]) {
    const { call, id } = await setup(opts);
    assert.equal((await call('/api/tab/purchase', { method: 'POST', body: { contactId: await id('c_dan'), item: 'water', pin: '1234' } })).status, 404);
  }
});
