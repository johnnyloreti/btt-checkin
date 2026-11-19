// promotions.js — stripe tracking (§15.2) and belts (§15.4).
//
// The tab surfaces who has crossed a threshold. It never says a promotion is
// owed: class count is one input, the instructor decides. Wording in the UI
// is "eligible for review", never "due". Kids one class short are listed
// separately as a heads-up, with no way to record from that list.
//
// Eligibility is attended classes since the member's most recent recorded
// promotion, or all attended classes if they have none.

import { parseList } from './roster.js';
import { hasPromotionsTable, hasBeltColumns } from './schema-caps.js';
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

// ---------- belts (§15.4) ----------
// IBJJF order. The first belt in a list is what a member holds until a belt
// is recorded for them. Both lists are config (BELTS_KIDS, BELTS_ADULT), so a
// different system is an edit and a deploy, not a code change.
export const DEFAULT_BELTS_KIDS = [
  'white',
  'grey-white', 'grey', 'grey-black',
  'yellow-white', 'yellow', 'yellow-black',
  'orange-white', 'orange', 'orange-black',
  'green-white', 'green', 'green-black',
];
export const DEFAULT_BELTS_ADULT = ['white', 'blue', 'purple', 'brown', 'black'];
export const MAX_STRIPES = 12;

/** The two belt lists. An unset var uses the default; a blank one is empty. */
export function beltConfig(env = {}) {
  const list = (raw, fallback) => (raw === undefined || raw === null ? fallback : parseList(raw));
  return {
    kids: list(env.BELTS_KIDS, DEFAULT_BELTS_KIDS),
    adult: list(env.BELTS_ADULT, DEFAULT_BELTS_ADULT),
    kidsMonthly: kidsStripesMonthly(env),
  };
}

// ---------- kids' coloured stripes (§15.12) ----------
// The IBJJF monthly system, which this gym follows for kids (Johnny,
// 2026-11-19): eleven degrees on each kids belt, and the twelfth is the next
// belt. The belt never carries more than four stripes; the colours say which
// degree it is.
//    1 to 4   white stripes, one more each time
//    5 to 8   a red stripe takes the place of a white one each time
//    9 to 11  a yellow stripe takes the place of a red one each time
// So degree 6 is two red and two white, and degree 11 is three yellow and
// one red. Adults are untouched: plain stripes, as before.
export const KIDS_DEGREES = 11;

/** KIDS_STRIPES = "plain" (or "off") keeps kids on plain stripes. Anything else is the monthly system. */
export function kidsStripesMonthly(env = {}) {
  const v = String(env.KIDS_STRIPES ?? 'ibjjf-monthly').trim().toLowerCase();
  return v !== 'plain' && v !== 'off' && v !== '0' && v !== 'false';
}

/** The stripes on the belt for a degree, as colours, newest colour first. */
export function degreeStripes(degree) {
  const d = Math.max(0, Math.min(KIDS_DEGREES, Math.floor(Number(degree) || 0)));
  if (d <= 4) return Array(d).fill('white');
  if (d <= 8) return [...Array(d - 4).fill('red'), ...Array(8 - d).fill('white')];
  return [...Array(d - 8).fill('yellow'), ...Array(12 - d).fill('red')];
}

/** "2 red, 2 white" for a degree; '' for none. */
export function degreeText(degree) {
  const counts = new Map();
  for (const c of degreeStripes(degree)) counts.set(c, (counts.get(c) || 0) + 1);
  return [...counts].map(([c, n]) => `${n} ${c}`).join(', ');
}

/** True when this member's rank runs on the kids' monthly degrees. */
function onKidsDegrees(programs, belt, cfg) {
  if (!cfg.kidsMonthly || !belt) return false;
  const kid = (Array.isArray(programs) ? programs : []).some((p) => String(p).toLowerCase().startsWith('kids-'));
  return kid && cfg.kids.includes(belt);
}

/** Both lists blank turns belt tracking off. */
export function beltsEnabled(env) {
  const cfg = beltConfig(env);
  return cfg.kids.length + cfg.adult.length > 0;
}

/** "grey-white" reads "Grey-white". */
export function beltLabel(key) {
  const k = String(key || '');
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : '';
}

