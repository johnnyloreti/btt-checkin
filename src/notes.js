// notes.js — a staff note on a member (§15.11).
//
// One short note per member, written and read on the staff member screen:
// "left knee, no takedowns", "picked up by grandma on Thursdays". Plain text,
// staff-only. It is never on the kiosk, never on the progress page, never
// sent to GHL, and nothing on the check-in path reads it.
//
// Off unless MEMBER_NOTES is "on". Notes about members were out of V1 (§3)
// and are free text about people, some of them children, behind a shared
// four-digit staff PIN: whether to keep them here at all is Johnny's call,
// so this ships switched off.

import { hasMemberNotesTable } from './schema-caps.js';

export const MAX_NOTE_CHARS = 1000;
export const NOTES_MIGRATION = 'src/db/migrations/008_member_notes.sql';

/** MEMBER_NOTES = "on" (or "1", "true") turns notes on. Anything else is off. */
export function memberNotesEnabled(env = {}) {
  const v = String(env.MEMBER_NOTES ?? '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true';
}

/** On, and migration 008 has run. */
export async function memberNotesReady(env) {
  return memberNotesEnabled(env) && (await hasMemberNotesTable(env));
}

/** The note for the member screen: { enabled, body, updatedAt }. */
export async function memberNote(env, contactId) {
  if (!(await memberNotesReady(env))) return { enabled: false };
  const row = await env.DB.prepare('SELECT body, updated_at FROM member_notes WHERE ghl_contact_id = ?').bind(contactId).first();
  return { enabled: true, max: MAX_NOTE_CHARS, body: row ? row.body : '', updatedAt: row ? row.updated_at : null };
}

/** Save the note. A blank body removes it. Throws with .status on a bad save. */
export async function saveMemberNote(env, contactId, body, now = new Date()) {
  if (!memberNotesEnabled(env)) throw Object.assign(new Error('member notes are off'), { status: 404 });
  if (!(await hasMemberNotesTable(env))) throw Object.assign(new Error(`member notes are not set up yet: run ${NOTES_MIGRATION}`), { status: 503 });
  const text = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length > MAX_NOTE_CHARS) throw Object.assign(new Error(`a note is at most ${MAX_NOTE_CHARS} characters`), { status: 400 });
  if (!text) {
    await env.DB.prepare('DELETE FROM member_notes WHERE ghl_contact_id = ?').bind(contactId).run();
    return { ok: true, note: '', updatedAt: null };
  }
  const at = now.toISOString();
  await env.DB.prepare(
    `INSERT INTO member_notes (ghl_contact_id, body, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(ghl_contact_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
  ).bind(contactId, text, at).run();
  return { ok: true, note: text, updatedAt: at };
}
