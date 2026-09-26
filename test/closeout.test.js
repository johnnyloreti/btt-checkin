// §15.3 step 6: the close-out, against fixtures shaped like the calls
// verified on 2026-09-25. No network. Every scenario in §9 item 11.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeDecision, reviewPayers, findCard, payerCardStatus, startCloseout, runPayer, refreshPayer, markPaidAtPos,
  latestCloseout, closeoutPayers, invoiceName, executeAtFor, scheduleIsActive, BUSINESS_NAME, tabTick,
} from '../src/closeout.js';
import { recordPurchase } from '../src/purchases.js';
import { tabConfig, loadTabItems } from '../src/tab.js';
import { syncRoster } from '../src/roster.js';
import { loadSchedule } from '../src/schedule.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const ITEMS = loadTabItems(readRepoFile('tab-items.json'));
const NOW = new Date('2026-09-26T14:00:00Z'); // Sat 10:00 ET
const at = (ms) => new Date(NOW.getTime() + ms);
const DAY = 86_400_000;
const ENV = { TAB_ITEMS: 'water,hydration', TAB_PROGRAMS: 'adult', TAB_MIN_CENTS: '500', TAB_MAX_ROLL_DAYS: '28', MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', GHL_LOCATION_ID: 'LOC' };

async function seeded() {
  const env = { ...ENV, DB: memoryD1() };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: at(-3600_000) });
  const cfg = tabConfig(env, ITEMS);
  return { env, cfg };
}
async function buy(env, cfg, who, item, when) {
  return recordPurchase(env, cfg, { buyerId: who, payerId: who, itemKey: item, method: 'kiosk', now: when });
}

// A transaction as the list returns it, snapshot included unless told not to.
const tx = (id, { source = 'funnel', pm = 'pm_1', cus = 'cus_1', brand = 'visa', last4 = '4242', live = true, status = 'succeeded', at: when = '2026-09-01T00:00:00Z', snapshot = true } = {}) => ({
  _id: id, status, liveMode: live, entitySourceType: source, createdAt: when,
  ...(snapshot ? { chargeSnapshot: { customer: cus, payment_method: { id: pm, card: { brand, last4 } } } } : {}),
});

/** A fake of the GHL calls, recording everything, with a scripted GHL. */
function fakeGhl({ contacts = {}, transactions = {}, schedules = [], invoices = {}, scheduleState = {} } = {}) {
  const calls = [];
  const rec = (name, ...args) => calls.push({ name, args });
  let nextId = 100;
  const ghl = {
    getContact: async (env, id) => { rec('getContact', id); return contacts[id] || { id, name: '', email: '', phone: '' }; },
    listTransactions: async (env, id) => { rec('listTransactions', id); return (transactions[id] || []).map((t) => (t.chargeSnapshot ? { ...t, chargeSnapshot: t.listCarriesSnapshot ? t.chargeSnapshot : undefined } : t)); },
    getTransaction: async (env, id) => { rec('getTransaction', id); for (const list of Object.values(transactions)) { const t = list.find((x) => x._id === id); if (t) return t; } throw new Error(`no tx ${id}`); },
    findSchedules: async (env, search) => { rec('findSchedules', search); return schedules.filter((s) => s.name.includes(search)); },
    getSchedule: async (env, id) => { rec('getSchedule', id); return scheduleState[id] === undefined ? { _id: id, status: 'draft' } : scheduleState[id]; },
    createSchedule: async (env, body) => { rec('createSchedule', body); const id = `sch_${nextId += 1}`; schedules.push({ _id: id, name: body.name }); return { id, raw: { _id: id } }; },
    activateSchedule: async (env, id, auto) => { rec('activateSchedule', id, auto); scheduleState[id] = { _id: id, status: 'active', autoPayment: auto }; return { ok: true }; },
    listInvoices: async (env, id) => { rec('listInvoices', id); return invoices[id] || []; },
  };
  const count = (name) => calls.filter((c) => c.name === name).length;
  return { ghl, calls, count };
}

const DAN = { id: 'c_dan', name: 'Dan Kim', email: 'dan@example.test', phone: '+15555550100' };

test('chargeDecision: $5 or 28 days, whichever comes first', () => {
  const cfg = tabConfig(ENV, ITEMS);
  const line = (cents, daysAgo) => ({ amountCents: cents, purchasedAt: at(-daysAgo * DAY).toISOString() });
  assert.equal(chargeDecision([line(100, 1), line(300, 2)], cfg, NOW).charge, false, '$4 and young: rolls');
  assert.equal(chargeDecision([line(100, 1), line(300, 2), line(100, 3)], cfg, NOW).charge, true, 'hits $5');
  assert.equal(chargeDecision([line(100, 27)], cfg, NOW).charge, false, '27 days, $1: still rolls');
  assert.equal(chargeDecision([line(100, 28)], cfg, NOW).charge, true, '28 days old, $1: charged');
  const d = chargeDecision([line(100, 10), line(300, 2)], cfg, NOW);
  assert.equal(d.totalCents, 400);
  assert.equal(d.ageDays, 10);
});

