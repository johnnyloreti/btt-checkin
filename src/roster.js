// roster.js — turn GHL contacts into the members table.
// Rules from §6. Pure functions first, then the sync that touches D1.

import { hasWaiverColumn, hasPayerColumn } from './schema-caps.js';
import { checkRequiredFields } from './fields.js';
import { getFieldIds } from './rollup.js';
import { payerFieldKey, looksLikeContactId } from './waiver.js';

/**
 * A contact with this tag is a paying family member who does not train:
 * founding-member for billing, but never a kiosk tile. Added 2026-09-07.
 */
export const NOT_A_STUDENT_TAG = 'program:none';

/** Every program tag starts with this. Used to spot typos. */
export const PROGRAM_TAG_PREFIX = 'program:';

/** Parse a comma-separated env var into trimmed lowercase entries. */
export function parseList(str) {
  return String(str || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Build the classification config from env + schedule.
 * programTagMap: lowercase tag → program key, in schedule order.
 */
export function rosterConfig(env, schedule) {
  const programTagMap = new Map();
  for (const [key, p] of Object.entries(schedule.programs)) {
    programTagMap.set(p.tag.toLowerCase(), key);
  }
  return {
    memberTags: parseList(env.MEMBER_TAGS),
    memberTagPrefixes: parseList(env.MEMBER_TAG_PREFIXES),
    programTagMap,
    // §15.1: empty means the waiver feature is off and everyone counts as signed.
    waiverTag: String(env.WAIVER_TAG || '').trim().toLowerCase(),
  };
}

function normTags(contact) {
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
}

/**
 * Classify one contact.
 * Returns { isMember, programs, flag, notStudent } where flag is a short
 * reason string (or null) that the sync writes into sync_log detail by name.
 *
 * A contact is a member when it carries any of:
 *  - a program tag from schedule.json (program:kids-6-9 etc.), since anyone
 *    in a program trains (Johnny, 2026-09-07)
 *  - an exact member tag (founding-member)
 *  - a member prefix tag (foundations-*)
 * program:none overrides everything: a paying non-student, never a tile.
 */
export function classifyContact(contact, cfg) {
  const tags = normTags(contact);
  const hasExact = tags.some((t) => cfg.memberTags.includes(t));
  const hasPrefix = tags.some((t) => cfg.memberTagPrefixes.some((p) => t.startsWith(p)));

  // Programs in schedule order so output is stable regardless of tag order.
  const programs = [];
  for (const [tag, key] of cfg.programTagMap) {
    if (tags.includes(tag) && !programs.includes(key)) programs.push(key);
  }
  const unknown = tags.filter((t) => t.startsWith(PROGRAM_TAG_PREFIX) && t !== NOT_A_STUDENT_TAG && !cfg.programTagMap.has(t));
  const unknownFlag = unknown.length ? `unknown program tag ${unknown.join(', ')}` : null;

  const isMember = hasExact || hasPrefix || programs.length > 0;
  if (!isMember) return { isMember: false, programs: [], flag: unknownFlag };
  if (tags.includes(NOT_A_STUDENT_TAG)) return { isMember: false, notStudent: true, programs: [], flag: null };

  const waiver = !cfg.waiverTag || tags.includes(cfg.waiverTag);

  if (programs.length > 0) return { isMember: true, programs, waiver, flag: unknownFlag };

  // No usable program tag. Foundations is the adult program, so that is silent
  // unless the tag looks like a typo.
  if (hasPrefix) return { isMember: true, programs: ['adult'], waiver, flag: unknownFlag };
  // Founding members include kids; default to adult and say so.
  return { isMember: true, programs: ['adult'], waiver, flag: unknownFlag || 'no program tag, defaulted to adult' };
}

/**
 * GHL often stores names typed in lowercase on a form. When a name has no
 * capital letters at all, capitalize each word so the tile reads
 * "Nicolas Mendes". Names with any capitals are left exactly as entered,
 * so McDonald, da Silva, and DeLuca survive.
 */
export function tidyName(name) {
  const s = String(name || '').trim().replace(/\s+/g, ' ');
  if (!s || /[A-ZÀ-ÖØ-Þ]/.test(s)) return s;
  return s.replace(/(^|[\s'-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

/**
 * One custom field's value on a contact from GET /contacts/, or null.
 * Read tolerantly: the list carries `customFields` (or `customField` on
 * older shapes) as [{ id, value }], and the value key has varied.
 */
export function contactFieldValue(contact, fieldId) {
  if (!contact || !fieldId) return null;
  const list = Array.isArray(contact.customFields) ? contact.customFields : Array.isArray(contact.customField) ? contact.customField : [];
  const hit = list.find((f) => f && String(f.id) === String(fieldId));
  if (!hit) return null;
  const v = hit.value ?? hit.field_value ?? hit.fieldValue ?? null;
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s || null;
}

/** True when a contact came back with a custom-field list at all. */
function carriesFields(contact) {
  return Boolean(contact) && (Array.isArray(contact.customFields) || Array.isArray(contact.customField));
}

function displayName(contact) {
  const first = tidyName(contact.firstName);
  const last = tidyName(contact.lastName);
  return `${first} ${last}`.trim() || contact.contactName || contact.email || contact.id || '(unknown)';
}

/**
 * Build the member list from a page of contacts.
 * Returns { members, flagged, notStudents } where flagged is
 * [{ id, name, reason }] and notStudents is the contact ids tagged
 * program:none, which the sync removes from the table if present.
 */
export function buildRoster(contacts, cfg) {
  const members = [];
  const flagged = [];
  const notStudents = [];
  for (const c of contacts) {
    if (!c || !c.id) continue;
    const { isMember, programs, flag, notStudent, waiver } = classifyContact(c, cfg);
    if (notStudent) notStudents.push(c.id);
    if (!isMember) {
      if (flag) flagged.push({ id: c.id, name: displayName(c), reason: flag });
      continue;
    }
    const first = tidyName(c.firstName);
    const last = tidyName(c.lastName);
    if (!first) {
      flagged.push({ id: c.id, name: displayName(c), reason: 'no first name, skipped' });
      continue;
    }
    if (flag) flagged.push({ id: c.id, name: displayName(c), reason: flag });
    // §15.3 Phase 1b: who pays for this member, when the btt-ops side has
    // linked one. A value that is not a contact id is flagged, not used.
    let payer = null;
    if (cfg.payerFieldId) {
      const raw = contactFieldValue(c, cfg.payerFieldId);
      if (raw && looksLikeContactId(raw) && raw !== c.id) payer = raw;
      else if (raw && raw !== c.id) flagged.push({ id: c.id, name: displayName(c), reason: `payer link is not a contact id: ${raw.slice(0, 40)}` });
    }
    members.push({ ghl_contact_id: c.id, first_name: first, last_name: last, programs, waiver: waiver ? 1 : 0, payer_contact_id: payer });
  }
  return { members, flagged, notStudents };
}

/**
 * How many members have a payer linked, and which kids do not. Kids are the
 * members in a kids-* program; a kid without a payer gets reminders on their
 * own contact, which is usually unreachable. `field` says whether the links
 * were read this run: 'ok', 'off', 'missing in GHL', or 'unreadable: why'.
 * When they were not read, the counts are null rather than zero (§0.6).
 */
export function payerLinksDetail(state, members, written) {
  if (state !== 'ok') return { field: state, stored: false, linked: null, kidsWithout: null, kidsWithoutNames: null };
  const kids = members.filter((m) => m.programs.some((p) => p.startsWith('kids-')));
  const without = kids.filter((m) => !m.payer_contact_id);
  return {
    field: 'ok',
    stored: written,
    linked: members.filter((m) => m.payer_contact_id).length,
    kids: kids.length,
    kidsWithout: without.length,
    kidsWithoutNames: without.slice(0, 10).map((m) => `${m.first_name} ${m.last_name}`.trim()),
  };
}

async function logSync(db, job, ranAt, outcome, detail) {
  await db
    .prepare('INSERT INTO sync_log (job, ran_at, outcome, detail) VALUES (?, ?, ?, ?)')
    .bind(job, ranAt, outcome, JSON.stringify(detail))
    .run();
}

/**
 * Run one roster sync. Never throws; every path writes a sync_log row.
 *
 * deps.fetchContacts: () => Promise<{ contacts, pages }>
 * deps.fetchFields:   () => Promise<Map<key, id>>, optional. When given, the
 *                     run also checks that every custom field the Worker
 *                     writes exists in GHL (fields.js) and goes degraded
 *                     naming any that are missing. Production always passes
 *                     it; a missing field is otherwise invisible.
 * deps.now: Date
 *
 * deps.fetchContacts: () => Promise<{ contacts, pages }>
 * deps.now: Date
 *
 * Outcomes:
 *  - ok:       members written; contacts that lost their tags set active=0
 *  - degraded: zero members came back; table untouched (§6 emptiness guard)
 *  - failed:   GHL or D1 error; table untouched
 */
export async function syncRoster(env, schedule, deps) {
  const db = env.DB;
  const now = deps.now || new Date();
  const ranAt = now.toISOString();
  const cfg = rosterConfig(env, schedule);

  let fetched;
  try {
    fetched = await deps.fetchContacts();
  } catch (e) {
    const detail = { error: String(e && e.message ? e.message : e) };
    await logSync(db, 'roster', ranAt, 'failed', detail);
    return { outcome: 'failed', ...detail };
  }

  const contacts = fetched.contacts || [];

  // §15.3 Phase 1b: the payer link lives in a contact custom field. Its id
  // comes from the same cached field list the field check uses. Links are
  // written only when they could actually be read: a field GHL does not
  // have, a field list that could not be fetched, or a contact list that
  // carries no custom fields at all leaves every existing link as it was,
  // rather than wiping them all to "no payer".
  const payerKey = payerFieldKey(env);
  let payerState = payerKey ? 'unreadable' : 'off';
  if (payerKey && deps.fetchFields) {
    try {
      const fieldMap = await getFieldIds(deps.fetchFields, now);
      const id = fieldMap.get(payerKey);
      if (!id) payerState = 'missing in GHL';
      else if (!contacts.some(carriesFields)) payerState = 'unreadable: the contact list carries no custom fields';
      else { payerState = 'ok'; cfg.payerFieldId = id; }
    } catch (e) {
      payerState = `unreadable: ${String(e && e.message ? e.message : e)}`;
    }
  }
  const { members, flagged, notStudents } = buildRoster(contacts, cfg);

  if (members.length === 0) {
    const detail = {
      reason: 'zero members returned, roster left untouched',
      contacts: contacts.length,
      pages: fetched.pages || 0,
    };
    await logSync(db, 'roster', ranAt, 'degraded', detail);
    return { outcome: 'degraded', ...detail };
  }

  try {
    // waiver and payer_contact_id are optional until their migrations run
    // (see schema-caps.js); payer is also left alone when it was unreadable.
    const withWaiver = await hasWaiverColumn(env);
    const withPayer = payerState === 'ok' && (await hasPayerColumn(env));
    const cols = ['ghl_contact_id', 'first_name', 'last_name', 'programs', 'synced_at'];
    if (withWaiver) cols.push('waiver');
    if (withPayer) cols.push('payer_contact_id');
    const updates = cols.filter((c) => c !== 'ghl_contact_id').map((c) => `${c} = excluded.${c}`);
    const upsert = db.prepare(
      `INSERT INTO members (${cols.join(', ')}, active)
       VALUES (${cols.map(() => '?').join(', ')}, 1)
       ON CONFLICT(ghl_contact_id) DO UPDATE SET ${updates.join(', ')}, active = 1`,
    );
    const stmts = members.map((m) => {
      const vals = [m.ghl_contact_id, m.first_name, m.last_name, JSON.stringify(m.programs), ranAt];
      if (withWaiver) vals.push(m.waiver);
      if (withPayer) vals.push(m.payer_contact_id);
      return upsert.bind(...vals);
    });
    // Anyone not touched this run has lost their member tags.
    stmts.push(db.prepare('UPDATE members SET active = 0 WHERE synced_at <> ? AND active = 1').bind(ranAt));
    const deactivateIdx = stmts.length - 1;
    // program:none is a paying non-student: never a tile, so not a members row.
    // Their attendance, if any, stays.
    for (const id of notStudents) stmts.push(db.prepare('DELETE FROM members WHERE ghl_contact_id = ?').bind(id));
    const results = await db.batch(stmts);
    const deactivated = results[deactivateIdx]?.meta?.changes ?? null;
    const removed = results.slice(deactivateIdx + 1).reduce((n, r) => n + Number(r?.meta?.changes ?? 0), 0);

    const detail = {
      members: members.length,
      contacts: contacts.length,
      pages: fetched.pages || 0,
      deactivated,
      notStudents: notStudents.length,
      removed,
      waiverMissing: cfg.waiverTag ? members.filter((m) => !m.waiver).length : null,
      payerLinks: payerLinksDetail(payerState, members, withPayer),
      flagged: flagged.map((f) => `${f.name}: ${f.reason}`),
    };

    // Every field the Worker writes must exist, or the writes land on
    // nothing. Checked here because this job already runs every 30 minutes.
    // Not checking is reported as such, never as ok (§0.6).
    let outcome = 'ok';
    if (deps.fetchFields) {
      try {
        const { missing } = await checkRequiredFields(env, deps.fetchFields, now);
        detail.missingFields = missing;
        if (missing.length) outcome = 'degraded';
      } catch (e) {
        detail.missingFields = null;
        detail.fieldCheck = `error: ${String(e && e.message ? e.message : e)}`;
        outcome = 'degraded';
      }
    } else {
      detail.missingFields = null;
      detail.fieldCheck = 'skipped';
    }
    await logSync(db, 'roster', ranAt, outcome, detail);
    return { outcome, ...detail };
  } catch (e) {
    const detail = { error: `d1: ${String(e && e.message ? e.message : e)}` };
    await logSync(db, 'roster', ranAt, 'failed', detail).catch(() => {});
    return { outcome: 'failed', ...detail };
  }
}