/**
 * The belts on offer for a member: the kids list for a kids program, the
 * adult list for anyone else, both for a member in both.
 */
export function beltOptionsFor(programs, cfg) {
  const list = Array.isArray(programs) ? programs.map((p) => String(p).toLowerCase()) : [];
  const kid = list.some((p) => p.startsWith('kids-'));
  const adult = list.some((p) => !p.startsWith('kids-')) || !kid;
  const out = [];
  for (const b of [...(kid ? cfg.kids : []), ...(adult ? cfg.adult : [])]) if (!out.includes(b)) out.push(b);
  return out;
}

/**
 * A member's rank from their promotions, oldest first. A belt row sets the
 * belt and the stripes already on it; each stripe row after it adds one.
 * `recorded` is false while the belt is only the assumed first one.
 */
export function rankFrom(promos, programs, cfg) {
  const options = beltOptionsFor(programs, cfg);
  let belt = options[0] || null;
  let stripes = 0;
  let recorded = false;
  for (const p of promos || []) {
    if (p.kind === 'belt') {
      if (p.belt) {
        belt = String(p.belt);
        recorded = true;
      }
      stripes = Math.max(0, Number(p.stripes) || 0);
    } else if (p.kind === 'stripe') {
      stripes += 1;
    }
  }
  if (!belt) return null;
  const rank = { belt, label: `${beltLabel(belt)} belt`, stripes, recorded };
  if (onKidsDegrees(programs, belt, cfg)) {
    // Kids (§15.12): the colours on the belt, and what comes after the
    // eleventh degree. `stripes` stays the true count, even past eleven.
    const next = cfg.kids[cfg.kids.indexOf(belt) + 1] || null;
    Object.assign(rank, {
      maxStripes: KIDS_DEGREES,
      colours: degreeStripes(stripes),
      coloursText: degreeText(stripes),
      full: stripes >= KIDS_DEGREES,
      nextBelt: next,
      nextLabel: next ? `${beltLabel(next)} belt` : null,
    });
  }
  return rank;
}

/** Whether rank can be shown at all: feature on, table and columns present. */
export async function beltsReady(env) {
  return beltsEnabled(env) && (await hasPromotionsTable(env)) && (await hasBeltColumns(env));
}

/**
 * Rank for each member given, as a Map by contact id. Empty when belts are
 * off or migration 006 is pending, so callers simply show nothing.
 *
 * members: [{ ghl_contact_id, programs: [key] }]
 */
export async function ranksFor(env, members) {
  const out = new Map();
  if (!members.length || !(await beltsReady(env))) return out;
  const cfg = beltConfig(env);
  const ids = [...new Set(members.map((m) => m.ghl_contact_id))];
  const byContact = new Map(ids.map((id) => [id, []]));
  // D1 caps bound parameters at 100 a statement.
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const { results } = await env.DB.prepare(
      `SELECT ghl_contact_id, kind, belt, stripes FROM promotions
        WHERE ghl_contact_id IN (${chunk.map(() => '?').join(', ')})
        ORDER BY created_at ASC, id ASC`,
    ).bind(...chunk).all();
    for (const r of results) byContact.get(r.ghl_contact_id).push(r);
  }
  for (const m of members) out.set(m.ghl_contact_id, rankFrom(byContact.get(m.ghl_contact_id), m.programs, cfg));
  return out;
}

/**
 * Who is eligible, most overdue first.
 *
 * members: [{ ghl_contact_id, first_name, last_name, programs: [key], lifetime }]
 * lastByContact: Map<contactId, { at_class_count, awarded_on, kind }>
 */
export function eligibleForStripe(members, lastByContact, cfg) {
  const rows = countSince(members, lastByContact, cfg).filter((r) => r.since >= cfg.threshold);
  for (const r of rows) {
    // 22 classes past a 7-class threshold is worth three, which staff
    // should see rather than having to divide in their head.
    r.worth = Math.floor(r.since / cfg.threshold);
  }
  rows.sort((a, b) => b.since - a.since || a.first.localeCompare(b.first));
  return rows;
}

/**
 * Who is one class short, so staff can see in the morning who would cross
 * the threshold at tonight's class (Johnny, 2026-10-27). A heads-up only:
 * the UI offers no record button on these rows. Once the next check-in
 * lands they move to the eligible list by themselves. A threshold of 1 has
 * no "one away".
 */
