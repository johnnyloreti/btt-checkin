// §15.3 step 2: items file, config, eligibility, schema guard, /health.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTabItems, validateTabItems, tabConfig, canBuy, formatCents } from '../src/tab.js';
import { hasTabTables, resetSchemaCaps, TAB_TABLES } from '../src/schema-caps.js';
import { health } from '../src/app.js';
import { loadSchedule } from '../src/schedule.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const ITEMS = loadTabItems(readRepoFile('tab-items.json'));
const ON = { TAB_ITEMS: 'water,hydration', TAB_PROGRAMS: 'adult', PIN_PEPPER: 'a-long-pepper-for-tests' };

test('tab-items.json in the repo is valid and carries the two Phase 1 items', () => {
  assert.deepEqual(Object.keys(ITEMS), ['water', 'hydration']);
  assert.equal(ITEMS.water.amount_cents, 100);
  assert.equal(ITEMS.hydration.amount_cents, 300);
  assert.equal(ITEMS.hydration.label, 'Hydration');
});

test('loadTabItems tolerates a BOM and CRLF, and fails loudly on bad JSON', () => {
  const text = '﻿{\r\n  "water": { "label": "Water", "product_id": "6ab637c780e11d5e52e6e16a", "price_id": "6ab637c8a45571af67f0ed40", "amount_cents": 100 }\r\n}\r\n';
  assert.equal(loadTabItems(text).water.label, 'Water');
  assert.throws(() => loadTabItems('{ nope'), /invalid JSON/);
  assert.throws(() => loadTabItems(42), /expected text/);
});

test('validateTabItems rejects bad keys, missing labels, non-GHL ids and bad amounts', () => {
  const good = { label: 'Water', product_id: '6ab637c780e11d5e52e6e16a', price_id: '6ab637c8a45571af67f0ed40', amount_cents: 100 };
  assert.throws(() => validateTabItems([]), /expected an object/);
  assert.throws(() => validateTabItems({ 'Water Bottle': good }), /bad item key/);
  assert.throws(() => validateTabItems({ water: { ...good, label: ' ' } }), /needs a label/);
  assert.throws(() => validateTabItems({ water: { ...good, product_id: 'abc' } }), /product_id does not look like a GHL id/);
  assert.throws(() => validateTabItems({ water: { ...good, price_id: '' } }), /price_id/);
  for (const bad of [0, -1, 1.5, '100', null]) assert.throws(() => validateTabItems({ water: { ...good, amount_cents: bad } }), /amount_cents/, String(bad));
  assert.equal(validateTabItems({ water: good }).water, good);
});

test('tabConfig: off when TAB_ITEMS is empty, on with the listed items in order', () => {
  const off = tabConfig({}, ITEMS);
  assert.equal(off.enabled, false);
  assert.equal(off.error, null);
  assert.deepEqual(off.items, []);

  const on = tabConfig(ON, ITEMS);
  assert.equal(on.enabled, true);
  assert.deepEqual(on.items.map((i) => [i.key, i.label, i.amountCents]), [['water', 'Water', 100], ['hydration', 'Hydration', 300]]);
  assert.equal(on.items[0].productId, ITEMS.water.product_id);
  assert.equal(on.items[0].priceId, ITEMS.water.price_id);
  assert.deepEqual(on.programs, ['adult']);
  assert.equal(on.minCents, 500);
  assert.equal(on.maxRollDays, 28);

  const one = tabConfig({ ...ON, TAB_ITEMS: ' Hydration ' }, ITEMS);
  assert.deepEqual(one.items.map((i) => i.key), ['hydration']);
});

test('tabConfig: a key not in tab-items.json, or no programs, is a misconfiguration, not a crash', () => {
  const unknown = tabConfig({ ...ON, TAB_ITEMS: 'water,soda' }, ITEMS);
  assert.equal(unknown.enabled, false);
  assert.match(unknown.error, /soda/);
  const noProg = tabConfig({ TAB_ITEMS: 'water', TAB_PROGRAMS: '' }, ITEMS);
  assert.equal(noProg.enabled, false);
  assert.match(noProg.error, /TAB_PROGRAMS/);
});

test('tabConfig: minimum, roll days and origin come from env with fallbacks', () => {
  const c = tabConfig({ ...ON, TAB_MIN_CENTS: '750', TAB_MAX_ROLL_DAYS: '14', PUBLIC_ORIGIN: 'https://checkin.bttbridgewater.com/' }, ITEMS);
  assert.equal(c.minCents, 750);
  assert.equal(c.maxRollDays, 14);
  assert.equal(c.publicOrigin, 'https://checkin.bttbridgewater.com');
  const bad = tabConfig({ ...ON, TAB_MIN_CENTS: 'five', TAB_MAX_ROLL_DAYS: '-2' }, ITEMS);
  assert.equal(bad.minCents, 500);
  assert.equal(bad.maxRollDays, 28);
  assert.equal(bad.publicOrigin, '');
});