test('reviewPayers groups open lines by payer with the decision, charge first', async () => {
  const { env, cfg } = await seeded();
  await buy(env, cfg, 'c_dan', 'water', at(-2 * DAY));
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  await buy(env, cfg, 'c_dan', 'water', at(-3600_000));
  await buy(env, cfg, 'c_maria', 'water', at(-DAY));
  await buy(env, cfg, 'c_lead', 'water', at(-30 * DAY));
  const voided = await buy(env, cfg, 'c_maria', 'hydration', at(-DAY));
  env.DB.raw.prepare("UPDATE purchases SET status = 'voided' WHERE id = ?").run(voided.purchaseId);

  const r = await reviewPayers(env, cfg, NOW);
  assert.deepEqual(r.map((p) => [p.first, p.total, p.charge]), [['Dan', '$5', true], ['Lead', '$1', true], ['María', '$1', false]]);
  assert.equal(r[0].lines.length, 3);
  assert.equal(r[1].ageDays, 30);
});

test('findCard: the verified lookup rule', async () => {
  const env = { GHL_LOCATION_ID: 'LOC' };
  // Most recent saved-source card wins; test mode and POS-only never count.
  let f = fakeGhl({ transactions: { c_x: [
    tx('t1', { source: 'funnel', pm: 'pm_old', at: '2026-07-01T00:00:00Z' }),
    tx('t2', { source: 'payment_link', pm: 'pm_new', last4: '6222', at: '2026-09-01T00:00:00Z' }),
    tx('t3', { source: 'funnel', pm: 'pm_test', live: false, at: '2026-09-20T00:00:00Z' }),
    tx('t4', { source: 'point_of_sale', pm: 'pm_desk', at: '2026-09-22T00:00:00Z' }),
    tx('t5', { source: 'invoice', pm: 'pm_new', status: 'failed', at: '2026-09-23T00:00:00Z' }),
  ] } });
  let card = await findCard(f.ghl, env, 'c_x');
  assert.equal(card.paymentMethodId, 'pm_new');
  assert.equal(card.customerId, 'cus_1');
  assert.equal(card.last4, '6222');
  assert.equal(card.source, 'payment_link');
  assert.equal(f.count('getTransaction'), 3, 'only live succeeded candidates are read');

  // A POS charge on a saved method is the most recent successful charge on that card.
  f = fakeGhl({ transactions: { c_x: [
    tx('t1', { source: 'funnel', pm: 'pm_a', at: '2026-07-01T00:00:00Z' }),
    tx('t2', { source: 'point_of_sale', pm: 'pm_a', at: '2026-09-22T00:00:00Z' }),
  ] } });
  card = await findCard(f.ghl, env, 'c_x');
  assert.equal(card.paymentMethodId, 'pm_a');
  assert.equal(card.source, 'point_of_sale');

  // POS only: nothing to charge.
  f = fakeGhl({ transactions: { c_x: [tx('t1', { source: 'point_of_sale', pm: 'pm_desk' })] } });
  assert.equal(await findCard(f.ghl, env, 'c_x'), null);
  // Test mode only: nothing.
  f = fakeGhl({ transactions: { c_x: [tx('t1', { live: false })] } });
  assert.equal(await findCard(f.ghl, env, 'c_x'), null);
  // No transactions at all.
  f = fakeGhl({});
  assert.equal(await findCard(f.ghl, env, 'c_nobody'), null);
  // A list that already carries the snapshot needs no second read.
  f = fakeGhl({ transactions: { c_x: [{ ...tx('t1'), listCarriesSnapshot: true }] } });
  card = await findCard(f.ghl, env, 'c_x');
  assert.equal(card.paymentMethodId, 'pm_1');
  assert.equal(f.count('getTransaction'), 0);
});

test('payerCardStatus for the review screen: card, no card, missing email or phone', async () => {
  const env = { GHL_LOCATION_ID: 'LOC' };
  const f = fakeGhl({
    contacts: { c_dan: DAN, c_nophone: { id: 'c_nophone', name: 'No Phone', email: 'x@y.test', phone: '' } },
    transactions: { c_dan: [tx('t1')] },
  });
  const ok = await payerCardStatus(f.ghl, env, 'c_dan');
  assert.equal(ok.ok, true);
  assert.equal(ok.card.last4, '4242');
  const none = await payerCardStatus(f.ghl, env, 'c_lead');
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'missing_contact');
  const nophone = await payerCardStatus(f.ghl, env, 'c_nophone');
  assert.equal(nophone.reason, 'missing_contact');
  assert.deepEqual(nophone.missing, ['phone']);
  f.ghl.getContact = async () => DAN;
  const nocard = await payerCardStatus(f.ghl, env, 'c_lead');
  assert.equal(nocard.reason, 'no_card');
});