export function upNextForStripe(members, lastByContact, cfg) {
  if (cfg.threshold < 2) return [];
  const rows = countSince(members, lastByContact, cfg).filter((r) => r.since === cfg.threshold - 1);
  rows.sort((a, b) => a.first.localeCompare(b.first) || a.last.localeCompare(b.last));
  return rows;
}

// Classes since the last award for every member in a covered program.
// A promotion recorded and then attendance voided can leave lifetime below
// the count at award time; that clamps to zero rather than going negative.
function countSince(members, lastByContact, cfg) {
  if (cfg.programs.length === 0) return [];
  const rows = [];
  for (const m of members) {
    const programs = Array.isArray(m.programs) ? m.programs : [];
    if (!programs.some((p) => cfg.programs.includes(String(p).toLowerCase()))) continue;
    const last = lastByContact.get(m.ghl_contact_id) || null;
    const base = last ? Number(last.at_class_count) || 0 : 0;
    rows.push({
      ghl_contact_id: m.ghl_contact_id,
      first: m.first_name,
      last: m.last_name,
      programs,
      lifetime: Number(m.lifetime || 0),
      since: Math.max(0, Number(m.lifetime || 0) - base),
      lastAwardedOn: last ? last.awarded_on : null,
      lastKind: last ? last.kind : null,
    });
  }
  return rows;
}

/**
 * Most recent award per contact, as a Map. A row that only set a rank the
 * member already held (starting = 1, §15.4) is not an award and is skipped,
 * so it never moves the class count toward the next stripe.
 */
