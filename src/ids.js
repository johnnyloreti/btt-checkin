// ids.js — opaque public IDs (§7). The kiosk never sees a GHL contact ID;
// it sees HMAC-SHA256(ID_SALT, contactId) truncated, and the Worker resolves
// it back on POST by hashing the roster and matching.

const enc = new TextEncoder();
const keyCache = new Map();

async function hmacKey(salt) {
  let k = keyCache.get(salt);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(salt, k);
  }
  return k;
}

export function requireSalt(env) {
  if (!env.ID_SALT || String(env.ID_SALT).length < 8) throw new Error('ID_SALT is not set (needs at least 8 characters)');
  return String(env.ID_SALT);
}

/** 20 hex chars, stable for a given salt. */
export async function opaqueId(contactId, salt) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(salt), enc.encode(String(contactId)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

/** Map opaque id → row for a list of rows carrying ghl_contact_id. */
export async function buildIdMap(rows, salt) {
  const map = new Map();
  for (const row of rows) map.set(await opaqueId(row.ghl_contact_id, salt), row);
  return map;
}
