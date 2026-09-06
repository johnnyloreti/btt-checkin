// ghl.js — the only file that talks to GoHighLevel.
// Every call here is a GET except ghlPutContactCustomFields (§6), which is
// the single allowed write. test/write-scanner.test.js enforces this.

export const GHL_BASE = 'https://services.leadconnectorhq.com';
export const GHL_VERSION = '2021-07-28';

export class GhlError extends Error {
  constructor(status, path, body) {
    super(`GHL ${status} on ${path}: ${body ? body.slice(0, 200) : ''}`);
    this.name = 'GhlError';
    this.status = status;
  }
}

function headers(env) {
  if (!env.GHL_TOKEN) throw new Error('GHL_TOKEN is not set');
  return {
    authorization: `Bearer ${env.GHL_TOKEN}`,
    version: GHL_VERSION,
    accept: 'application/json',
  };
}

/** GET a GHL path with query params. Returns parsed JSON. */
export async function ghlGet(env, path, params = {}, fetchImpl = fetch) {
  const url = new URL(path, GHL_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetchImpl(url.toString(), { method: 'GET', headers: headers(env) });
  if (!res.ok) throw new GhlError(res.status, path, await res.text().catch(() => ''));
  return res.json();
}

/**
 * Pull every contact in the location. Returns the flat array.
 * GHL pages with startAfterId + startAfter from meta. Hard cap on pages so
 * a misbehaving cursor can never loop forever.
 */
export async function fetchAllContacts(env, { fetchImpl = fetch, limit = 100, maxPages = 500 } = {}) {
  const all = [];
  let startAfterId;
  let startAfter;
  let pages = 0;
  for (;;) {
    const data = await ghlGet(
      env,
      '/contacts/',
      { locationId: env.GHL_LOCATION_ID, limit, startAfterId, startAfter },
      fetchImpl,
    );
    pages += 1;
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    all.push(...contacts);
    const meta = data.meta || {};
    const nextId = meta.startAfterId;
    if (contacts.length === 0 || !nextId || nextId === startAfterId) break;
    if (pages >= maxPages) throw new Error(`GHL contacts pagination exceeded ${maxPages} pages`);
    startAfterId = nextId;
    startAfter = meta.startAfter;
  }
  return { contacts: all, pages };
}
