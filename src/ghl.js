// ghl.js — the only file that talks to GoHighLevel.
// Every request goes through ghlRequest with a literal method and path, and
// test/write-scanner.test.js holds the exhaustive allowlist of method + path
// pairs from §6 and §15.3. A call that is not on it fails the suite.

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

/**
 * The one place a request leaves for GHL. `method` and `path` are literals
 * at every call site so the write scanner can read them.
 */
export async function ghlRequest(env, method, path, { params = {}, body, fetchImpl = fetch } = {}) {
  const url = new URL(path, GHL_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const init = { method, headers: headers(env) };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url.toString(), init);
  if (!res.ok) throw new GhlError(res.status, path, await res.text().catch(() => ''));
  return res.json().catch(() => ({}));
}

/** altId/altType, which every payments and invoices route wants. */
function loc(env) {
  return { altId: env.GHL_LOCATION_ID, altType: 'location' };
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
    const data = await ghlRequest(env, 'GET', '/contacts/', {
      params: { locationId: env.GHL_LOCATION_ID, limit, startAfterId, startAfter },
      fetchImpl,
    });
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

/**
 * Custom field definitions for the location. Returns Map<key, id> where key
 * is the field key without its "contact." prefix. GHL returns either
 * { customFields: [...] } or a bare array depending on version.
 */
export async function fetchCustomFieldIds(env, fetchImpl = fetch) {
  const data = await ghlRequest(env, 'GET', `/locations/${env.GHL_LOCATION_ID}/customFields`, { fetchImpl });
  const list = Array.isArray(data) ? data : Array.isArray(data.customFields) ? data.customFields : [];
  const map = new Map();
  for (const f of list) {
    if (!f || !f.id) continue;
    const raw = String(f.fieldKey || f.key || f.name || '');
    const key = raw.replace(/^contact\./, '').trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, String(f.id));
  }
  return map;
}

/**
 * The contact write (§6): PUT /contacts/{id} with custom field values.
 * fields: [{ id, field_value }]. Nothing else about the contact is sent.
 */
export async function ghlPutContactCustomFields(env, contactId, fields, fetchImpl = fetch) {
  if (!contactId) throw new Error('contactId required');
  if (!Array.isArray(fields) || fields.length === 0) throw new Error('no fields to write');
  return ghlRequest(env, 'PUT', `/contacts/${encodeURIComponent(contactId)}`, {
    body: { customFields: fields.map((f) => ({ id: f.id, field_value: f.field_value })) },
    fetchImpl,
  });
}

// ---------- drink tab close-out (§15.3) ----------
// Reads for the card on file and the invoice status, and the two writes that
// create and activate a one-time invoice schedule. Response shapes are read
// tolerantly (a list may come bare or under a key) because they were
// observed, not documented; see STATUS.md.

const list = (data, ...keys) => {
  if (Array.isArray(data)) return data;
  for (const k of keys) if (data && Array.isArray(data[k])) return data[k];
  return [];
};

/** Name, email and phone for the invoice. D1 never holds these. */
export async function ghlGetContact(env, contactId, fetchImpl = fetch) {
  const data = await ghlRequest(env, 'GET', `/contacts/${encodeURIComponent(contactId)}`, { fetchImpl });
  const c = data && data.contact ? data.contact : data || {};
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || String(c.name || '').trim();
  return { id: c.id || contactId, name, email: String(c.email || '').trim(), phone: String(c.phone || '').trim() };
}

export async function ghlListTransactions(env, contactId, fetchImpl = fetch) {
  const data = await ghlRequest(env, 'GET', '/payments/transactions', { params: { ...loc(env), contactId, limit: 100 }, fetchImpl });
  return list(data, 'data', 'transactions');
}

export async function ghlGetTransaction(env, transactionId, fetchImpl = fetch) {
  return ghlRequest(env, 'GET', `/payments/transactions/${encodeURIComponent(transactionId)}`, { params: loc(env), fetchImpl });
}

/** Schedules whose name contains `search` (any part of it; the caller filters for an exact match). */
export async function ghlFindSchedules(env, search, fetchImpl = fetch) {
  const data = await ghlRequest(env, 'GET', '/invoices/schedule', { params: { ...loc(env), search, limit: 20 }, fetchImpl });
  return list(data, 'schedules', 'data');
}

export async function ghlGetSchedule(env, scheduleId, fetchImpl = fetch) {
  const data = await ghlRequest(env, 'GET', `/invoices/schedule/${encodeURIComponent(scheduleId)}`, { params: loc(env), fetchImpl });
  return data && data.schedule ? data.schedule : data;
}

/** WRITE: create a one-time invoice schedule. Returns { id }. */
export async function ghlCreateSchedule(env, body, fetchImpl = fetch) {
  const data = await ghlRequest(env, 'POST', '/invoices/schedule', { body: { ...loc(env), ...body }, fetchImpl });
  const s = data && data.schedule ? data.schedule : data;
  return { id: s && (s._id || s.id) ? String(s._id || s.id) : null, raw: s };
}

/** WRITE: turn on saved-card auto-pay and activate the schedule. */
export async function ghlActivateSchedule(env, scheduleId, autoPayment, fetchImpl = fetch) {
  return ghlRequest(env, 'POST', `/invoices/schedule/${encodeURIComponent(scheduleId)}/schedule`, {
    body: { ...loc(env), liveMode: true, autoPayment },
    fetchImpl,
  });
}

export async function ghlListInvoices(env, contactId, fetchImpl = fetch) {
  const data = await ghlRequest(env, 'GET', '/invoices/', { params: { ...loc(env), contactId, limit: 50 }, fetchImpl });
  return list(data, 'invoices', 'data');
}

export async function ghlGetInvoice(env, invoiceId, fetchImpl = fetch) {
  const data = await ghlRequest(env, 'GET', `/invoices/${encodeURIComponent(invoiceId)}`, { params: loc(env), fetchImpl });
  return data && data.invoice ? data.invoice : data;
}
