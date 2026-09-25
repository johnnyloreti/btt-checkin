// purchases.js — the tab itself (§15.3): recording a drink, the no-card
// flag, and what the staff page reads. The close-out lives in closeout.js
// (step 6, gated on the $0.50 test).

import { formatCents } from './tab.js';

/** True when the payer's last close-out found no usable card (tab_flags). */
export async function hasNoCardFlag(env, contactId) {
  const row = await env.DB.prepare('SELECT no_card_since FROM tab_flags WHERE payer_contact_id = ?').bind(contactId).first();
  return Boolean(row);
}

export async function clearNoCardFlag(env, contactId) {
  const r = await env.DB.prepare('DELETE FROM tab_flags WHERE payer_contact_id = ?').bind(contactId).run();
  return { ok: true, cleared: Number(r?.meta?.changes ?? 0) > 0 };
}

/**
 * Put one item on a tab. Price and GHL ids are copied at this moment so a
 * later edit to tab-items.json never rewrites history. The PIN has been
 * checked by the caller. Returns what the kiosk shows.
 */
export async function recordPurchase(env, cfg, { buyerId, payerId, itemKey, method, now }) {
  const item = cfg.items.find((i) => i.key === String(itemKey || '').toLowerCase());
  if (!item) return { ok: false, reason: 'unknown_item' };
  const r = await env.DB.prepare(
    `INSERT INTO purchases (buyer_contact_id, payer_contact_id, item_key, product_id, price_id, unit_amount_cents, qty, purchased_at, method, status)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open')`,
  )
    .bind(buyerId, payerId, item.key, item.productId, item.priceId, item.amountCents, now.toISOString(), method)
    .run();
  return {
    ok: true,
    purchaseId: Number(r?.meta?.last_row_id ?? 0) || null,
    item: item.key,
    label: item.label,
    amountCents: item.amountCents,
    message: `Added to your tab. ${item.label}, ${formatCents(item.amountCents)}.`,
  };
}

const rowOut = (r) => ({
  purchaseId: r.id,
  buyerId: r.buyer_contact_id,
  payerId: r.payer_contact_id,
  first: r.first_name || '(unknown)',
  last: r.last_name || '',
  item: r.item_key,
  label: r.label || r.item_key,
  amountCents: Number(r.unit_amount_cents) * Number(r.qty || 1),
  purchasedAt: r.purchased_at,
  method: r.method,
  status: r.status,
});

function labelCase(cfg) {
  // Items may have left tab-items.json since a purchase was made; fall back to the key.
  if (!cfg || !cfg.items.length) return "item_key AS label";
  const whens = cfg.items.map(() => 'WHEN ? THEN ?').join(' ');
  return `CASE item_key ${whens} ELSE item_key END AS label`;
}
function labelBinds(cfg) {
  return cfg && cfg.items.length ? cfg.items.flatMap((i) => [i.key, i.label]) : [];
}

/** Every purchase on a local date, newest first. dayStart/dayEnd are ISO UTC bounds. */
export async function purchasesBetween(env, cfg, fromIso, toIso) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.buyer_contact_id, p.payer_contact_id, p.item_key, p.unit_amount_cents, p.qty, p.purchased_at, p.method, p.status,
            m.first_name, m.last_name, ${labelCase(cfg)}
       FROM purchases p LEFT JOIN members m ON m.ghl_contact_id = p.buyer_contact_id
      WHERE p.purchased_at >= ? AND p.purchased_at < ?
      ORDER BY p.purchased_at DESC, p.id DESC`,
  ).bind(...labelBinds(cfg), fromIso, toIso).all();
  return results.map(rowOut);
}

/** Void: soft delete. Only an open purchase can be voided; an invoiced one is money already. */
export async function voidPurchase(env, purchaseId) {
  const id = Number(purchaseId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('purchaseId must be a positive integer'), { status: 400 });
  const r = await env.DB.prepare("UPDATE purchases SET status = 'voided' WHERE id = ? AND status = 'open'").bind(id).run();
  return { ok: true, purchaseId: id, changed: Number(r?.meta?.changes ?? 0) };
}

/** A member's tab: open lines and their total, plus recent history. */
export async function memberTab(env, cfg, contactId, { limit = 30 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.buyer_contact_id, p.payer_contact_id, p.item_key, p.unit_amount_cents, p.qty, p.purchased_at, p.method, p.status,
            m.first_name, m.last_name, ${labelCase(cfg)}
       FROM purchases p LEFT JOIN members m ON m.ghl_contact_id = p.buyer_contact_id
      WHERE p.payer_contact_id = ?
      ORDER BY p.purchased_at DESC, p.id DESC
      LIMIT ?`,
  ).bind(...labelBinds(cfg), contactId, limit).all();
  const rows = results.map(rowOut);
  const open = rows.filter((r) => r.status === 'open');
  return {
    open,
    openCents: open.reduce((n, r) => n + r.amountCents, 0),
    recent: rows,
    noCard: await hasNoCardFlag(env, contactId),
  };
}
