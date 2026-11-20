// progress.js — the member progress page (§15.7).
//
// A page a member, or a kid's parent, opens on their own phone: class count,
// recent classes, belt and stripes. Read-only, and nothing about money.
//
// The link carries a token: HMAC-SHA256(ID_SALT, "progress:v1:" + contact id),
// 32 hex characters. It is the same every time, so it can be saved to a home
// screen, and it needs no table. A token is made for a contact, not a member:
// a parent's link shows every kid linked to them (payer_contact_id), and the
// parent too if they train. Changing "v1" below retires every link at once.
//
// The link only ever reaches a phone by text, through the contact's own
// number in GHL. It is never shown on the kiosk, where anyone can tap a name.

import { requireSalt } from './ids.js';
import { hasPayerColumn } from './schema-caps.js';
import { ranksFor } from './promotions.js';
import { localParts } from './time.js';
import { shiftDate, UNSCHEDULED_CLASS } from './classes.js';
import { mondayOf } from './rollup.js';
import { looksLikeContactId } from './waiver.js';
import { podiums } from './board.js';

const enc = new TextEncoder();
const TOKEN_RE = /^[0-9a-f]{32}$/;
const keyCache = new Map();
export const RECENT_CLASSES = 10;
export const MILESTONES = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

/** PROGRESS_PAGE = "off" (or "0") turns the page and its links off. */
export function progressEnabled(env = {}) {
  const v = String(env.PROGRESS_PAGE ?? 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** The GHL custom field the link is written to. Blank: staff can only copy it. */
export function progressFieldKey(env = {}) {
  return progressEnabled(env) ? String(env.PROGRESS_FIELD || '').trim() : '';
}

/** 32 hex chars for a contact id, stable for a given ID_SALT. */
export async function progressToken(contactId, salt) {
  let key = keyCache.get(salt);
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(salt, key);
  }
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`progress:v1:${contactId}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function parsePrograms(raw) {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

async function activeMembers(env) {
  const payer = (await hasPayerColumn(env)) ? ', payer_contact_id' : '';
  const { results } = await env.DB.prepare(
    `SELECT ghl_contact_id, first_name, last_name, programs${payer} FROM members WHERE active = 1`,
  ).all();
  return results.map((r) => ({ ...r, programs: parsePrograms(r.programs), payer_contact_id: r.payer_contact_id || null }));
}

/** The contact a member's link should be made for: their parent if one is linked. */
export function linkContactFor(member) {
  const payer = member.payer_contact_id;
  return payer && payer !== member.ghl_contact_id && looksLikeContactId(payer) ? payer : member.ghl_contact_id;
}

/**
 * Who a token shows: the contact itself if they train, then every member
 * linked to them. Null when the token matches nobody on the roster.
 */
export async function resolveProgress(env, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const salt = requireSalt(env);
  const members = await activeMembers(env);
  const candidates = new Set();
  for (const m of members) {
    candidates.add(m.ghl_contact_id);
    if (m.payer_contact_id && looksLikeContactId(m.payer_contact_id)) candidates.add(m.payer_contact_id);
  }
  let contactId = null;
  for (const id of candidates) {
    if ((await progressToken(id, salt)) === token) {
      contactId = id;
      break;
    }
  }
  if (!contactId) return null;
  const self = members.filter((m) => m.ghl_contact_id === contactId);
  const kids = members
    .filter((m) => m.ghl_contact_id !== contactId && m.payer_contact_id === contactId)
    .sort((a, b) => a.first_name.localeCompare(b.first_name) || a.last_name.localeCompare(b.last_name));
  const people = [...self, ...kids];
  return people.length ? { contactId, people } : null;
}

/**
 * Weeks in a row with at least one class. Counts back from this week, or
 * from last week when this week has no class yet, so a streak does not read
 * as broken on a Monday morning.
 */
export function weekStreak(classDates, today) {
  const weeks = new Set(classDates.map((d) => mondayOf(d)));
  let cursor = mondayOf(today);
  if (!weeks.has(cursor)) cursor = shiftDate(cursor, -7);
  let n = 0;
  while (weeks.has(cursor)) {
    n += 1;
    cursor = shiftDate(cursor, -7);
  }
  return n;
}

export function nextMilestone(lifetime) {
  const at = MILESTONES.find((m) => m > lifetime);
  return at ? { at, toGo: at - lifetime } : null;
}

/** Everything the page shows for one member. No contact ids, nothing about money. */
export async function personProgress(env, schedule, member, rank, now) {
  const today = localParts(now, env.TZ || schedule.timezone).date;
  const { results } = await env.DB.prepare(
    `SELECT class_name, class_start_local FROM attendance
      WHERE ghl_contact_id = ? AND status = 'attended'
      ORDER BY class_start_local DESC, id DESC`,
  ).bind(member.ghl_contact_id).all();
  const dates = results.map((r) => String(r.class_start_local).slice(0, 10));
  const monday = mondayOf(today);
  const since30 = shiftDate(today, -29);
  const lifetime = results.length;
  return {
    first: member.first_name,
    last: member.last_name,
    programLabels: member.programs.filter((p) => schedule.programs[p]).map((p) => schedule.programs[p].label),
    lifetime,
    week: dates.filter((d) => d >= monday && d <= today).length,
    last30: dates.filter((d) => d >= since30 && d <= today).length,
    streakWeeks: weekStreak(dates, today),
    nextMilestone: nextMilestone(lifetime),
    rank: rank ? { belt: rank.belt, label: rank.label, stripes: rank.stripes, colours: rank.colours || null } : null,
    recent: results.slice(0, RECENT_CLASSES).map((r) => ({
      date: String(r.class_start_local).slice(0, 10),
      className: r.class_name === UNSCHEDULED_CLASS ? 'Open mat' : r.class_name,
      start: r.class_name === UNSCHEDULED_CLASS ? null : String(r.class_start_local).slice(11),
    })),
  };
}

/** The whole page for a token, or null. */
export async function progressPage(env, schedule, token, now) {
  if (!progressEnabled(env)) return null;
  const found = await resolveProgress(env, token);
  if (!found) return null;
  const ranks = await ranksFor(env, found.people);
  const people = [];
  for (const m of found.people) people.push(await personProgress(env, schedule, m, ranks.get(m.ghl_contact_id) || null, now));
  // The month's podium (§15.13). It is an extra: if it cannot be read, the
  // member's own page still loads.
  let boards = [];
  try {
    boards = await podiums(env, schedule, found.people, now);
  } catch (e) {
    console.warn(`podium unavailable: ${e && e.message ? e.message : e}`);
  }
  return { ok: true, today: localParts(now, env.TZ || schedule.timezone).date, people, boards };
}

/**
 * The link for one member, for the staff screen: the parent's link when a
 * parent is linked, so one link covers the family.
 */
export async function progressLinkFor(env, member, origin) {
  const target = linkContactFor(member);
  const token = await progressToken(target, requireSalt(env));
  return { url: `${origin}/me?t=${token}`, contactId: target, to: target === member.ghl_contact_id ? 'member' : 'parent' };
}

/**
 * Write the link to the contact's PROGRESS_FIELD, with the allowed contact
 * write. A GHL workflow on that field does the texting (the §15.1 pattern).
 * The day on the end makes the value change once a day, so a second send on
 * another day fires the workflow again; `resend` adds the minute, for staff.
 * Never throws: { ok, reason }.
 */
export async function writeProgressLink(env, deps, contactId, url, now = new Date(), { resend = false } = {}) {
  const key = progressFieldKey(env);
  if (!key) return { ok: false, reason: 'PROGRESS_FIELD is not set' };
  try {
    const fields = await deps.getFieldIds(now);
    const id = fields.get(key);
    if (!id) return { ok: false, reason: `custom field ${key} not found in GHL` };
    const local = localParts(now, env.TZ || 'America/New_York');
    const day = local.date.replace(/-/g, '');
    // Staff can send again the same day (resend): the minute goes on too.
    // A member asking for their own link gets one text a day at most, so the
    // public button cannot be used to flood a phone.
    const stamp = resend ? `${day}&s=${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}` : day;
    await deps.putContact(contactId, [{ id, field_value: `${url}&d=${stamp}` }]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}
