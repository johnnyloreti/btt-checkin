// waiver.js — §15.1. When a member without a waiver checks in, write one
// custom field to their contact right away so a GHL workflow can send the
// reminder. This is the same allowed write as the nightly rollup. The
// Worker itself never sends a message.

import { getFieldIds } from './rollup.js';

export function waiverEnabled(env) {
  return Boolean(String(env.WAIVER_TAG || '').trim());
}

/**
 * Push WAIVER_FIELD = now to the contact. Never throws; returns
 * { ok, reason } so the caller can log it. Meant to run in ctx.waitUntil
 * after the check-in response has gone out.
 */
export async function notifyWaiverCheckin(env, deps, contactId, now = new Date()) {
  const key = String(env.WAIVER_FIELD || '').trim().toLowerCase();
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
