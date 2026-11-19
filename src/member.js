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
 *
 * A try is claimed before the PIN is looked at: the row goes into
 * pin_failures first, and the count that decides is taken after it. Counting
 * first and writing afterwards let a burst of requests sent together all
 * read "no failures yet" and each have its guess checked, which turned five
 * tries into as many as one address could send. Claimed first, every request
 * sees the ones ahead of it, so no more than the limit are ever checked. A
 * right PIN, and a try that arrives during a pause, give their claim back.
 */
export async function memberLogin(env, accountId, pin, now = new Date()) {
  if (!PIN_RE.test(String(pin ?? ''))) return { ok: false, reason: 'bad_format' };
  const before = await webFailures(env, accountId, now);
  if (before.own >= WEB_FAIL_LIMIT || before.all >= WEB_GLOBAL_LIMIT) return { ok: false, reason: 'paused' };
  const row = await env.DB.prepare('SELECT pin_hash, salt FROM purchase_pins WHERE payer_contact_id = ?').bind(accountId).first();
  if (!row) return { ok: false, reason: 'no_pin' };

  const claim = await env.DB.prepare('INSERT INTO pin_failures (payer_contact_id, failed_at) VALUES (?, ?)').bind(`${WEB}${accountId}`, now.toISOString()).run();
  const claimId = claim?.meta?.last_row_id;
  const release = () => env.DB.prepare('DELETE FROM pin_failures WHERE id = ? AND payer_contact_id = ?').bind(claimId, `${WEB}${accountId}`).run();
  const after = await webFailures(env, accountId, now);
  if (after.own > WEB_FAIL_LIMIT || after.all > WEB_GLOBAL_LIMIT) {
    await release();
    return { ok: false, reason: 'paused' };
  }
  if (constantTimeEqual(await hashPin(env, accountId, row.salt, pin), row.pin_hash)) {
    await release();
    return { ok: true };
  }
  return { ok: false, reason: 'wrong', left: Math.max(0, WEB_FAIL_LIMIT - after.own) };
}

// ---- texts a stranger could ask for ----
//
// Both buttons under the PIN box end in a text to the phone on file, and the
// page is public: anyone can tap any name. Neither text can be read by the
// person who asked, but each one costs money and lands on a member's phone,
// so the Worker counts them itself and does not lean on GHL to notice that a
// field did not change.

export const WEB_LINKS_GLOBAL = 40; // "Text me my link" sends in 24 hours, everyone together
export const WEB_PIN_LINKS_PER_DAY = 3; // PIN setup links for one account in 24 hours
const LINK_JOB = 'member_link';

/**
 * May "Text me my link" send for this account right now?
 *   { ok: true }                      go ahead
 *   { ok: false, reason: 'today' }    this account was already sent one today (ET)
 *   { ok: false, reason: 'busy' }     too many sends across everyone in 24 hours
 * `day` is the ET date, the same day the link's own stamp carries (§15.7).
 */
export async function linkAllowance(env, accountId, day, now = new Date()) {
  const since = new Date(now.getTime() - WEB_WINDOW_MS).toISOString();
  const [mine, all] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM sync_log WHERE job = ? AND detail = ?').bind(LINK_JOB, `${accountId}|${day}`).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sync_log WHERE job = ? AND ran_at >= ?').bind(LINK_JOB, since).first(),
  ]);
  if (Number(mine?.n ?? 0) > 0) return { ok: false, reason: 'today' };
  if (Number(all?.n ?? 0) >= WEB_LINKS_GLOBAL) return { ok: false, reason: 'busy' };
  return { ok: true };
}

/** Record a "Text me my link" send, after the write to GHL went through. */
export async function recordLinkSend(env, accountId, day, now = new Date()) {
  await env.DB.prepare('INSERT INTO sync_log (job, ran_at, outcome, detail) VALUES (?, ?, ?, ?)')
    .bind(LINK_JOB, now.toISOString(), 'ok', `${accountId}|${day}`)
    .run();
}

/** PIN setup links texted for this account in the last 24 hours (kiosk and web together). */
export async function pinLinksToday(env, accountId, now = new Date()) {
  const since = new Date(now.getTime() - WEB_WINDOW_MS).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM pin_setup_tokens WHERE payer_contact_id = ? AND via = 'link' AND created_at >= ?").bind(accountId, since).first();
  return Number(row?.n ?? 0);
}
