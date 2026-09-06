import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, verifyToken, isStaff, readCookie, cookieHeader, COOKIE_NAME, SESSION_MS } from '../src/staff-auth.js';

const ENV = { STAFF_PIN: '1234', ID_SALT: 'unit-test-salt-value' };
const T0 = 1_800_000_000_000;

test('token verifies until it expires, 12 hours out', async () => {
  const token = await issueToken(ENV, T0);
  assert.equal(await verifyToken(ENV, token, T0 + 1000), true);
  assert.equal(await verifyToken(ENV, token, T0 + SESSION_MS - 1), true);
  assert.equal(await verifyToken(ENV, token, T0 + SESSION_MS), false);
  assert.equal(SESSION_MS, 12 * 60 * 60 * 1000);
});

test('token is bound to both secrets', async () => {
  const token = await issueToken(ENV, T0);
  assert.equal(await verifyToken({ ...ENV, STAFF_PIN: '9999' }, token, T0), false);
  assert.equal(await verifyToken({ ...ENV, ID_SALT: 'another-salt-value' }, token, T0), false);
  assert.equal(await verifyToken({ STAFF_PIN: '', ID_SALT: '' }, token, T0), false);
});

test('tampered or malformed tokens fail', async () => {
  const token = await issueToken(ENV, T0);
  const [exp, sig] = token.split('.');
  assert.equal(await verifyToken(ENV, `${Number(exp) + 100000}.${sig}`, T0), false, 'extended expiry');
  assert.equal(await verifyToken(ENV, `${exp}.${sig.replace(/./, (c) => (c === 'a' ? 'b' : 'a'))}`, T0), false);
  for (const bad of ['', 'x', '123.abc', null, undefined, 42]) assert.equal(await verifyToken(ENV, bad, T0), false);
});

test('isStaff accepts the cookie or the header, and nothing else', async () => {
  const token = await issueToken(ENV, T0);
  const withCookie = new Request('https://x.test/staff', { headers: { cookie: `other=1; ${COOKIE_NAME}=${token}` } });
  assert.equal(await isStaff(withCookie, ENV, T0), true);
  assert.equal(await isStaff(withCookie, ENV, T0 + SESSION_MS + 1), false, 'expired cookie');
  const withHeader = new Request('https://x.test/staff', { headers: { 'x-staff-pin': '1234' } });
  assert.equal(await isStaff(withHeader, ENV, T0), true);
  assert.equal(await isStaff(new Request('https://x.test/staff'), ENV, T0), false);
  assert.equal(await isStaff(new Request('https://x.test/staff', { headers: { 'x-staff-pin': '0000' } }), ENV, T0), false);
});

test('cookie helpers', () => {
  const req = new Request('https://x.test/', { headers: { cookie: 'a=1; btt_staff=abc.def; b=2' } });
  assert.equal(readCookie(req, 'btt_staff'), 'abc.def');
  assert.equal(readCookie(req, 'nope'), null);
  const secure = cookieHeader(new Request('https://x.test/'), 'tok', 60);
  assert.match(secure, /^btt_staff=tok; Path=\/; Max-Age=60; HttpOnly; SameSite=Strict; Secure$/);
  const local = cookieHeader(new Request('http://localhost:8787/'), 'tok', 60);
  assert.doesNotMatch(local, /Secure/);
});
