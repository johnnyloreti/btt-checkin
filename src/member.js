// member.js — the member login page (§15.9).
//
// /member is the way in to the progress page (§15.7) that needs no staff:
// pick your name, then either type the purchase PIN (§15.3), or have the
// link texted to the phone on file.
//
// The PIN belongs to the account, which for a kid is the parent's
// (payer_contact_id). A right PIN hands back that account's progress link;
// there is no session to keep, the link is the key.
//
// A four-digit PIN on a public page can be guessed in a way the iPad at the
// desk cannot, so web guesses are counted on their own, in pin_failures
// under "web:<contact id>":
//   WEB_FAIL_LIMIT    wrong tries on one account in 24 hours pause PIN login
//                     for that account
//   WEB_GLOBAL_LIMIT  wrong tries across every account in 24 hours pause PIN
//                     login for everyone
// A pause never touches the kiosk: a stranger guessing online cannot lock a
// member out of buying a drink. The texted link keeps working throughout.

import { PIN_RE, hashPin, constantTimeEqual } from './pin.js';

export const WEB_FAIL_LIMIT = 5;
export const WEB_GLOBAL_LIMIT = 30;
export const WEB_WINDOW_MS = 24 * 60 * 60_000;
const WEB = 'web:';

/** Wrong web PINs in the window: for one account, and for everyone. */
export async function webFailures(env, accountId, now = new Date()) {
  const since = new Date(now.getTime() - WEB_WINDOW_MS).toISOString();
  const [own, all] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM pin_failures WHERE payer_contact_id = ? AND failed_at >= ?').bind(`${WEB}${accountId}`, since).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM pin_failures WHERE payer_contact_id LIKE 'web:%' AND failed_at >= ?").bind(since).first(),
  ]);
  return { own: Number(own?.n ?? 0), all: Number(all?.n ?? 0) };
}

/**
 * Check a PIN typed on the member page.
 *
 * Returns { ok: true } or { ok: false, reason }:
 *   bad_format  not four digits; not counted
 *   paused      too many wrong tries; the PIN is not even looked at
 *   no_pin      this account has never set one; not counted
 *   wrong       counted, with `left` tries before the pause
 *
 * Unlike verifyPin it never changes purchase_pins, so nothing typed here
 * can lock, or unlock, the kiosk.
 */
export async function memberLogin(env, accountId, pin, now = new Date()) {
  if (!PIN_RE.test(String(pin ?? ''))) return { ok: false, reason: 'bad_format' };
  const fails = await webFailures(env, accountId, now);
  if (fails.own >= WEB_FAIL_LIMIT || fails.all >= WEB_GLOBAL_LIMIT) return { ok: false, reason: 'paused' };
  const row = await env.DB.prepare('SELECT pin_hash, salt FROM purchase_pins WHERE payer_contact_id = ?').bind(accountId).first();
  if (!row) return { ok: false, reason: 'no_pin' };
  if (constantTimeEqual(await hashPin(env, accountId, row.salt, pin), row.pin_hash)) return { ok: true };
  await env.DB.prepare('INSERT INTO pin_failures (payer_contact_id, failed_at) VALUES (?, ?)').bind(`${WEB}${accountId}`, now.toISOString()).run();
  return { ok: false, reason: 'wrong', left: Math.max(0, WEB_FAIL_LIMIT - fails.own - 1) };
}
