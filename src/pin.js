// pin.js — the purchase PIN (§15.3). A 4-digit PIN a member sets once,
// through a one-time link texted by GHL, and types on the kiosk to put a
// drink on their tab.
//
// Storage: HMAC-SHA256 keyed with the PIN_PEPPER secret over
// salt|contactId|pin, hex. Not a slow hash: Workers WebCrypto caps PBKDF2
// and a 4-digit PIN has 10,000 values, so anyone holding the table could
// try them all. The pepper, which never touches D1, is the protection.
// Compares are constant time. PINs are never stored in GHL or logged.

const enc = new TextEncoder();

export const PIN_RE = /^\d{4}$/;
export const LOCK_AFTER = 5; // wrong PINs ...
export const LOCK_WINDOW_MS = 15 * 60_000; // ... within this window ...
export const LOCK_MS = 15 * 60_000; // ... lock purchases for this long
export const TOKEN_TTL_MS = 30 * 60_000;
export const LINK_MIN_GAP_MS = 10 * 60_000; // one kiosk-requested link per member per 10 minutes
export const PIN_LINK_FIELD = 'purchase_pin_link';

export function requirePepper(env) {
  const p = String(env.PIN_PEPPER || '');
  if (p.length < 16) throw new Error('PIN_PEPPER is not set (needs at least 16 characters)');
  return p;
}

const keyCache = new Map();
async function hmacKey(secret) {
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, k);
  }
  return k;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return hex(a);
}

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
}

export async function hashPin(env, contactId, salt, pin) {
  const key = await hmacKey(requirePepper(env));
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${salt}|${contactId}|${pin}`)));
}

/** Constant-time string compare; length leaks, contents do not. */
export function constantTimeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function iso(d) {
  return d.toISOString();
}

/** { hasPin, locked, lockedUntil } for the kiosk and the staff member screen. */
export async function pinStatus(env, contactId, now = new Date()) {
  const row = await env.DB.prepare('SELECT locked_until FROM purchase_pins WHERE payer_contact_id = ?').bind(contactId).first();
  if (!row) return { hasPin: false, locked: false, lockedUntil: null };
  const locked = Boolean(row.locked_until && row.locked_until > iso(now));
  return { hasPin: true, locked, lockedUntil: locked ? row.locked_until : null };
}

/**
 * Check a PIN. Wrong ones count toward the per-member lock and are written
 * to pin_failures for the staff page. A malformed PIN is refused without
 * counting; the kiosk only sends four digits.
 *
 * Returns { ok: true } or { ok: false, reason: 'bad_format' | 'no_pin' | 'locked' | 'wrong', lockedUntil? }.
 */
export async function verifyPin(env, contactId, pin, now = new Date()) {
  if (!PIN_RE.test(String(pin ?? ''))) return { ok: false, reason: 'bad_format' };
  const db = env.DB;
  const row = await db.prepare('SELECT pin_hash, salt, failed_count, first_failed_at, locked_until FROM purchase_pins WHERE payer_contact_id = ?').bind(contactId).first();
  if (!row) return { ok: false, reason: 'no_pin' };
  const nowIso = iso(now);
  if (row.locked_until && row.locked_until > nowIso) return { ok: false, reason: 'locked', lockedUntil: row.locked_until };

  const candidate = await hashPin(env, contactId, row.salt, pin);
  if (constantTimeEqual(candidate, row.pin_hash)) {
    if (row.failed_count > 0 || row.first_failed_at || row.locked_until) {
      await db.prepare('UPDATE purchase_pins SET failed_count = 0, first_failed_at = NULL, locked_until = NULL WHERE payer_contact_id = ?').bind(contactId).run();
    }
    return { ok: true };
  }

  // Wrong. Count within the window; the LOCK_AFTER-th wrong one locks.
  const inWindow = row.first_failed_at && now.getTime() - Date.parse(row.first_failed_at) < LOCK_WINDOW_MS;
  const count = inWindow ? Number(row.failed_count) + 1 : 1;
  const first = inWindow ? row.first_failed_at : nowIso;
  const lockedUntil = count >= LOCK_AFTER ? iso(new Date(now.getTime() + LOCK_MS)) : null;
  await db.batch([
    db.prepare('UPDATE purchase_pins SET failed_count = ?, first_failed_at = ?, locked_until = ? WHERE payer_contact_id = ?').bind(count, first, lockedUntil, contactId),
    db.prepare('INSERT INTO pin_failures (payer_contact_id, failed_at) VALUES (?, ?)').bind(contactId, nowIso),
  ]);
  return lockedUntil ? { ok: false, reason: 'locked', lockedUntil } : { ok: false, reason: 'wrong' };
}

/**
 * Mint a one-time setup token. `via` is 'link' (the member asked at the
 * kiosk; one per member per LINK_MIN_GAP_MS) or 'staff' (opened from the
 * staff page with the member present; no gap). The raw token is returned
 * once, for the link; only its hash is stored.
 */
export async function createSetupToken(env, contactId, via, now = new Date()) {
  if (via !== 'link' && via !== 'staff') throw new Error(`bad via ${via}`);
  const db = env.DB;
  if (via === 'link') {
    const latest = await db.prepare("SELECT created_at FROM pin_setup_tokens WHERE payer_contact_id = ? AND via = 'link' ORDER BY created_at DESC LIMIT 1").bind(contactId).first();
    if (latest && now.getTime() - Date.parse(latest.created_at) < LINK_MIN_GAP_MS) {
      return { ok: false, reason: 'recent', retryAt: iso(new Date(Date.parse(latest.created_at) + LINK_MIN_GAP_MS)) };
    }
  }
  const token = randomHex(32);
  const expiresAt = iso(new Date(now.getTime() + TOKEN_TTL_MS));
  await db.prepare('INSERT INTO pin_setup_tokens (token_hash, payer_contact_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), contactId, via, iso(now), expiresAt)
    .run();
  return { ok: true, token, expiresAt };
}

/** Look a token up without spending it: { ok, contactId, via } or { ok: false, reason }. */
export async function readSetupToken(env, token, now = new Date()) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return { ok: false, reason: 'invalid' };
  const row = await env.DB.prepare('SELECT payer_contact_id, via, expires_at, used_at FROM pin_setup_tokens WHERE token_hash = ?').bind(await sha256Hex(token)).first();
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (row.expires_at <= iso(now)) return { ok: false, reason: 'expired' };
  return { ok: true, contactId: row.payer_contact_id, via: row.via };
}

/**
 * Spend a token and set the PIN in one transaction. A new salt every time;
 * any lockout is cleared, since the member has just proven they hold the
 * phone (or is standing at the desk).
 */
export async function completeSetup(env, token, pin, now = new Date()) {
  if (!PIN_RE.test(String(pin ?? ''))) return { ok: false, reason: 'bad_format' };
  const t = await readSetupToken(env, token, now);
  if (!t.ok) return t;
  const salt = randomHex(16);
  const db = env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO purchase_pins (payer_contact_id, pin_hash, salt, set_at, set_by, failed_count, first_failed_at, locked_until)
       VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(payer_contact_id) DO UPDATE SET
         pin_hash = excluded.pin_hash, salt = excluded.salt, set_at = excluded.set_at, set_by = excluded.set_by,
         failed_count = 0, first_failed_at = NULL, locked_until = NULL`,
    ).bind(t.contactId, await hashPin(env, t.contactId, salt, pin), salt, iso(now), t.via),
    db.prepare('UPDATE pin_setup_tokens SET used_at = ? WHERE token_hash = ?').bind(iso(now), await sha256Hex(token)),
  ]);
  return { ok: true, contactId: t.contactId };
}

