// closeout.js — the drink tab close-out (§15.3, step 6). Turns open purchases
// into one GHL invoice per payer, charged to the card they already have on
// file. Nothing here runs on a cron; a person on the staff page presses the
// button, and the browser then drives one payer per request.
//
// Every step writes its result to the closeout_payers row before the next
// step runs, so a crash at any point resumes safely and never double-charges.
//
// GHL calls arrive through `ghl`, an object of the functions in ghl.js, so
// tests run against fixtures and the write scanner still sees every path.

import { formatCents } from './tab.js';
import { localParts, localDayBounds, pad } from './time.js';
import { shiftDate } from './classes.js';
import { sha256Hex } from './pin.js';

export const BUSINESS_NAME = 'Brazilian Top Team Bridgewater';
export const EXECUTE_DELAY_MS = 5 * 60_000; // executeAt a few minutes after the button
export const SAVED_SOURCES = new Set(['invoice', 'funnel', 'payment_link']);
export const FINAL_STATES = new Set(['paid', 'paid_at_pos', 'failed', 'skipped_no_card', 'skipped_missing_contact']);

const iso = (d) => d.toISOString();

/**
 * Unique per payer per close-out, readable on the member's invoice, and
 * carrying no GHL id: "BTT tab #12-3f9a1c0e". The suffix is the first eight
 * hex of SHA-256 of the contact id.
 */
export async function invoiceName(closeoutId, payerContactId) {
  return `BTT tab #${closeoutId}-${(await sha256Hex(payerContactId)).slice(0, 8)}`;
}

