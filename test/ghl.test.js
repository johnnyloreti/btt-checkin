import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllContacts, ghlRequest, GhlError, GHL_BASE, ghlFindSchedules, ghlListInvoices, ghlListTransactions, ghlCreateSchedule, pickId, unwrap, ghlGetSchedule } from '../src/ghl.js';

const ENV = { GHL_TOKEN: 'test-token', GHL_LOCATION_ID: 'LOC123' };

function fakeFetch(pages) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const u = new URL(url);
    const after = u.searchParams.get('startAfterId') || '';
    const page = pages[after];
    if (!page) return new Response('no such page', { status: 500 });
    return Response.json(page);
  };
  return { impl, calls };
}

test('ghlRequest sends bearer token, version header, and the method it is given', async () => {
  const { impl, calls } = fakeFetch({ '': { contacts: [], meta: {} } });
  await ghlRequest(ENV, 'GET', '/contacts/', { params: { locationId: 'LOC123', limit: 100, startAfterId: undefined }, fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
  assert.equal(calls[0].init.headers.version, '2021-07-28');
  assert.equal(calls[0].url.origin, GHL_BASE);
  assert.equal(calls[0].url.searchParams.get('locationId'), 'LOC123');
  assert.equal(calls[0].url.searchParams.has('startAfterId'), false);
});

test('ghlRequest throws GhlError on non-2xx', async () => {
  const impl = async () => new Response('nope', { status: 401 });
  await assert.rejects(() => ghlRequest(ENV, 'GET', '/contacts/', { fetchImpl: impl }), (e) => e instanceof GhlError && e.status === 401);
});

test('ghlRequest refuses to run without a token', async () => {
  await assert.rejects(() => ghlRequest({}, 'GET', '/contacts/', { fetchImpl: async () => Response.json({}) }), /GHL_TOKEN/);
});

test('ghlRequest sends a JSON body with the content type, and none without', async () => {
  const calls = [];
  const impl = async (url, init) => { calls.push(init); return Response.json({ ok: 1 }); };
  await ghlRequest(ENV, 'POST', '/invoices/schedule', { body: { name: 'x' }, fetchImpl: impl });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  assert.equal(calls[0].body, '{"name":"x"}');
  await ghlRequest(ENV, 'GET', '/invoices/', { fetchImpl: impl });
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers['content-type'], undefined);
});

test('fetchAllContacts follows startAfterId across pages and stops', async () => {
  const { impl, calls } = fakeFetch({
    '': { contacts: [{ id: 'a' }, { id: 'b' }], meta: { startAfterId: 'b', startAfter: 111 } },
    b: { contacts: [{ id: 'c' }], meta: { startAfterId: 'c', startAfter: 222 } },
    c: { contacts: [], meta: {} },
  });
  const { contacts, pages } = await fetchAllContacts(ENV, { fetchImpl: impl, limit: 2 });
  assert.deepEqual(contacts.map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(pages, 3);
  assert.equal(calls[1].url.searchParams.get('startAfterId'), 'b');
  assert.equal(calls[1].url.searchParams.get('startAfter'), '111');
  assert.equal(calls[2].url.searchParams.get('startAfterId'), 'c');
});

test('fetchAllContacts stops when the cursor stops moving', async () => {
  const { impl, calls } = fakeFetch({
    '': { contacts: [{ id: 'a' }], meta: { startAfterId: 'a' } },
    a: { contacts: [{ id: 'a' }], meta: { startAfterId: 'a' } },
  });
  const { contacts } = await fetchAllContacts(ENV, { fetchImpl: impl });
  assert.equal(contacts.length, 2);
  assert.equal(calls.length, 2);
});

test('fetchAllContacts refuses to page forever', async () => {
  let n = 0;
  const impl = async () => {
    n += 1;
    return Response.json({ contacts: [{ id: `x${n}` }], meta: { startAfterId: `x${n}` } });
  };
  await assert.rejects(() => fetchAllContacts(ENV, { fetchImpl: impl, maxPages: 5 }), /exceeded 5 pages/);
});

test('the list calls send limit and offset, which the invoice routes require (GHL 422 otherwise)', async () => {
  const calls = [];
  const impl = async (url) => { calls.push(new URL(url)); return Response.json({ schedules: [], invoices: [], data: [] }); };
  await ghlFindSchedules(ENV, 'BTT tab #1-abcd', impl);
  await ghlListInvoices(ENV, 'c_1', impl);
  await ghlListTransactions(ENV, 'c_1', impl);
  assert.equal(calls.length, 3);
  for (const u of calls) {
    assert.equal(u.searchParams.get('altId'), 'LOC123');
    assert.equal(u.searchParams.get('altType'), 'location');
    assert.equal(u.searchParams.get('offset'), '0');
    assert.match(u.searchParams.get('limit'), /^\d+$/);
  }
  assert.equal(calls[0].searchParams.get('search'), 'BTT tab #1-abcd');
});

test('a created schedule id is read wherever the response put it, and a miss names the keys', async () => {
  assert.equal(pickId({ _id: 'a' }), 'a');
  assert.equal(pickId({ id: 'b' }), 'b');
  assert.equal(pickId({ schedule: { _id: 'c' } }), 'c');
  assert.equal(pickId({ data: { schedule: { _id: 'd' } } }), 'd');
  assert.equal(pickId({ invoiceSchedule: { id: 'e' } }), 'e');
  assert.equal(pickId({ scheduleId: 'f' }), 'f');
  assert.equal(pickId({ status: 'ok', _id: 42 }), null, 'a number is not an id');
  assert.equal(pickId({ deep: { deeper: { deepest: { _id: 'no' } } } }), null);
  const impl = async () => Response.json({ traceId: 't', schedule: { _id: 'sch_1', name: 'x' } });
  const r = await ghlCreateSchedule(ENV, { name: 'x' }, impl);
  assert.equal(r.id, 'sch_1');
  const miss = await ghlCreateSchedule(ENV, { name: 'x' }, async () => Response.json({ traceId: 't', message: 'ok' }));
  assert.equal(miss.id, null);
  assert.deepEqual(miss.keys, ['traceId', 'message']);
});

test('a schedule read is unwrapped from the usual wrapper keys', async () => {
  assert.deepEqual(unwrap({ schedule: { _id: 'a', status: 'active' } }), { _id: 'a', status: 'active' });
  assert.deepEqual(unwrap({ data: { _id: 'b' } }), { _id: 'b' });
  assert.deepEqual(unwrap({ _id: 'c', status: 'draft' }), { _id: 'c', status: 'draft' });
  assert.deepEqual(unwrap({ data: [1] }), { data: [1] }, 'a list is not the object');
  // The live shape: the schedule at the top level, with its own schedule.executeAt inside.
  const live = { _id: 'sch_live', status: 'draft', autoPayment: { enable: false }, schedule: { executeAt: '2026-09-27T02:10:00Z' } };
  assert.equal(unwrap(live), live, 'never dives into schedule.executeAt');
  assert.equal(unwrap({ status: 'draft', schedule: { executeAt: 'x' } }).status, 'draft');
  const s = await ghlGetSchedule(ENV, 'sch_1', async () => Response.json({ traceId: 't', invoiceSchedule: { _id: 'sch_1', status: 'scheduled' } }));
  assert.equal(s.status, 'scheduled');
});