test('executeAtFor has no milliseconds; invoiceName; scheduleIsActive reads what it can', async () => {
  assert.equal(executeAtFor(new Date('2026-09-26T14:00:00.123Z')), '2026-09-26T14:05:00Z');
  return invoiceName(7, 'c_dan').then((n) => { assert.match(n, /^BTT tab #7-[0-9a-f]{8}$/); assert.equal(n.includes('c_dan'), false); });
  assert.equal(scheduleIsActive({ status: 'active' }), true);
  assert.equal(scheduleIsActive({ autoPayment: { enable: true } }), true);
  assert.equal(scheduleIsActive({ status: 'draft' }), false);
  assert.equal(scheduleIsActive({ status: 'scheduled', autoPayment: { enable: false } }), false);
  assert.equal(scheduleIsActive({ foo: 1 }), null);
  assert.equal(scheduleIsActive(null), null);
});

test('startCloseout takes only payers who are due, and writes every row before any GHL call', async () => {
  const { env, cfg } = await seeded();
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  await buy(env, cfg, 'c_maria', 'water', at(-DAY));
  const r = await startCloseout(env, cfg, ['c_dan', 'c_maria', 'c_nobody'], NOW);
  assert.equal(r.ok, true);
  assert.equal(r.payers.length, 1, 'María is under $5 and rolls, whatever the request said');
  assert.equal(r.payers[0].payerId, 'c_dan');
  assert.equal(r.payers[0].state, 'pending');
  assert.equal(r.payers[0].amountCents, 600);
  assert.equal(r.payers[0].invoiceName, await invoiceName(r.closeoutId, 'c_dan'));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM purchases WHERE status = 'open'").get().n, 3, 'nothing marked yet');
  assert.deepEqual(await startCloseout(env, cfg, ['c_maria'], NOW), { ok: false, reason: 'nobody_due' });
  const latest = await latestCloseout(env);
  assert.equal(latest.closeoutId, r.closeoutId);
  assert.equal(latest.done, false);
});

async function dueDan() {
  const { env, cfg } = await seeded();
  await buy(env, cfg, 'c_dan', 'hydration', at(-2 * DAY));
  await buy(env, cfg, 'c_dan', 'water', at(-DAY));
  await buy(env, cfg, 'c_dan', 'water', at(-DAY));
  const start = await startCloseout(env, cfg, ['c_dan'], NOW);
  return { env, cfg, cp: start.payers[0] };
}

test('runPayer, the happy path: contact, card, create, activate, lines invoiced', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { source: 'payment_link', pm: 'pm_dan', cus: 'cus_dan', brand: 'visa', last4: '6222' })] } });
  const r = await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.row.state, 'autopay_on');
  assert.equal(r.row.scheduleId, 'sch_101');
  assert.deepEqual(r.row.card, { brand: 'visa', last4: '6222', source: 'payment_link' });
  assert.deepEqual(f.calls.map((c) => c.name), ['findSchedules', 'getContact', 'listTransactions', 'getTransaction', 'createSchedule', 'activateSchedule']);

  const create = f.calls.find((c) => c.name === 'createSchedule').args[0];
  assert.equal(create.name, cp.invoiceName);
  assert.deepEqual(create.contactDetails, { id: 'c_dan', name: 'Dan Kim', phoneNo: '+15555550100', email: 'dan@example.test' });
  assert.equal(create.schedule.executeAt, '2026-09-26T14:05:00Z');
  assert.equal(create.liveMode, true);
  assert.deepEqual(create.businessDetails, { name: BUSINESS_NAME });
  assert.equal(create.currency, 'USD');
  assert.deepEqual(create.discount, { type: 'percentage', value: 0 });
  assert.deepEqual(create.items, [
    { name: 'Hydration', currency: 'USD', amount: 3, qty: 1, productId: ITEMS.hydration.product_id, priceId: ITEMS.hydration.price_id, type: 'one_time' },
    { name: 'Water', currency: 'USD', amount: 1, qty: 2, productId: ITEMS.water.product_id, priceId: ITEMS.water.price_id, type: 'one_time' },
  ]);
  const activate = f.calls.find((c) => c.name === 'activateSchedule');
  assert.equal(activate.args[0], 'sch_101');
  assert.deepEqual(activate.args[1], { enable: true, type: 'saved_card', paymentMethodId: 'pm_dan', customerId: 'cus_dan', card: { brand: 'visa', last4: '6222' } });

  const rows = env.DB.raw.prepare("SELECT status, closeout_payer_id FROM purchases WHERE payer_contact_id = 'c_dan'").all();
  assert.deepEqual(rows.map((x) => [x.status, x.closeout_payer_id]), [['invoiced', cp.closeoutPayerId], ['invoiced', cp.closeoutPayerId], ['invoiced', cp.closeoutPayerId]]);
  assert.equal(JSON.parse(env.DB.raw.prepare('SELECT detail FROM closeout_payers').get().detail).chargeDay, '2026-09-26');

  // Running again does nothing: it is final for this request's purposes.
  const again = await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, at(60_000));
  assert.equal(again.row.state, 'autopay_on');
  assert.equal(f.count('createSchedule'), 1);
  assert.equal(f.count('activateSchedule'), 1);
});

