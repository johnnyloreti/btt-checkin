// roster.js — turn GHL contacts into the members table.
// Rules from §6. Pure functions first, then the sync that touches D1.

/**
 * A contact with this tag is a paying family member who does not train:
 * founding-member for billing, but never a kiosk tile. Added 2026-09-07.
 */
export const NOT_A_STUDENT_TAG = 'program:none';

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
  };
}

function normTags(contact) {
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
}

/**
 * Classify one contact.
 * Returns { isMember, programs, flag } where flag is a short reason string
 * (or null) that the sync writes into sync_log detail by name.
 */
export function classifyContact(contact, cfg) {
  const tags = normTags(contact);
  const hasExact = tags.some((t) => cfg.memberTags.includes(t));
  const hasPrefix = tags.some((t) => cfg.memberTagPrefixes.some((p) => t.startsWith(p)));
  const isMember = hasExact || hasPrefix;
  if (!isMember) return { isMember: false, programs: [], flag: null };
  if (tags.includes(NOT_A_STUDENT_TAG)) return { isMember: false, notStudent: true, programs: [], flag: null };

  // Programs in schedule order so output is stable regardless of tag order.
  const programs = [];
  for (const [tag, key] of cfg.programTagMap) {
    if (tags.includes(tag) && !programs.includes(key)) programs.push(key);
  }
  if (programs.length > 0) return { isMember: true, programs, flag: null };

  // No program tag. Foundations is the adult program, so that is silent.
  if (hasPrefix) return { isMember: true, programs: ['adult'], flag: null };
  // Founding members include kids; default to adult and say so.
  return { isMember: true, programs: ['adult'], flag: 'no program tag, defaulted to adult' };
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
    const { isMember, programs, flag, notStudent } = classifyContact(c, cfg);
    if (notStudent) notStudents.push(c.id);
    if (!isMember) continue;
    const first = tidyName(c.firstName);
    const last = tidyName(c.lastName);
    if (!first) {
      flagged.push({ id: c.id, name: displayName(c), reason: 'no first name, skipped' });
      continue;
    }
    if (flag) flagged.push({ id: c.id, name: displayName(c), reason: flag });
    members.push({ ghl_contact_id: c.id, first_name: first, last_name: last, programs });
  }
  return { members, flagged, notStudents };
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
    const upsert = db.prepare(
      `INSERT INTO members (ghl_contact_id, first_name, last_name, programs, active, synced_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(ghl_contact_id) DO UPDATE SET
         first_name = excluded.first_name,
         last_name  = excluded.last_name,
         programs   = excluded.programs,
         active     = 1,
         synced_at  = excluded.synced_at`,
    );
    const stmts = members.map((m) =>
      upsert.bind(m.ghl_contact_id, m.first_name, m.last_name, JSON.stringify(m.programs), ranAt),
    );
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
      flagged: flagged.map((f) => `${f.name}: ${f.reason}`),
    };
    await logSync(db, 'roster', ranAt, 'ok', detail);
    return { outcome: 'ok', ...detail };
  } catch (e) {
    const detail = { error: `d1: ${String(e && e.message ? e.message : e)}` };
    await logSync(db, 'roster', ranAt, 'failed', detail).catch(() => {});
    return { outcome: 'failed', ...detail };
  }
}