export async function clearLockout(env, contactId) {
  const r = await env.DB.prepare('UPDATE purchase_pins SET failed_count = 0, first_failed_at = NULL, locked_until = NULL WHERE payer_contact_id = ?').bind(contactId).run();
  return { ok: true, cleared: Number(r?.meta?.changes ?? 0) > 0 };
}

/** For the staff page: wrong PINs since `sinceIso`, and who is locked right now. */
export async function pinActivity(env, sinceIso, now = new Date()) {
  const [failed, locked] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM pin_failures WHERE failed_at >= ?').bind(sinceIso).first(),
    env.DB.prepare('SELECT payer_contact_id, locked_until FROM purchase_pins WHERE locked_until > ? ORDER BY locked_until').bind(iso(now)).all(),
  ]);
  return {
    failed: Number(failed?.n ?? 0),
    locked: (locked.results || []).map((r) => ({ contactId: r.payer_contact_id, lockedUntil: r.locked_until })),
  };
}

/**
 * Write the setup link to the contact's purchase_pin_link field, the one
 * allowed contact write. GHL's workflow does the texting. Never throws;
 * { ok, reason } like the waiver nudge, and the caller logs a failure.
 */
export async function writePinLink(env, deps, contactId, link, now = new Date()) {
  try {
    const fields = await deps.getFieldIds(now);
    const id = fields.get(PIN_LINK_FIELD);
    if (!id) return { ok: false, reason: `custom field ${PIN_LINK_FIELD} not found in GHL` };
    await deps.putContact(contactId, [{ id, field_value: link }]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}