test('a crash after schedule_created creates no second schedule: the resume reads it and activates once', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan', cus: 'cus_dan' })] } });
  // Simulate the crash: activateSchedule throws the first time.
  const realActivate = f.ghl.activateSchedule;
  f.ghl.activateSchedule = async () => { throw new Error('connection reset'); };
  await assert.rejects(() => runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW), /connection reset/);
  let row = env.DB.raw.prepare('SELECT state, invoice_schedule_id FROM closeout_payers').get();
  assert.equal(row.state, 'schedule_created');
  assert.equal(row.invoice_schedule_id, 'sch_101');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM purchases WHERE status = 'open'").get().n, 3, 'lines stay open until activation');

  f.ghl.activateSchedule = realActivate;
  const r = await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, at(60_000));
  assert.equal(r.row.state, 'autopay_on');
  assert.equal(f.count('createSchedule'), 1, 'no second schedule');
  assert.equal(f.count('getSchedule'), 1, 'read before re-activating');
  assert.equal(f.count('activateSchedule'), 1, 'the stub that threw was not the fake; one real activation');
});

test('a crash after the activation POST: the resume sees it active and does not re-activate', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan', cus: 'cus_dan' })] } });
  const realActivate = f.ghl.activateSchedule;
  f.ghl.activateSchedule = async (env2, id, auto) => { await realActivate(env2, id, auto); throw new Error('lost the response'); };
  await assert.rejects(() => runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW), /lost the response/);
  f.ghl.activateSchedule = realActivate;
  const r = await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, at(60_000));
  assert.equal(r.row.state, 'autopay_on');
  assert.equal(r.row.detail.note, 'already active on resume');
  assert.equal(f.count('activateSchedule'), 1, 'never a second activation');
});

test('a schedule whose state cannot be read is left alone and flagged for a person', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan', cus: 'cus_dan' })] }, scheduleState: { sch_101: { something: 'else' } } });
  f.ghl.activateSchedule = async () => { throw new Error('boom'); };
  await assert.rejects(() => runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW));
  const r = await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, at(60_000));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_schedule_state');
  assert.equal(r.row.state, 'schedule_created');
  assert.match(r.row.detail.attention, /could not tell/);
});

test('a stuck schedule from a crash before the id was saved is adopted by exact name only', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({
    contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan', cus: 'cus_dan' })] },
    // search matches any part of the name: a similar name must not be adopted.
    schedules: [{ _id: 'sch_other', name: `${cp.invoiceName}2` }, { _id: 'sch_stuck', name: cp.invoiceName }],
  });
  const r = await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW);
  assert.equal(r.row.state, 'autopay_on');
  assert.equal(r.row.scheduleId, 'sch_stuck');
  assert.equal(r.row.detail.adopted, true);
  assert.equal(f.count('createSchedule'), 0, 'adopted, not recreated');
  assert.equal(f.calls.find((c) => c.name === 'activateSchedule').args[1].paymentMethodId, 'pm_dan', 'the card was looked up for the adopted schedule');

  // Only a near miss: a fresh schedule is created.
  const { env: env2, cfg: cfg2, cp: cp2 } = await dueDan();
  const f2 = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1')] }, schedules: [{ _id: 'sch_other', name: `${cp2.invoiceName}9` }] });
  const r2 = await runPayer(env2, f2.ghl, cfg2, cp2.closeoutPayerId, NOW);
  assert.equal(r2.row.scheduleId, 'sch_101');
  assert.equal(f2.count('createSchedule'), 1);
});

test('missing email or phone: skipped, lines stay open, no schedule', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: { ...DAN, email: '' } }, transactions: { c_dan: [tx('t1')] } });
  const r = await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW);
  assert.equal(r.row.state, 'skipped_missing_contact');
  assert.deepEqual(r.row.detail.missing, ['email']);
  assert.equal(f.count('createSchedule'), 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM purchases WHERE status = 'open'").get().n, 3);
});