/** "YYYY-MM-DDTHH:mm:ssZ", no milliseconds, or GHL answers 422. */
export function executeAtFor(now) {
  const d = new Date(now.getTime() + EXECUTE_DELAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

// ---------- review ----------

/**
 * Who is due. A payer is charged when their open tab reaches cfg.minCents or
 * their oldest open line is cfg.maxRollDays old; otherwise it rolls.
 */
export function chargeDecision(lines, cfg, now) {
  const total = lines.reduce((n, l) => n + l.amountCents, 0);
  const oldest = lines.reduce((min, l) => (l.purchasedAt < min ? l.purchasedAt : min), lines[0]?.purchasedAt || iso(now));
  const ageDays = (now.getTime() - Date.parse(oldest)) / 86_400_000;
  const charge = total >= cfg.minCents || ageDays >= cfg.maxRollDays;
  return { totalCents: total, oldestAt: oldest, ageDays: Math.floor(ageDays), charge };
}

/** Every payer with open lines, grouped, with the charge/roll decision. */
export async function reviewPayers(env, cfg, now) {
  const whens = cfg.items.map(() => 'WHEN ? THEN ?').join(' ');
  const labelSql = cfg.items.length ? `CASE p.item_key ${whens} ELSE p.item_key END` : 'p.item_key';
  const binds = cfg.items.flatMap((i) => [i.key, i.label]);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.payer_contact_id, p.buyer_contact_id, p.item_key, ${labelSql} AS label, p.unit_amount_cents, p.qty, p.purchased_at, p.method,
            m.first_name, m.last_name
       FROM purchases p LEFT JOIN members m ON m.ghl_contact_id = p.payer_contact_id
      WHERE p.status = 'open'
      ORDER BY p.payer_contact_id, p.purchased_at`,
  ).bind(...binds).all();
  const byPayer = new Map();
  for (const r of results) {
    if (!byPayer.has(r.payer_contact_id)) byPayer.set(r.payer_contact_id, { payerId: r.payer_contact_id, first: r.first_name || '(unknown)', last: r.last_name || '', lines: [] });
    byPayer.get(r.payer_contact_id).lines.push({
      purchaseId: r.id, item: r.item_key, label: r.label, amountCents: Number(r.unit_amount_cents) * Number(r.qty || 1),
      purchasedAt: r.purchased_at, method: r.method,
    });
  }
  const payers = [];
  for (const p of byPayer.values()) {
    const d = chargeDecision(p.lines, cfg, now);
    payers.push({ ...p, ...d, total: formatCents(d.totalCents) });
  }
  payers.sort((a, b) => (a.charge === b.charge ? b.totalCents - a.totalCents : a.charge ? -1 : 1));
  return payers;
}

// ---------- card on file ----------

function pickField(obj, ...paths) {
  for (const path of paths) {
    let v = obj;
    for (const k of path.split('.')) v = v && typeof v === 'object' ? v[k] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * The card to charge, per the verified lookup rule: the most recent live,
 * succeeded transaction from an invoice, funnel or payment link; a POS
 * transaction only when its payment method also appears on one of those.
 * Test-mode transactions never count. Returns null when nothing is usable.
 *
 * `detail` reads the transaction that holds the card ids. Only the
 * candidates that matter are read, so this stays at a handful of calls.
 */
export async function findCard(ghl, env, contactId, { maxReads = 6 } = {}) {
  const all = await ghl.listTransactions(env, contactId);
  const live = all
    .filter((t) => String(t.status || '').toLowerCase() === 'succeeded' && t.liveMode === true)
    .filter((t) => SAVED_SOURCES.has(String(t.entitySourceType || '')) || String(t.entitySourceType || '') === 'point_of_sale')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, maxReads);
  const snapshotOf = (t) => {
    const snap = t.chargeSnapshot || {};
    const customer = pickField(snap, 'customer.id', 'customer');
    const pm = pickField(snap, 'payment_method.id', 'paymentMethod.id');
    const brand = pickField(snap, 'payment_method.card.brand', 'paymentMethod.card.brand', 'card.brand');
    const last4 = pickField(snap, 'payment_method.card.last4', 'paymentMethod.card.last4', 'card.last4');
    return customer && pm ? { customerId: String(customer), paymentMethodId: String(pm), brand: brand ? String(brand) : '', last4: last4 ? String(last4) : '' } : null;
  };
  // Read the snapshots (the list may or may not carry them), most recent first.
  const cards = [];
  for (const t of live) {
    const full = t.chargeSnapshot ? t : await ghl.getTransaction(env, t._id || t.id);
    const card = snapshotOf(full);
    if (card) cards.push({ ...card, source: String(t.entitySourceType), at: String(t.createdAt || '') });
  }
  // A payment method is usable only if a saved-source transaction carries it.
  const savedPms = new Set(cards.filter((c) => SAVED_SOURCES.has(c.source)).map((c) => c.paymentMethodId));
  // Then the most recent successful charge on any usable method wins, POS included.
  return cards.find((c) => savedPms.has(c.paymentMethodId)) || null;
}

/** Contact details for the invoice, and which of them are missing. */
export async function contactForInvoice(ghl, env, contactId) {
  const c = await ghl.getContact(env, contactId);
  const missing = [];
  if (!c.name) missing.push('name');
  if (!c.email) missing.push('email');
  if (!c.phone) missing.push('phone');
  return { ...c, missing };
}

/** One payer's card and contact status for the review screen. Reads only. */
export async function payerCardStatus(ghl, env, contactId) {
  const contact = await contactForInvoice(ghl, env, contactId);
  if (contact.missing.length) return { ok: false, reason: 'missing_contact', missing: contact.missing, contact };
  const card = await findCard(ghl, env, contactId);
  if (!card) return { ok: false, reason: 'no_card', contact };
  return { ok: true, contact, card };
}

// ---------- starting a close-out ----------

/**
 * Create the closeouts row and one closeout_payers row per payer, state
 * pending, before any GHL call. Only payers with open lines who meet the
 * charge rule right now are taken; the caller's list is a request, the rule
 * is the truth.
 */
export async function startCloseout(env, cfg, payerIds, now) {
  const wanted = new Set(payerIds);
  const due = (await reviewPayers(env, cfg, now)).filter((p) => p.charge && wanted.has(p.payerId));
  if (due.length === 0) return { ok: false, reason: 'nobody_due' };
  const db = env.DB;
  const created = await db.prepare('INSERT INTO closeouts (created_at, approved_by) VALUES (?, ?)').bind(iso(now), 'staff').run();
  const closeoutId = Number(created.meta.last_row_id);
  const stmts = [];
  for (const p of due) {
    stmts.push(db.prepare(
      `INSERT INTO closeout_payers (closeout_id, payer_contact_id, amount_cents, invoice_name, state, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).bind(closeoutId, p.payerId, p.totalCents, await invoiceName(closeoutId, p.payerId), iso(now)));
  }
  await db.batch(stmts);
  return { ok: true, closeoutId, payers: await closeoutPayers(env, closeoutId) };
}

