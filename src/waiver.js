// waiver.js — §15.1. When a member without a waiver checks in, write one
// custom field to their contact right away so a GHL workflow can send the
// reminder. This is the same allowed write as the nightly rollup. The
// Worker itself never sends a message.

import { getFieldIds } from './rollup.js';

export function waiverEnabled(env) {
  return Boolean(String(env.WAIVER_TAG || '').trim());
}

/** The custom field key the nudge writes, lowercased, or '' when unset. */
export function waiverFieldKey(env) {
  return String(env.WAIVER_FIELD || '').trim().toLowerCase();
}

/**
 * Push WAIVER_FIELD = now to the contact. Never throws; returns
 * { ok, reason } so the caller can log it. Meant to run in ctx.waitUntil
 * after the check-in response has gone out.
 */
export async function notifyWaiverCheckin(env, deps, contactId, now = new Date()) {
  const key = waiverFieldKey(env);
  if (!waiverEnabled(env) || !key) return { ok: false, reason: 'waiver feature off' };
  try {
    const fields = await getFieldIds(deps.fetchFields, now);
    const id = fields.get(key);
    if (!id) return { ok: false, reason: `custom field ${key} not found in GHL` };
    await deps.putContact(contactId, [{ id, field_value: now.toISOString() }]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * A nudge that did not land is a member who will not get the reminder.
 * Record it in sync_log so /health can count it; console.warn alone hid
 * this for weeks. Never throws.
 */
export async function logWaiverFailure(env, contactId, reason, now = new Date()) {
  try {
    await env.DB.prepare('INSERT INTO sync_log (job, ran_at, outcome, detail) VALUES (?, ?, ?, ?)')
      .bind('waiver', now.toISOString(), 'failed', JSON.stringify({ contactId, reason }))
      .run();
  } catch (e) {
    console.warn(`could not log waiver failure for ${contactId}: ${e && e.message ? e.message : e}`);
  }
}
