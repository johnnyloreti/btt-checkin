import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllContacts, ghlGet, GhlError, GHL_BASE } from '../src/ghl.js';

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

test('ghlGet sends bearer token, version header, and only GET', async () => {
  const { impl, calls } = fakeFetch({ '': { contacts: [], meta: {} } });
  await ghlGet(ENV, '/contacts/', { locationId: 'LOC123', limit: 100, startAfterId: undefined }, impl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
  assert.equal(calls[0].init.headers.version, '2021-07-28');
  assert.equal(calls[0].url.origin, GHL_BASE);
  assert.equal(calls[0].url.searchParams.get('locationId'), 'LOC123');
  assert.equal(calls[0].url.searchParams.has('startAfterId'), false);
});

test('ghlGet throws GhlError on non-2xx', async () => {
  const impl = async () => new Response('nope', { status: 401 });
  await assert.rejects(() => ghlGet(ENV, '/contacts/', {}, impl), (e) => e instanceof GhlError && e.status === 401);
});

test('ghlGet refuses to run without a token', async () => {
  await assert.rejects(() => ghlGet({}, '/contacts/', {}, async () => Response.json({})), /GHL_TOKEN/);
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