export async function closeoutPayers(env, closeoutId) {
  const { results } = await env.DB.prepare(
    `SELECT cp.*, m.first_name, m.last_name FROM closeout_payers cp
       LEFT JOIN members m ON m.ghl_contact_id = cp.payer_contact_id
      WHERE cp.closeout_id = ? ORDER BY cp.id`,
  ).bind(closeoutId).all();
  return results.map(rowOut);
}

export async function latestCloseout(env) {
  const row = await env.DB.prepare('SELECT id, created_at FROM closeouts ORDER BY id DESC LIMIT 1').first();
  if (!row) return null;
  const payers = await closeoutPayers(env, row.id);
  return { closeoutId: row.id, createdAt: row.created_at, payers, done: payers.every((p) => FINAL_STATES.has(p.state)) };
}

function rowOut(r) {
  let detail = null;
  try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { detail = { note: r.detail }; }
  return {
    closeoutPayerId: r.id, closeoutId: r.closeout_id, payerId: r.payer_contact_id,
    first: r.first_name || '(unknown)', last: r.last_name || '',
    amountCents: r.amount_cents, total: formatCents(r.amount_cents), invoiceName: r.invoice_name,
    state: r.state, scheduleId: r.invoice_schedule_id, invoiceId: r.invoice_id,
    card: r.card_last4 ? { brand: r.card_brand || '', last4: r.card_last4, source: r.card_source || '' } : null,
    detail, updatedAt: r.updated_at,
  };
}

async function setState(env, id, state, fields = {}, now = new Date()) {
  const cols = ['state = ?', 'updated_at = ?'];
  const binds = [state, iso(now)];
  for (const [k, v] of Object.entries(fields)) { cols.push(`${k} = ?`); binds.push(v); }
  binds.push(id);
  await env.DB.prepare(`UPDATE closeout_payers SET ${cols.join(', ')} WHERE id = ?`).bind(...binds).run();
}

const detailJson = (obj) => JSON.stringify(obj);

async function getPayerRow(env, id) {
  return env.DB.prepare(
    'SELECT cp.*, m.first_name, m.last_name FROM closeout_payers cp LEFT JOIN members m ON m.ghl_contact_id = cp.payer_contact_id WHERE cp.id = ?',
  ).bind(id).first();
}

// ---------- running one payer ----------

/**
 * Whether a schedule GHL returned is already activated with auto-pay.
 * Returns true, false, or null when the shape cannot be read; the caller
 * treats null as "do not touch it", because a second activation is the
 * failure that cannot be undone and a missed one can be closed at the POS.
 */
export function scheduleIsActive(s) {
  if (!s || typeof s !== 'object') return null;
  const status = String(s.status || s.scheduleStatus || '').toLowerCase();
  const auto = pickField(s, 'autoPayment.enable', 'autoPayment.enabled');
  if (status === 'active' || auto === true) return true;
  if (status === 'draft' || status === 'inactive' || status === 'scheduled' || auto === false) return false;
  return null;
}

/**
 * Advance one payer as far as it can go in one request. Each step persists
 * before the next. Returns the row afterwards.
 */