test('no usable card: skipped, lines stay open, the no-card flag is set', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { source: 'point_of_sale' }), tx('t2', { live: false })] } });
  const r = await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW);
  assert.equal(r.row.state, 'skipped_no_card');
  assert.equal(f.count('createSchedule'), 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM purchases WHERE status = 'open'").get().n, 3);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM tab_flags WHERE payer_contact_id = 'c_dan'").get().n, 1);
});

test('Charged at POS makes no GHL call, marks the lines, clears the no-card flag', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN } });
  await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW); // skipped_no_card
  const before = f.calls.length;
  const r = await markPaidAtPos(env, cp.closeoutPayerId, 'tapped at the desk', at(3600_000));
  assert.equal(r.row.state, 'paid_at_pos');
  assert.equal(r.row.detail.pos.note, 'tapped at the desk');
  assert.equal(f.calls.length, before, 'no GHL call');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM purchases WHERE status = 'invoiced' AND closeout_payer_id = ?").get(cp.closeoutPayerId).n, 3);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM tab_flags').get().n, 0);
  assert.equal((await latestCloseout(env)).done, true);
  // Idempotent.
  assert.equal((await markPaidAtPos(env, cp.closeoutPayerId, 'again', at(7200_000))).row.state, 'paid_at_pos');
});

test('refreshPayer: sent is pending through the day after the charge day, paid is paid, later still unpaid is flagged', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan', cus: 'cus_dan' })] }, invoices: { c_dan: [] } });
  await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW); // charge day 2026-09-26 ET
  const invoices = f.ghl.listInvoices;
  const withInvoice = (status) => { f.ghl.listInvoices = async () => [{ _id: 'inv_1', scheduleId: 'sch_101', status, amountPaid: status === 'paid' ? 6 : 0 }]; };

  // Same day, "sent": still pending (the charge landed 10 hours later on the test).
  withInvoice('sent');
  let r = await refreshPayer(env, f.ghl, cp.closeoutPayerId, at(6 * 3600_000));
  assert.equal(r.row.state, 'autopay_on');
  assert.equal(r.row.invoiceId, 'inv_1');
  assert.equal(r.row.detail.invoiceStatus, 'sent');
  // The day after the charge day, still "sent": still pending.
  r = await refreshPayer(env, f.ghl, cp.closeoutPayerId, new Date('2026-09-27T20:00:00Z'));
  assert.equal(r.row.state, 'autopay_on');
  // Two days on, still unpaid: flagged.
  r = await refreshPayer(env, f.ghl, cp.closeoutPayerId, new Date('2026-09-28T04:00:01Z')); // 00:00:01 ET on the 28th
  assert.equal(r.row.state, 'failed');
  assert.equal(r.row.detail.invoiceStatus, 'sent');

  // Paid, whenever it is seen.
  const { env: e2, cfg: c2, cp: p2 } = await dueDan();
  const f2 = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1')] } });
  await runPayer(e2, f2.ghl, c2, p2.closeoutPayerId, NOW);
  f2.ghl.listInvoices = async () => [{ _id: 'inv_9', scheduleId: 'sch_101', status: 'paid', amountPaid: 6 }];
  r = await refreshPayer(e2, f2.ghl, p2.closeoutPayerId, at(10 * 3600_000));
  assert.equal(r.row.state, 'paid');
  assert.equal(r.row.invoiceId, 'inv_9');
  assert.equal((await latestCloseout(e2)).done, true);
  // A refresh on a final row reads nothing.
  const n = f2.count('listInvoices');
  await refreshPayer(e2, f2.ghl, p2.closeoutPayerId, at(11 * 3600_000));
  assert.equal(f2.count('listInvoices'), n);
  f.ghl.listInvoices = invoices;
});

test('a voided invoice is flagged straight away', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1')] } });
  await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW);
  f.ghl.listInvoices = async () => [{ _id: 'inv_1', scheduleId: 'sch_101', status: 'void' }];
  const r = await refreshPayer(env, f.ghl, cp.closeoutPayerId, at(3600_000));
  assert.equal(r.row.state, 'failed');
});

test('closeoutPayers never leaks the card ids into the row the page sees', async () => {
  const { env, cfg, cp } = await dueDan();
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan', cus: 'cus_dan' })] } });
  await runPayer(env, f.ghl, cfg, cp.closeoutPayerId, NOW);
  const rows = await closeoutPayers(env, cp.closeoutId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].card, { brand: 'visa', last4: '4242', source: 'funnel' });
  // The detail column holds them for the resume path; the route strips it. Pinned in the route tests.
  assert.equal(rows[0].detail.paymentMethodId, 'pm_dan');
});

