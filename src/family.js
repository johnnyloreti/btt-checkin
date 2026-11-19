// family.js — the Family box on the staff member screen (§15.10).
//
// One household at a glance: a parent and the kids linked to them, with each
// one's program, rank, waiver and how lately they have been in. Read-only,
// staff-only, no GHL call, no table of its own. It is built from the same
// parent link the waiver reminder and the progress page use
// (members.payer_contact_id, §15.1).
//
// A household is everyone who shares an account: the account holder if they
// train here, and every member whose payer is that contact. A parent who
// does not train is not in the members table (§6, program:none), so D1 has
// no name for them; the box says a parent is on file and stops there.
//
// Off unless FAMILY_VIEW is "on". Family view is on the V2 list (§10), so it
// ships switched off until Johnny says to turn it on.

import { hasPayerColumn, hasWaiverColumn } from './schema-caps.js';
import { ranksFor } from './promotions.js';
import { linkContactFor } from './progress.js';
import { waiverEnabled } from './waiver.js';
import { localParts } from './time.js';
import { shiftDate } from './classes.js';
import { opaqueId, requireSalt } from './ids.js';

export const MAX_HOUSEHOLD = 30; // far past any family; keeps one query's bound values small

/** FAMILY_VIEW = "on" (or "1", "true") turns the box on. Anything else is off. */
export function familyEnabled(env = {}) {
  const v = String(env.FAMILY_VIEW ?? '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

function parsePrograms(raw) {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

/**
 * The household of one member, for the staff member screen.
 *
 * { enabled: false }                         switched off, or migration 005 pending
 * { enabled: true, parent, people: [...] }   people is empty when the member is alone
 *
 * parent: 'trains'   the account holder is a member, and is in the list
 *         'on_file'  a parent is linked but does not train here (no name in D1)
 *         'none'     nobody is linked
 * Each person: { id (opaque), first, last, programLabels, active, waiver,
 *   rank, lifetime, last30, lastClass, self, parent }. Never a contact id.
 */
export async function household(env, schedule, member, now = new Date()) {
  if (!familyEnabled(env) || !(await hasPayerColumn(env))) return { enabled: false };
  const head = linkContactFor(member);
  const waiverCol = (await hasWaiverColumn(env)) ? ', waiver' : '';
  const { results } = await env.DB.prepare(
    `SELECT ghl_contact_id, first_name, last_name, programs, active, payer_contact_id${waiverCol}
       FROM members WHERE ghl_contact_id = ? OR payer_contact_id = ?
      ORDER BY first_name, last_name LIMIT ?`,
  ).bind(head, head, MAX_HOUSEHOLD).all();
  const rows = results.map((r) => ({ ...r, programs: parsePrograms(r.programs) }));
  const headTrains = rows.some((r) => r.ghl_contact_id === head && rows.some((k) => k.payer_contact_id === head && k.ghl_contact_id !== head));
  const linked = rows.some((r) => r.payer_contact_id === head && r.ghl_contact_id !== head);
  const parent = headTrains ? 'trains' : linked ? 'on_file' : 'none';
  if (rows.length <= 1) return { enabled: true, parent, people: [] };

  const today = localParts(now, env.TZ || schedule.timezone).date;
  const since30 = `${shiftDate(today, -29)}T00:00`;
  const ids = rows.map((r) => r.ghl_contact_id);
  const [{ results: att }, ranks] = await Promise.all([
    env.DB.prepare(
      `SELECT ghl_contact_id, COUNT(*) AS lifetime, MAX(class_start_local) AS last,
              SUM(CASE WHEN class_start_local >= ? THEN 1 ELSE 0 END) AS last30
         FROM attendance WHERE status = 'attended' AND ghl_contact_id IN (${ids.map(() => '?').join(', ')})
        GROUP BY ghl_contact_id`,
    ).bind(since30, ...ids).all(),
    ranksFor(env, rows),
  ]);
  const seen = new Map(att.map((a) => [a.ghl_contact_id, a]));
  const salt = requireSalt(env);
  const showWaiver = waiverEnabled(env) && Boolean(waiverCol);

  // The parent first, then the kids by first name.
  rows.sort((a, b) => Number(b.ghl_contact_id === head) - Number(a.ghl_contact_id === head));
  const people = [];
  for (const r of rows) {
    const a = seen.get(r.ghl_contact_id);
    const rank = ranks.get(r.ghl_contact_id) || null;
    people.push({
      id: await opaqueId(r.ghl_contact_id, salt),
      first: r.first_name,
      last: r.last_name || '',
      programLabels: r.programs.filter((p) => schedule.programs[p]).map((p) => schedule.programs[p].label),
      active: Number(r.active) === 1,
      waiver: showWaiver ? Number(r.waiver ?? 1) === 1 : null,
      rank: rank ? { label: rank.label, stripes: rank.stripes, coloursText: rank.coloursText || '' } : null,
      lifetime: Number(a?.lifetime ?? 0),
      last30: Number(a?.last30 ?? 0),
      lastClass: a?.last ? String(a.last).slice(0, 10) : null,
      self: r.ghl_contact_id === member.ghl_contact_id,
      parent: headTrains && r.ghl_contact_id === head,
    });
  }
  return { enabled: true, parent, people };
}
