// staff-auth.js — PIN check and the 12-hour staff cookie (§3).
// The cookie is a stateless signed token: "<expiryMs>.<hmac>" keyed on
// ID_SALT + STAFF_PIN, so changing either secret logs everyone out.
// A request may also carry the PIN in an x-staff-pin header (used by the
// manual sync trigger from a shell).

export const COOKIE_NAME = 'btt_staff';
export const SESSION_MS = 12 * 60 * 60 * 1000;

const enc = new TextEncoder();

function sameString(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function pinMatches(env, candidate) {
  if (!env.STAFF_PIN) return false;
  return sameString(env.STAFF_PIN, candidate);
}

async function sign(env, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(`${env.ID_SALT || ''}:${env.STAFF_PIN || ''}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Mint a session token that expires SESSION_MS from `now`. */
export async function issueToken(env, now = Date.now()) {
  if (!env.STAFF_PIN || !env.ID_SALT) throw new Error('STAFF_PIN and ID_SALT must be set');
  const exp = String(now + SESSION_MS);
  return `${exp}.${await sign(env, exp)}`;
}

/** True when the token is well formed, unexpired, and correctly signed. */
export async function verifyToken(env, token, now = Date.now()) {
  if (!env.STAFF_PIN || !env.ID_SALT || typeof token !== 'string') return false;
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  if (Number(m[1]) <= now) return false;
  return sameString(await sign(env, m[1]), m[2]);
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function cookieHeader(request, token, maxAgeSeconds) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure}`;
}

/** True when the request is authorized as staff, by cookie or header. */
export async function isStaff(request, env, now = Date.now()) {
  const header = request.headers.get('x-staff-pin');
  if (header && pinMatches(env, header)) return true;
  const token = readCookie(request, COOKIE_NAME);
  if (token && (await verifyToken(env, token, now))) return true;
  return false;
}