// ---------- routes ----------

import { createApp } from '../src/app.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';

const SALT = 'unit-test-salt-value';

async function routeSetup(ghlOpts) {
  resetFallback();
  const env = { ...ENV, STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', PIN_PEPPER: 'a-long-pepper-for-tests', DB: memoryD1() };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: at(-3600_000) });
  const cfg = tabConfig(env, ITEMS);
  const f = fakeGhl(ghlOpts);
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), ghl: f.ghl, now: () => NOW }, { tabItems: ITEMS });
  const staff = (path, { method = 'GET', body } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'x-staff-pin': '1234', 'cf-connecting-ip': '10.0.0.1' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  return { env, cfg, f, staff, id: (c) => opaqueId(c, SALT) };
}

test('routes: review, card, start, run, refresh, pos; opaque ids and no card ids leave the Worker', async () => {
  const { env, cfg, f, staff, id } = await routeSetup({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan', cus: 'cus_dan', last4: '6222' })] } });
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  await buy(env, cfg, 'c_maria', 'water', at(-DAY));
  const dan = await id('c_dan');

  const review = await (await staff('/api/staff/tab/review')).json();
  assert.equal(review.minTotal, '$5');
  assert.deepEqual(review.payers.map((p) => [p.id === dan, p.total, p.charge]), [[true, '$6', true], [false, '$1', false]]);
  assert.ok(!('payerId' in review.payers[0]));
  assert.equal(review.active, null);

  const card = await (await staff(`/api/staff/tab/card?id=${dan}`)).json();
  assert.deepEqual(card, { ok: true, reason: null, missing: null, card: { brand: 'visa', last4: '6222', source: 'funnel' } });
  assert.equal(JSON.stringify(card).includes('pm_dan'), false);
  assert.equal((await staff('/api/staff/tab/card?id=zzz')).status, 404);

  const started = await (await staff('/api/staff/tab/closeout', { method: 'POST', body: { payerIds: [dan, await id('c_maria')] } })).json();
  assert.equal(started.ok, true);
  assert.equal(started.payers.length, 1);
  assert.equal(started.payers[0].id, dan);
  assert.equal(started.payers[0].state, 'pending');
  const cpId = started.payers[0].closeoutPayerId;
  assert.equal((await staff('/api/staff/tab/closeout', { method: 'POST', body: { payerIds: [await id('c_maria')] } })).status, 409);
  assert.equal((await staff('/api/staff/tab/closeout', { method: 'POST', body: {} })).status, 400);

  const active = await (await staff('/api/staff/tab/review')).json();
  assert.equal(active.active.closeoutId, started.closeoutId);

  const run = await (await staff('/api/staff/tab/closeout/run', { method: 'POST', body: { closeoutPayerId: cpId } })).json();
  assert.equal(run.ok, true);
  assert.equal(run.row.state, 'autopay_on');
  assert.equal(run.row.chargeDay, '2026-09-26');
  assert.deepEqual(run.row.card, { brand: 'visa', last4: '6222', source: 'funnel' });
  assert.equal(JSON.stringify(run).includes('pm_dan'), false, 'card ids stay in D1');
  assert.equal(JSON.stringify(run).includes('cus_dan'), false);
  assert.equal(JSON.stringify(run).includes('c_dan'), false, 'never the GHL id');

  f.ghl.listInvoices = async () => [{ _id: 'inv_1', scheduleId: 'sch_101', status: 'sent' }];
  const check = await (await staff('/api/staff/tab/closeout/refresh', { method: 'POST', body: { closeoutPayerId: cpId } })).json();
  assert.equal(check.row.state, 'autopay_on');
  assert.equal(check.row.invoiceStatus, 'sent');
  assert.equal(check.row.invoiceId, 'inv_1');

  const status = await (await staff('/api/staff/tab/closeout')).json();
  assert.equal(status.done, false);
  assert.equal(status.payers[0].state, 'autopay_on');

  const pos = await (await staff('/api/staff/tab/closeout/pos', { method: 'POST', body: { closeoutPayerId: cpId, note: 'desk' } })).json();
  assert.equal(pos.row.state, 'paid_at_pos');
  assert.equal(pos.row.pos.note, 'desk');
  assert.equal((await (await staff('/api/staff/tab/closeout')).json()).done, true);
  assert.equal((await staff('/api/staff/tab/closeout/run', { method: 'POST', body: { closeoutPayerId: 'x' } })).status, 400);
  assert.equal((await staff('/api/staff/tab/closeout/run', { method: 'POST', body: { closeoutPayerId: 999 } })).status, 404);
});

test('routes: a GHL failure mid-step answers 502 with where the row got to, and a retry resumes', async () => {
  const { env, cfg, f, staff, id } = await routeSetup({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan', cus: 'cus_dan' })] } });
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  const started = await (await staff('/api/staff/tab/closeout', { method: 'POST', body: { payerIds: [await id('c_dan')] } })).json();
  const cpId = started.payers[0].closeoutPayerId;
  const real = f.ghl.activateSchedule;
  f.ghl.activateSchedule = async () => { throw new Error('GHL 503'); };
  const res = await staff('/api/staff/tab/closeout/run', { method: 'POST', body: { closeoutPayerId: cpId } });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /503/);
  assert.equal(body.row.state, 'schedule_created');
  f.ghl.activateSchedule = real;
  const again = await (await staff('/api/staff/tab/closeout/run', { method: 'POST', body: { closeoutPayerId: cpId } })).json();
  assert.equal(again.row.state, 'autopay_on');
  assert.equal(f.count('createSchedule'), 1);
});

test('routes: the close-out is 500 when no GHL client is wired, and 404 when the tab is off', async () => {
  const { staff } = await routeSetup({});
  const off = await routeSetup({});
  off.env.TAB_ITEMS = '';
  assert.equal((await off.staff('/api/staff/tab/review')).status, 404);
  const noGhl = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), now: () => NOW }, { tabItems: ITEMS });
  const res = await noGhl.fetch(new Request('https://x.test/api/staff/tab/review', { headers: { 'x-staff-pin': '1234' } }), { ...ENV, STAFF_PIN: '1234', ID_SALT: SALT, PIN_PEPPER: 'a-long-pepper-for-tests', DB: (await routeSetup({})).env.DB });
  assert.equal(res.status, 500);
  assert.equal((await staff('/api/staff/tab/activity')).status, 200, 'the other tab routes do not need it');
});