export async function runPayer(env, ghl, cfg, closeoutPayerId, now) {
  let row = await getPayerRow(env, closeoutPayerId);
  if (!row) return { ok: false, reason: 'unknown' };
  if (FINAL_STATES.has(row.state) || row.state === 'autopay_on') return { ok: true, row: rowOut(row) };
  const payerId = row.payer_contact_id;

  // 1. pending with no schedule id: adopt a stuck earlier attempt, by exact name only.
  if (row.state === 'pending' && !row.invoice_schedule_id) {
    const found = (await ghl.findSchedules(env, row.invoice_name)).filter((s) => String(s.name || '') === row.invoice_name);
    if (found.length) {
      const id = String(found[0]._id || found[0].id);
      await setState(env, row.id, 'schedule_created', { invoice_schedule_id: id, detail: detailJson({ adopted: true }) }, now);
      row = await getPayerRow(env, row.id);
    }
  }

  if (row.state === 'pending') {
    // 2. contact details
    const contact = await contactForInvoice(ghl, env, payerId);
    if (contact.missing.length) {
      await setState(env, row.id, 'skipped_missing_contact', { detail: detailJson({ missing: contact.missing }) }, now);
      return { ok: true, row: rowOut(await getPayerRow(env, row.id)) };
    }
    // 3. card on file
    const card = await findCard(ghl, env, payerId);
    if (!card) {
      await env.DB.batch([
        env.DB.prepare("UPDATE closeout_payers SET state = 'skipped_no_card', updated_at = ? WHERE id = ?").bind(iso(now), row.id),
        env.DB.prepare('INSERT OR IGNORE INTO tab_flags (payer_contact_id, no_card_since) VALUES (?, ?)').bind(payerId, iso(now)),
      ]);
      return { ok: true, row: rowOut(await getPayerRow(env, row.id)) };
    }
    await setState(env, row.id, 'pending', {
      card_brand: card.brand, card_last4: card.last4, card_source: card.source,
      detail: detailJson({ customerId: card.customerId, paymentMethodId: card.paymentMethodId, contact: { name: contact.name, email: contact.email, phone: contact.phone } }),
    }, now);
    // 4. create the schedule
    const lines = await openLines(env, cfg, payerId);
    const created = await ghl.createSchedule(env, {
      name: row.invoice_name,
      contactDetails: { id: contact.id, name: contact.name, phoneNo: contact.phone, email: contact.email },
      schedule: { executeAt: executeAtFor(now) },
      liveMode: true,
      businessDetails: { name: BUSINESS_NAME },
      currency: 'USD',
      discount: { type: 'percentage', value: 0 },
      items: lines.map((l) => ({ name: l.label, currency: 'USD', amount: l.amountCents / 100, qty: l.qty, productId: l.productId, priceId: l.priceId, type: 'one_time' })),
    });
    if (!created.id) {
      await setState(env, row.id, 'pending', { detail: detailJson({ error: 'schedule created but no id returned; check GHL by name before retrying' }) }, now);
      return { ok: false, reason: 'no_schedule_id', row: rowOut(await getPayerRow(env, row.id)) };
    }
    await setState(env, row.id, 'schedule_created', { invoice_schedule_id: created.id }, now);
    row = await getPayerRow(env, row.id);
    // Fresh from creation: not active. Straight to 5 with no read.
    return activate(env, ghl, row, now, { fresh: true });
  }

  if (row.state === 'schedule_created') return activate(env, ghl, row, now, { fresh: false });
  return { ok: true, row: rowOut(row) };
}

async function openLines(env, cfg, payerId) {
  const { results } = await env.DB.prepare(
    "SELECT item_key, product_id, price_id, unit_amount_cents, qty FROM purchases WHERE payer_contact_id = ? AND status = 'open' ORDER BY purchased_at",
  ).bind(payerId).all();
  const label = (k) => (cfg.items.find((i) => i.key === k) || {}).label || k;
  // One line per item key, quantities summed, so the invoice reads "Water x3".
  const merged = new Map();
  for (const r of results) {
    const key = `${r.item_key}|${r.unit_amount_cents}`;
    const cur = merged.get(key) || { label: label(r.item_key), amountCents: Number(r.unit_amount_cents), qty: 0, productId: r.product_id, priceId: r.price_id };
    cur.qty += Number(r.qty || 1);
    merged.set(key, cur);
  }
  return [...merged.values()];
}

/** 5. Auto-pay on and activate, once. */
async function activate(env, ghl, row, now, { fresh }) {
  let detail = {};
  try { detail = row.detail ? JSON.parse(row.detail) : {}; } catch { detail = {}; }
  if (!fresh) {
    const s = await ghl.getSchedule(env, row.invoice_schedule_id);
    const active = scheduleIsActive(s);
    if (active === true) {
      await finishActivated(env, row, now, { ...detail, note: 'already active on resume' });
      return { ok: true, row: rowOut(await getPayerRow(env, row.id)) };
    }
    if (active === null) {
      await setState(env, row.id, 'schedule_created', { detail: detailJson({ ...detail, attention: 'could not tell whether the schedule is active; check it in GHL, then Charged at POS or retry' }) }, now);
      return { ok: false, reason: 'unknown_schedule_state', row: rowOut(await getPayerRow(env, row.id)) };
    }
    if (!detail.customerId || !detail.paymentMethodId) {
      // Adopted a stuck schedule without ever finding the card in this row: find it now.
      const card = await findCard(ghl, env, row.payer_contact_id);
      if (!card) {
        await setState(env, row.id, 'schedule_created', { detail: detailJson({ ...detail, attention: 'schedule exists but no card on file to activate it with; Charged at POS' }) }, now);
        return { ok: false, reason: 'no_card', row: rowOut(await getPayerRow(env, row.id)) };
      }
      detail = { ...detail, customerId: card.customerId, paymentMethodId: card.paymentMethodId };
      await setState(env, row.id, 'schedule_created', { card_brand: card.brand, card_last4: card.last4, card_source: card.source, detail: detailJson(detail) }, now);
      row = await getPayerRow(env, row.id);
    }
  }
  await ghl.activateSchedule(env, row.invoice_schedule_id, {
    enable: true, type: 'saved_card', paymentMethodId: detail.paymentMethodId, customerId: detail.customerId,
    card: { brand: row.card_brand || '', last4: row.card_last4 || '' },
  });
  await finishActivated(env, row, now, detail);
  return { ok: true, row: rowOut(await getPayerRow(env, row.id)) };
}