export async function lastPromotions(env) {
  if (!(await hasPromotionsTable(env))) return new Map();
  const awards = (await hasBeltColumns(env)) ? 'WHERE starting = 0' : '';
  const { results } = await env.DB.prepare(
    `SELECT ghl_contact_id, kind, awarded_on, at_class_count, created_at
       FROM promotions ${awards} ORDER BY created_at ASC, id ASC`,
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
  if (cfg.programs.length === 0) return { enabled: false, threshold: cfg.threshold, rows: [], upNext: [] };
  if (!(await hasPromotionsTable(env))) {
    return { enabled: false, threshold: cfg.threshold, rows: [], upNext: [], pendingMigration: true };
  }
  const [members, last] = await Promise.all([membersWithCounts(env), lastPromotions(env)]);
  const rows = eligibleForStripe(members, last, cfg);
  const upNext = upNextForStripe(members, last, cfg);
  // Rank beside the count (§15.4), so a kid on four stripes reads as such.
  const ranks = await ranksFor(env, [...rows, ...upNext]);
  for (const r of [...rows, ...upNext]) r.rank = ranks.get(r.ghl_contact_id) || null;
  return { enabled: true, threshold: cfg.threshold, rows, upNext };
}

/**
 * Record an award. Stores the member's attended count at this moment, which
 * is what the next interval counts from. Returns { ok, ... } or throws with
 * a .status for the router.
 *
 * A belt row (§15.4) also carries the belt, the stripes already on it, and
 * `starting` for a rank the member held before it was recorded here.
 */
export async function recordPromotion(env, schedule, { contactId, kind = 'stripe', note = null, belt = null, stripes = 0, starting = false, programs = [], now = new Date() }) {
  if (!KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${KINDS.join(', ')}`), { status: 400 });
  if (!(await hasPromotionsTable(env))) {
    throw Object.assign(new Error('promotions table missing: run src/db/migrations/003_promotions.sql'), { status: 503 });
  }
  const isBelt = kind === 'belt';
  let beltKey = null;
  let onBelt = 0;
  if (isBelt) {
    if (!(await hasBeltColumns(env))) {
      throw Object.assign(new Error('belt columns missing: run src/db/migrations/006_belts.sql'), { status: 503 });
    }
    const cfg = beltConfig(env);
    beltKey = String(belt || '').trim().toLowerCase();
    if (![...cfg.kids, ...cfg.adult].includes(beltKey)) throw Object.assign(new Error('unknown belt'), { status: 400 });
    onBelt = Number(stripes ?? 0);
    const most = onKidsDegrees(programs, beltKey, cfg) ? KIDS_DEGREES : MAX_STRIPES;
    if (!Number.isInteger(onBelt) || onBelt < 0 || onBelt > most) {
      throw Object.assign(new Error(`stripes must be a whole number from 0 to ${most}`), { status: 400 });
    }
  } else if (await hasBeltColumns(env)) {
    // A kid on eleven stripes has nowhere to put a twelfth (§15.12): the
    // next step is the belt, which staff record as a belt.
    const rank = (await ranksFor(env, [{ ghl_contact_id: contactId, programs }])).get(contactId);
    if (rank && rank.full) {
      const what = rank.nextLabel ? `the next step is the ${rank.nextLabel}` : 'that is the top of the kids belts';
      throw Object.assign(new Error(`already on ${KIDS_DEGREES} stripes: ${what}`), { status: 409 });
    }
  }
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM attendance WHERE ghl_contact_id = ? AND status = 'attended'",
  )
    .bind(contactId)
    .first();
  const atClassCount = Number(count?.n ?? 0);
  const awardedOn = localParts(now, env.TZ || schedule.timezone).date;
  const cleanNote = note ? String(note).slice(0, 200) : null;
  const res = isBelt
    ? await env.DB.prepare(
      'INSERT INTO promotions (ghl_contact_id, kind, awarded_on, at_class_count, note, created_at, belt, stripes, starting) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(contactId, kind, awardedOn, atClassCount, cleanNote, now.toISOString(), beltKey, onBelt, starting ? 1 : 0)
      .run()
    : await env.DB.prepare(
      'INSERT INTO promotions (ghl_contact_id, kind, awarded_on, at_class_count, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(contactId, kind, awardedOn, atClassCount, cleanNote, now.toISOString())
      .run();
  const out = { ok: true, id: Number(res.meta?.last_row_id ?? 0), kind, awardedOn, atClassCount };
  if (isBelt) Object.assign(out, { belt: beltKey, stripes: onBelt, starting: Boolean(starting) });
  return out;
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
  const belts = await hasBeltColumns(env);
  const { results } = await env.DB.prepare(
    `SELECT id, kind, awarded_on, at_class_count, note${belts ? ', belt, stripes, starting' : ''} FROM promotions
      WHERE ghl_contact_id = ? ORDER BY created_at DESC, id DESC`,
  )
    .bind(contactId)
    .all();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    awardedOn: r.awarded_on,
    atClassCount: Number(r.at_class_count),
    note: r.note,
    belt: belts && r.belt ? r.belt : null,
    beltLabel: belts && r.belt ? `${beltLabel(r.belt)} belt` : null,
    stripes: belts ? Number(r.stripes) || 0 : 0,
    starting: belts ? Number(r.starting) === 1 : false,
  }));
}

/**
 * What the member screen needs for rank: the current rank and the belts on
 * offer. `enabled: false` hides the whole block (feature off, or migration
 * 006 pending).
 */
export async function memberRank(env, member) {
  if (!(await beltsReady(env))) return { enabled: false };
  let programs = [];
  try {
    programs = JSON.parse(member.programs);
  } catch {
    programs = [];
  }
  const cfg = beltConfig(env);
  const ranks = await ranksFor(env, [{ ghl_contact_id: member.ghl_contact_id, programs }]);
  const rank = ranks.get(member.ghl_contact_id) || null;
  const options = beltOptionsFor(programs, cfg);
  // The stripes the form offers. For a kid on the monthly degrees (§15.12):
  // none to eleven, each named by its colours. Otherwise null, and the page
  // offers plain stripes as before.
  const kid = options.some((key) => onKidsDegrees(programs, key, cfg));
  const stripeOptions = kid
    ? Array.from({ length: KIDS_DEGREES + 1 }, (_, i) => ({
      value: i,
      label: i === 0 ? 'No stripes' : `${i} stripe${i === 1 ? '' : 's'} (${degreeText(i)})`,
    }))
    : null;
  return {
    enabled: true,
    rank,
    options: options.map((key) => ({ key, label: `${beltLabel(key)} belt` })),
    maxStripes: kid ? KIDS_DEGREES : MAX_STRIPES,
    stripeOptions,
  };
}