test('canBuy: every program in TAB_PROGRAMS, none outside it, nobody with the no-card flag', () => {
  const cfg = tabConfig(ON, ITEMS);
  assert.equal(canBuy(['adult'], cfg), true);
  assert.equal(canBuy(['kids-6-9'], cfg), false);
  assert.equal(canBuy(['kids-10-14', 'adult'], cfg), false, 'the 14-year-old in the adult class waits for Phase 1b');
  assert.equal(canBuy([], cfg), false);
  assert.equal(canBuy(undefined, cfg), false);
  assert.equal(canBuy(['adult'], cfg, { noCard: true }), false);
  assert.equal(canBuy(['adult'], tabConfig({}, ITEMS)), false, 'feature off');
  assert.equal(canBuy(['adult'], tabConfig({ ...ON, TAB_ITEMS: 'soda' }, ITEMS)), false, 'misconfigured');
  const kidsToo = tabConfig({ ...ON, TAB_PROGRAMS: 'adult,kids-10-14' }, ITEMS);
  assert.equal(canBuy(['kids-10-14', 'adult'], kidsToo), true);
});

test('formatCents', () => {
  assert.equal(formatCents(100), '$1');
  assert.equal(formatCents(300), '$3');
  assert.equal(formatCents(250), '$2.50');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(0), '$0');
});

test('hasTabTables is all or nothing, cached per isolate, and reset with the others', async () => {
  const full = memoryD1();
  assert.equal(await hasTabTables({ DB: full }), true);
  const none = memoryD1({ noTab: true });
  assert.equal(await hasTabTables({ DB: none }), false);
  for (const t of TAB_TABLES) assert.equal(none.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?").get(t).n, 0, t);
  // Half-applied: one table dropped is not "current".
  const half = memoryD1();
  half.raw.exec('DROP TABLE tab_flags');
  resetSchemaCaps();
  assert.equal(await hasTabTables({ DB: half }), false);
  resetSchemaCaps();
  assert.equal(await hasTabTables({ DB: { prepare() { throw new Error('offline'); } } }), false);
  resetSchemaCaps();
});

test('/health: tab off with no tables is fine; tab on with no tables names migration 004', async () => {
  const off = await health({ DB: memoryD1({ noTab: true } ) }, schedule, new Date(), { tabItems: ITEMS });
  assert.equal(off.ok, true);
  assert.deepEqual(off.tab, { enabled: false, schema: false, error: null });

  const on = await health({ ...ON, DB: memoryD1({ noTab: true }) }, schedule, new Date(), { tabItems: ITEMS });
  assert.equal(on.ok, false);
  assert.equal(on.schemaCurrent, false);
  assert.match(on.error, /004_tab\.sql/);
  assert.deepEqual(on.tab, { enabled: true, schema: false, error: null });

  const ready = await health({ ...ON, DB: memoryD1() }, schedule, new Date(), { tabItems: ITEMS });
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.tab, { enabled: true, schema: true, error: null });
});

test('/health: the tab on without PIN_PEPPER is not ok', async () => {
  const h = await health({ TAB_ITEMS: 'water', TAB_PROGRAMS: 'adult', DB: memoryD1() }, schedule, new Date(), { tabItems: ITEMS });
  assert.equal(h.ok, false);
  assert.match(h.error, /PIN_PEPPER/);
});

test('/health: a misconfigured tab is reported and is not ok', async () => {
  const h = await health({ TAB_ITEMS: 'soda', TAB_PROGRAMS: 'adult', DB: memoryD1() }, schedule, new Date(), { tabItems: ITEMS });
  assert.equal(h.ok, false);
  assert.equal(h.tab.enabled, false);
  assert.match(h.tab.error, /soda/);
  assert.match(h.error, /soda/);
});

test('/health: stripes on with the promotions table missing names migration 003', async () => {
  const h = await health({ STRIPE_PROGRAMS: 'kids-6-9', DB: memoryD1({ noPromotions: true }) }, schedule);
  assert.equal(h.ok, false);
  assert.match(h.error, /003_promotions\.sql/);
  const off = await health({ STRIPE_PROGRAMS: '', DB: memoryD1({ noPromotions: true }) }, schedule);
  assert.equal(off.ok, true);
});