async function finishActivated(env, row, now, detail) {
  const day = localParts(new Date(now.getTime() + EXECUTE_DELAY_MS), 'America/New_York').date;
  await env.DB.batch([
    env.DB.prepare("UPDATE closeout_payers SET state = 'autopay_on', updated_at = ?, detail = ? WHERE id = ?")
      .bind(iso(now), detailJson({ ...detail, chargeDay: day }), row.id),
    env.DB.prepare("UPDATE purchases SET status = 'invoiced', closeout_payer_id = ? WHERE payer_contact_id = ? AND status = 'open'")
      .bind(row.id, row.payer_contact_id),
  ]);
}

// ---------- status ----------

/**
 * Read the invoice's status. Observed 2026-09-25: the charge lands sometime
 * on the executeAt day, not at executeAt and not only at the due date. So
 * "sent" is pending until the day after the due date (end of the charge
 * day, ET); only an invoice still unpaid after that is flagged.
 */
export async function refreshPayer(env, ghl, closeoutPayerId, now, tz = 'America/New_York') {
  const row = await getPayerRow(env, closeoutPayerId);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.state !== 'autopay_on') return { ok: true, row: rowOut(row) };
  let detail = {};
  try { detail = row.detail ? JSON.parse(row.detail) : {}; } catch { detail = {}; }
  const invoices = await ghl.listInvoices(env, row.payer_contact_id);
  const inv = invoices.find((i) => String(i.scheduleId || (i.schedule && i.schedule.id) || '') === String(row.invoice_schedule_id))
    || invoices.find((i) => String(i.name || i.title || '') === row.invoice_name);
  const invoiceId = inv ? String(inv._id || inv.id) : null;
  const status = inv ? String(inv.status || '').toLowerCase() : '';
  if (status === 'paid') {
    await setState(env, row.id, 'paid', { invoice_id: invoiceId, detail: detailJson({ ...detail, paidAt: iso(now) }) }, now);
    return { ok: true, row: rowOut(await getPayerRow(env, row.id)) };
  }
  const chargeDay = detail.chargeDay || localParts(new Date(Date.parse(row.updated_at) + EXECUTE_DELAY_MS), tz).date;
  const flagAfter = localDayBounds(shiftDate(chargeDay, 1), tz).endIso; // end of the day after the charge day
  if (iso(now) >= flagAfter || status === 'void' || status === 'failed' || status === 'cancelled') {
    await setState(env, row.id, 'failed', { invoice_id: invoiceId, detail: detailJson({ ...detail, invoiceStatus: status || 'not found', checkedAt: iso(now) }) }, now);
  } else if (invoiceId && invoiceId !== row.invoice_id) {
    await setState(env, row.id, 'autopay_on', { invoice_id: invoiceId, detail: detailJson({ ...detail, invoiceStatus: status, checkedAt: iso(now) }) }, now);
  }
  return { ok: true, row: rowOut(await getPayerRow(env, row.id)) };
}

