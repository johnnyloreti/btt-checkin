// waiver.js — §15.1. When a member without a waiver checks in, write one
// custom field so a GHL workflow can send the reminder. This is the same
// allowed write as the nightly rollup. The Worker itself never sends a
// message.
//
// Kids (§15.3 Phase 1b, 2026-09-29): a kid's own contact often has no phone
// or email, so a reminder written there reaches nobody. When the roster sync
// has linked a payer (the contact field PAYER_FIELD on the kid), the nudge
// goes to the payer instead, in its own field WAIVER_PAYER_FIELD whose value
// names the kid, so the parent's message can say who it is about and the
// parent's own waiver tag never decides it. Anything that stops that write
// (no payer linked, the field missing in GHL, the write failing) falls back
// to the member's own contact exactly as before, and a fallback is recorded
// as a failure, because the parent did not get the reminder.

import { getFieldIds } from './rollup.js';
import { logSyncRow } from './synclog.js';

export function waiverEnabled(env) {
  return Boolean(String(env.WAIVER_TAG || '').trim());
}

/** The custom field key the nudge writes on the member, lowercased, or ''. */
export function waiverFieldKey(env) {
  return String(env.WAIVER_FIELD || '').trim().toLowerCase();
}

/** The custom field key the nudge writes on a payer, lowercased, or '' when routing to payers is off. */
export function waiverPayerFieldKey(env) {
  return String(env.WAIVER_PAYER_FIELD || '').trim().toLowerCase();
}

/** The contact field on a kid that holds the payer's contact id, lowercased, or '' when off. */
export function payerFieldKey(env) {
  return String(env.PAYER_FIELD || '').trim().toLowerCase();
}

/** A GHL contact id, as far as the Worker can tell without asking GHL. */
export function looksLikeContactId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9]{8,64}$/.test(v);
}

/**
 * What the payer's field says, e.g. "Jack Silva, checked in Tue Sep 29".
 * The date makes the value change once a day per kid, which is what fires
 * the GHL workflow (it triggers on a change), so a parent gets at most one
 * reminder per kid per day. No em dashes (§0.9): it lands in a message.
 */
export function payerNudgeValue(name, now, tz = 'America/New_York') {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
    .format(now)
    .replace(/,/g, '');
  return `${String(name || '').trim() || 'Your child'}, checked in ${day}`;
}

async function writeOwn(env, deps, contactId, fields, now) {
  const key = waiverFieldKey(env);
  if (!key) return { ok: false, reason: 'WAIVER_FIELD is not set' };
  const id = fields.get(key);
  if (!id) return { ok: false, reason: `custom field ${key} not found in GHL` };
  await deps.putContact(contactId, [{ id, field_value: now.toISOString() }]);
  return { ok: true };
}

/**
 * Nudge GHL for one check-in without a waiver. Never throws.
 *
 * opts.payerId   the linked payer's contact id, if any
 * opts.name      the member's name, for the payer's field
 * opts.tz        for the day in that field
 *
 * Returns { ok, to, reason? } where `to` is 'payer' or 'self'. ok is true
 * only when the reminder went where it should: a payer who was linked but
 * could not be written to is ok: false even if the member's own contact
 * was written as a fallback, so /health counts it.
 */
export async function notifyWaiverCheckin(env, deps, contactId, now = new Date(), opts = {}) {
  if (!waiverEnabled(env)) return { ok: false, to: null, reason: 'waiver feature off' };
  const payerKey = waiverPayerFieldKey(env);
  const payerId = opts.payerId && opts.payerId !== contactId && looksLikeContactId(opts.payerId) ? opts.payerId : null;
  let fields;
  try {
    fields = await getFieldIds(deps.fetchFields, now);
  } catch (e) {
    return { ok: false, to: null, reason: e && e.message ? e.message : String(e) };
  }

  let payerProblem = null;
  if (payerId && payerKey) {
    const id = fields.get(payerKey);
    if (!id) {
      payerProblem = `custom field ${payerKey} not found in GHL`;
    } else {
      try {
        await deps.putContact(payerId, [{ id, field_value: payerNudgeValue(opts.name, now, opts.tz) }]);
        return { ok: true, to: 'payer' };
      } catch (e) {
        payerProblem = `payer write failed: ${e && e.message ? e.message : String(e)}`;
      }
    }
  }

  try {
    const own = await writeOwn(env, deps, contactId, fields, now);
    if (payerProblem) {
      return { ok: false, to: own.ok ? 'self' : null, reason: `${payerProblem}; ${own.ok ? "wrote the member's own contact instead" : own.reason}` };
    }
    return { ...own, to: own.ok ? 'self' : null };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { ok: false, to: null, reason: payerProblem ? `${payerProblem}; ${msg}` : msg };
  }
}

/**
 * A nudge that did not land is a member who will not get the reminder.
 * Record it in sync_log so /health can count it; console.warn alone hid
 * this for weeks. Never throws.
 */
export async function logWaiverFailure(env, contactId, reason, now = new Date()) {
  await logSyncRow(env, 'waiver', 'failed', { contactId, reason }, now);
}