// ---------- the cron's share ----------

import { jobsForCron, isTabStartTick } from '../src/cron.js';
import { autoHourFrom } from '../src/tab.js';

test('autoHourFrom and the cron mapping', () => {
  assert.equal(autoHourFrom('20'), 20);
  assert.equal(autoHourFrom(' 0 '), 0);
  for (const bad of ['', 'off', '24', '-1', '8pm', undefined]) assert.equal(autoHourFrom(bad), null, String(bad));
  const TZ = 'America/New_York';
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-09-26T12:00:00Z'), TZ), ['roster']);
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-09-26T12:00:00Z'), TZ, { tabOn: true }), ['roster', 'tab']);
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-09-26T07:00:00Z'), TZ, { tabOn: true }), ['roster', 'rollup', 'tab']);
  // 8 PM EDT is 00:00Z the next day.
  assert.equal(isTabStartTick(new Date('2026-09-27T00:00:00Z'), TZ, 20), true);
  assert.equal(isTabStartTick(new Date('2026-09-27T00:30:00Z'), TZ, 20), false);
  assert.equal(isTabStartTick(new Date('2026-09-26T23:00:00Z'), TZ, 20), false);
  assert.equal(isTabStartTick(new Date('2026-09-27T00:00:00Z'), TZ, null), false);
  // 8 PM EST in January is 01:00Z.
  assert.equal(isTabStartTick(new Date('2026-01-16T01:00:00Z'), TZ, 20), true);
});

test('tabTick: nothing to do is nothing done, and no log row', async () => {
  const { env, cfg } = await seeded();
  const f = fakeGhl({});
  const r = await tabTick(env, f.ghl, cfg, NOW, { start: false });
  assert.equal(r.did, false);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE job = 'tab'").get().n, 0);
  assert.equal(f.calls.length, 0);
  const off = await tabTick(env, f.ghl, { ...cfg, enabled: false }, NOW, { start: true });
  assert.equal(off.did, false);
});

