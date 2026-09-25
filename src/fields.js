// fields.js — every GHL custom field the Worker writes, and a check that
// each one exists. The roster sync runs the check every 30 minutes and logs
// degraded naming any that are missing, so a field that was never created
// (or was renamed) is visible on /health within the hour, instead of every
// write silently landing on nothing.
//
// Learned on 2026-09-25: the §15.1 waiver nudge wrote checkin_last_at for
// weeks to a field that did not exist in GHL. Nothing failed loudly, so no
// reminder ever went out.

import { FIELD_KEYS, getFieldIds, resetFieldCache } from './rollup.js';
import { waiverEnabled, waiverFieldKey } from './waiver.js';
import { parseList } from './roster.js';
import { PIN_LINK_FIELD } from './pin.js';

/** The keys the Worker writes with the current config, in a stable order. */
export function requiredFieldKeys(env = {}) {
  const keys = [...FIELD_KEYS];
  if (waiverEnabled(env)) {
    const key = waiverFieldKey(env);
    if (key && !keys.includes(key)) keys.push(key);
  }
  // The drink tab (§15.3) writes the PIN setup link. Required as soon as the
  // tab is switched on, so /health goes red before the first member taps.
  if (parseList(env.TAB_ITEMS).length > 0 && !keys.includes(PIN_LINK_FIELD)) keys.push(PIN_LINK_FIELD);
  return keys;
}

/**
 * Which required fields GHL does not have. Uses the hourly field cache, and
 * drops it when something is missing so the next run re-reads GHL and sees
 * the field as soon as Johnny creates it.
 *
 * Returns { checked: true, missing: [...] }. Throws if GHL cannot be read;
 * the caller decides what that means for its own outcome.
 */
export async function checkRequiredFields(env, fetchFields, now = new Date()) {
  const fields = await getFieldIds(fetchFields, now);
  const missing = requiredFieldKeys(env).filter((k) => !fields.get(k));
  if (missing.length) resetFieldCache();
  return { checked: true, missing };
}