/** Charged at POS: closed out by hand, no GHL call. */
export async function markPaidAtPos(env, closeoutPayerId, note, now) {
  const row = await getPayerRow(env, closeoutPayerId);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.state === 'paid' || row.state === 'paid_at_pos') return { ok: true, row: rowOut(row) };
  let detail = {};
  try { detail = row.detail ? JSON.parse(row.detail) : {}; } catch { detail = {}; }
  await env.DB.batch([
    env.DB.prepare("UPDATE closeout_payers SET state = 'paid_at_pos', updated_at = ?, detail = ? WHERE id = ?")
      .bind(iso(now), detailJson({ ...detail, pos: { note: String(note || '').slice(0, 200), at: iso(now) } }), row.id),
    env.DB.prepare("UPDATE purchases SET status = 'invoiced', closeout_payer_id = ? WHERE payer_contact_id = ? AND status = 'open'")
      .bind(row.id, row.payer_contact_id),
    env.DB.prepare('DELETE FROM tab_flags WHERE payer_contact_id = ?').bind(row.payer_contact_id),
  ]);
  return { ok: true, row: rowOut(await getPayerRow(env, row.id)) };
}

// ---------- the cron's share ----------

export const TICK_PAYER_BUDGET = 3; // payers advanced per tick: ~12 GHL calls each at worst, under the per-invocation limit

/**
 * What the cron does for the tab on every tick, cheaply when there is
 * nothing to do:
 *   1. continue an unfinished close-out, a few payers per tick;
 *   2. re-read yesterday's charging rows so "Paid" shows without a tap;
 *   3. on the start tick (the TAB_AUTO_HOUR tick) open a close-out for
 *      everyone due, if none is unfinished, and begin on it.
 * A row that throws is left where it got to with the error in its detail;
 * the next tick tries it again, and the state machine makes that safe.
 * Writes a sync_log row (job 'tab') whenever it did anything.
 */
export async function tabTick(env, ghl, cfg, now, { start = false, budget = TICK_PAYER_BUDGET, tz = 'America/New_York' } = {}) {
  const out = { did: false, outcome: 'ok', started: 0, advanced: 0, refreshed: 0, errors: [] };
  if (!cfg || !cfg.enabled) return out;
  let left = budget;
  let latest = await latestCloseout(env);

  if (start && (!latest || latest.done)) {
    const due = (await reviewPayers(env, cfg, now)).filter((p) => p.charge).map((p) => p.payerId);
    if (due.length) {
      const r = await startCloseout(env, cfg, due, now);
      if (r.ok) { out.started = r.payers.length; out.did = true; latest = await latestCloseout(env); }
    }
  }

  if (latest && !latest.done) {
    for (const p of latest.payers) {
      if (left <= 0) break;
      if (p.state !== 'pending' && p.state !== 'schedule_created') continue;
      // A row a person has already been pointed at waits for that person.
      if (p.detail && p.detail.attention) continue;
      left -= 1;
      out.did = true;
      try {
        const r = await runPayer(env, ghl, cfg, p.closeoutPayerId, now);
        if (r.ok) out.advanced += 1; else out.errors.push(`${p.first} ${p.last}: ${r.reason}`);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        out.errors.push(`${p.first} ${p.last}: ${msg}`);
        await env.DB.prepare('UPDATE closeout_payers SET detail = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify({ ...(p.detail || {}), lastError: msg, at: iso(now) }), iso(now), p.closeoutPayerId).run();
      }
    }
  }

  // Yesterday's (and older) charging rows: one read each.
  const today = localParts(now, tz).date;
  const { results } = await env.DB.prepare("SELECT id, detail FROM closeout_payers WHERE state = 'autopay_on' ORDER BY id").all();
  for (const r of results) {
    if (left <= 0) break;
    let d = {};
    try { d = r.detail ? JSON.parse(r.detail) : {}; } catch { d = {}; }
    if (d.chargeDay && d.chargeDay >= today) continue; // still its charge day; the charge may not have run yet
    left -= 1;
    out.did = true;
    try {
      await refreshPayer(env, ghl, r.id, now, tz);
      out.refreshed += 1;
    } catch (e) {
      out.errors.push(`refresh ${r.id}: ${e && e.message ? e.message : e}`);
    }
  }

  if (out.errors.length) out.outcome = 'degraded';
  if (out.did) {
    await env.DB.prepare('INSERT INTO sync_log (job, ran_at, outcome, detail) VALUES (?, ?, ?, ?)')
      .bind('tab', iso(now), out.outcome, JSON.stringify({ started: out.started, advanced: out.advanced, refreshed: out.refreshed, errors: out.errors }))
      .run();
  }
  return out;
}