test('tabTick on the start tick: opens a close-out for everyone due, charges within the budget, continues next tick', async () => {
  const { env, cfg } = await seeded();
  const f = fakeGhl({
    contacts: { c_dan: DAN, c_maria: { id: 'c_maria', name: 'María Núñez', email: 'm@x.test', phone: '+15555550101' }, c_lead: { id: 'c_lead', name: 'Lead Only', email: 'l@x.test', phone: '+15555550102' }, c_sam: { id: 'c_sam', name: 'Sam', email: 's@x.test', phone: '+15555550103' } },
    transactions: { c_dan: [tx('t1', { pm: 'pm_dan' })], c_maria: [tx('t2', { pm: 'pm_maria' })], c_lead: [tx('t3', { pm: 'pm_lead' })], c_sam: [tx('t4', { pm: 'pm_sam' })] },
  });
  for (const who of ['c_dan', 'c_maria', 'c_lead', 'c_sam']) { await buy(env, cfg, who, 'hydration', at(-DAY)); await buy(env, cfg, who, 'hydration', at(-DAY)); }
  await buy(env, cfg, 'c_newkid', 'water', at(-DAY)); // $1, rolls (and a kid, but the rule is the rule: not due)

  // Not the start tick: a due tab is not touched.
  let r = await tabTick(env, f.ghl, cfg, NOW, { start: false });
  assert.equal(r.did, false);

  // The start tick: four due, budget three.
  r = await tabTick(env, f.ghl, cfg, NOW, { start: true, budget: 3 });
  assert.equal(r.did, true);
  assert.equal(r.started, 4);
  assert.equal(r.advanced, 3);
  assert.equal(r.outcome, 'ok');
  let states = env.DB.raw.prepare('SELECT state FROM closeout_payers ORDER BY id').all().map((x) => x.state);
  assert.deepEqual(states, ['autopay_on', 'autopay_on', 'autopay_on', 'pending']);
  assert.equal(env.DB.raw.prepare("SELECT status FROM purchases WHERE payer_contact_id = 'c_newkid'").get().status, 'open');
  const log = env.DB.raw.prepare("SELECT outcome, detail FROM sync_log WHERE job = 'tab'").all();
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /"started":4/);

  // Next tick (not a start tick): the fourth is picked up. A start tick would not open a second close-out while this one is unfinished.
  r = await tabTick(env, f.ghl, cfg, at(30 * 60_000), { start: true, budget: 3 });
  assert.equal(r.started, 0);
  assert.equal(r.advanced, 1);
  states = env.DB.raw.prepare('SELECT state FROM closeout_payers ORDER BY id').all().map((x) => x.state);
  assert.deepEqual(states, ['autopay_on', 'autopay_on', 'autopay_on', 'autopay_on']);
  assert.equal(f.count('createSchedule'), 4);

  // Same day: charging rows are not re-read. The next day: they are, one call each, and paid rows close.
  r = await tabTick(env, f.ghl, cfg, at(60 * 60_000), { start: false, budget: 3 });
  assert.equal(r.refreshed, 0);
  f.ghl.listInvoices = async (e, id) => [{ _id: `inv_${id}`, scheduleId: env.DB.raw.prepare('SELECT invoice_schedule_id FROM closeout_payers WHERE payer_contact_id = ?').get(id).invoice_schedule_id, status: id === 'c_sam' ? 'sent' : 'paid' }];
  r = await tabTick(env, f.ghl, cfg, at(DAY + 60 * 60_000), { start: false, budget: 3 });
  assert.equal(r.refreshed, 3);
  r = await tabTick(env, f.ghl, cfg, at(DAY + 90 * 60_000), { start: false, budget: 3 });
  assert.equal(r.refreshed, 1);
  states = env.DB.raw.prepare('SELECT state FROM closeout_payers ORDER BY id').all().map((x) => x.state);
  assert.deepEqual(states, ['paid', 'paid', 'paid', 'autopay_on']);
  assert.equal((await latestCloseout(env)).done, false);
});

test('tabTick: a payer that throws is left with the error and retried next tick; a row flagged for a person is left alone', async () => {
  const { env, cfg } = await seeded();
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  await buy(env, cfg, 'c_dan', 'hydration', at(-DAY));
  const f = fakeGhl({ contacts: { c_dan: DAN }, transactions: { c_dan: [tx('t1', { pm: 'pm_dan' })] } });
  const real = f.ghl.activateSchedule;
  f.ghl.activateSchedule = async () => { throw new Error('GHL 502'); };
  let r = await tabTick(env, f.ghl, cfg, NOW, { start: true });
  assert.equal(r.outcome, 'degraded');
  assert.match(r.errors[0], /Dan Kim: GHL 502/);
  let row = env.DB.raw.prepare('SELECT state, detail FROM closeout_payers').get();
  assert.equal(row.state, 'schedule_created');
  assert.match(row.detail, /GHL 502/);
  assert.equal(env.DB.raw.prepare("SELECT outcome FROM sync_log WHERE job = 'tab'").get().outcome, 'degraded');

  f.ghl.activateSchedule = real;
  r = await tabTick(env, f.ghl, cfg, at(30 * 60_000), { start: false });
  assert.equal(r.advanced, 1);
  assert.equal(env.DB.raw.prepare('SELECT state FROM closeout_payers').get().state, 'autopay_on');
  assert.equal(f.count('createSchedule'), 1, 'resumed, not recreated');

  // A row the state machine flagged for a person is not retried by the cron.
  env.DB.raw.prepare("UPDATE closeout_payers SET state = 'schedule_created', detail = ?").run(JSON.stringify({ attention: 'could not tell' }));
  r = await tabTick(env, f.ghl, cfg, at(60 * 60_000), { start: false });
  assert.equal(r.did, false);
});
