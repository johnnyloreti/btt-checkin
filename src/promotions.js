// promotions.js — stripe tracking (§15.2).
//
// The tab surfaces who has crossed a threshold. It never says a promotion is
// owed: class count is one input, the instructor decides. Wording in the UI
// is "eligible for review", never "due".
//
// Eligibility is attended classes since the member's most recent recorded
// promotion, or all attended classes if they have none.

import { parseList } from './roster.js';
import { hasPromotionsTable } from './schema-caps.js';
import { localParts } from './time.js';

export const DEFAULT_STRIPE_CLASSES = 7;
export const KINDS = ['stripe', 'belt'];

/** Threshold and covered programs. Empty programs turns the feature off. */
export function stripeConfig(env = {}) {
  const raw = String(env.STRIPE_CLASSES ?? '').trim();
  const n = Number(raw);
  return {
    threshold: raw !== '' && Number.isInteger(n) && n > 0 ? n : DEFAULT_STRIPE_CLASSES,
    programs: parseList(env.STRIPE_PROGRAMS),
  };
}

export function stripesEnabled(env) {
  return stripeConfig(env).programs.length > 0;
}

/**
 * Who is eligible, most overdue first.
 *
 * members: [{ ghl_contact_id, first_name, last_name, programs: [key], lifetime }]
 * lastByContact: Map<contactId, { at_class_count, awarded_on, kind }>
 *
 * A promotion recorded and then attendance voided can leave lifetime below
 * the count at award time; that clamps to zero rather than going negative.
 */
export function eligibleForStripe(members, lastByContact, cfg) {
  if (cfg.programs.length === 0) return [];
  const rows = [];
  for (const m of members) {
    const programs = Array.isArray(m.programs) ? m.programs : [];
    if (!programs.some((p) => cfg.programs.includes(String(p).toLowerCase()))) continue;
    const last = lastByContact.get(m.ghl_contact_id) || null;
    const base = last ? Number(last.at_class_count) || 0 : 0;
    const since = Math.max(0, Number(m.lifetime || 0) - base);
    if (since < cfg.threshold) continue;
    rows.push({
      ghl_contact_id: m.ghl_contact_id,
      first: m.first_name,
      last: m.last_name,
      programs,
      lifetime: Number(m.lifetime || 0),
      since,
      // 22 classes past a 7-class threshold is worth three, which staff
      // should see rather than having to divide in their head.
      worth: Math.floor(since / cfg.threshold),
      lastAwardedOn: last ? last.awarded_on : null,
      lastKind: last ? last.kind : null,
    });
  }
  rows.sort((a, b) => b.since - a.since || a.first.localeCompare(b.first));
  return rows;
}

/** Most recent promotion per contact, as a Map. */
export async function lastPromotions(env) {
  if (!(await hasPromotionsTable(env))) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT ghl_contact_id, kind, awarded_on, at_class_count, created_at
       FROM promotions ORDER BY created_at ASC, id ASC`,
  ).all();
  const map = new Map();
  for (const r of results) map.set(r.ghl_contact_id, r); // later rows win
  return map;
}

/** Active members with their attended lifetime count. */
export async function membersWithCounts(env) {
  const { results } = await env.DB.prepare(
    `SELECT m.ghl_contact_id, m.first_name, m.last_name, m.programs,
            COUNT(a.id) AS lifetime
       FROM members m
       LEFT JOIN attendance a
         ON a.ghl_contact_id = m.ghl_contact_id AND a.status = 'attended'
      WHERE m.active = 1
      GROUP BY m.ghl_contact_id`,
  ).all();
  return results.map((r) => {
    let programs = [];
    try {
      programs = JSON.parse(r.programs);
    } catch {
      programs = [];
    }
    return { ...r, programs, lifetime: Number(r.lifetime) || 0 };
  });
}

/** The stripe tab's list. Empty when the migration is pending or the feature is off. */
export async function stripeCandidates(env) {
  const cfg = stripeConfig(env);
  if (cfg.programs.length === 0) return { enabled: false, threshold: cfg.threshold, rows: [] };
  if (!(await hasPromotionsTable(env))) {
    return { enabled: false, threshold: cfg.threshold, rows: [], pendingMigration: true };
  }
  const [members, last] = await Promise.all([membersWithCounts(env), lastPromotions(env)]);
  return { enabled: true, threshold: cfg.threshold, rows: eligibleForStripe(members, last, cfg) };
}

/**
 * Record an award. Stores the member's attended count at this moment, which
 * is what the next interval counts from. Returns { ok, ... } or throws with
 * a .status for the router.
 */
export async function recordPromotion(env, schedule, { contactId, kind = 'stripe', note = null, now = new Date() }) {
  if (!KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${KINDS.join(', ')}`), { status: 400 });
  if (!(await hasPromotionsTable(env))) {
    throw Object.assign(new Error('promotions table missing: run src/db/migrations/003_promotions.sql'), { status: 503 });
  }
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM attendance WHERE ghl_contact_id = ? AND status = 'attended'",
  )
    .bind(contactId)
    .first();
  const atClassCount = Number(count?.n ?? 0);
  const awardedOn = localParts(now, env.TZ || schedule.timezone).date;
  const res = await env.DB.prepare(
    'INSERT INTO promotions (ghl_contact_id, kind, awarded_on, at_class_count, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(contactId, kind, awardedOn, atClassCount, note ? String(note).slice(0, 200) : null, now.toISOString())
    .run();
  return { ok: true, id: Number(res.meta?.last_row_id ?? 0), kind, awardedOn, atClassCount };
}

/** Undo the member's most recent award. For a mis-tap at the desk. */
export async function undoLastPromotion(env, contactId) {
  if (!(await hasPromotionsTable(env))) {
    throw Object.assign(new Error('promotions table missing: run src/db/migrations/003_promotions.sql'), { status: 503 });
  }
  const row = await env.DB.prepare(
    'SELECT id, kind, awarded_on FROM promotions WHERE ghl_contact_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  )
    .bind(contactId)
    .first();
  if (!row) return { ok: true, removed: 0 };
  const res = await env.DB.prepare('DELETE FROM promotions WHERE id = ?').bind(row.id).run();
  return { ok: true, removed: Number(res.meta?.changes ?? 0), kind: row.kind, awardedOn: row.awarded_on };
}

/** One member's award history, newest first. */
export async function promotionHistory(env, contactId) {
  if (!(await hasPromotionsTable(env))) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, kind, awarded_on, at_class_count, note FROM promotions
      WHERE ghl_contact_id = ? ORDER BY created_at DESC, id DESC`,
  )
    .bind(contactId)
    .all();
  return results.map((r) => ({ id: r.id, kind: r.kind, awardedOn: r.awarded_on, atClassCount: Number(r.at_class_count), note: r.note }));
}
