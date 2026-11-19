// The member login page (§15.9): pick a name, then the purchase PIN or a
// texted link. A right PIN hands back the account's progress link. Web
// guesses are counted apart from the kiosk's, so a stranger online can pause
// PIN login but can never lock a member out of the kiosk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { completeSetup, createSetupToken, verifyPin, pinStatus, pinActivity } from '../src/pin.js';
import { memberLogin, webFailures, linkAllowance, WEB_FAIL_LIMIT, WEB_GLOBAL_LIMIT, WEB_WINDOW_MS, WEB_LINKS_GLOBAL, WEB_PIN_LINKS_PER_DAY } from '../src/member.js';
import { progressToken, writeProgressLink } from '../src/progress.js';
import { loadSchedule } from '../src/schedule.js';
import { loadTabItems } from '../src/tab.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { resetSchemaCaps } from '../src/schema-caps.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const tabItems = loadTabItems(readRepoFile('tab-items.json'));
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-23T15:00:00Z');
const PARENT = 'PARENTcontact0000001';

async function setup({ extraEnv = {}, noTab = false, deps = {} } = {}) {
  resetFallback();
  const DB = memoryD1({ noTab });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York',
    PUBLIC_ORIGIN: 'https://checkin.bttbridgewater.com', PROGRESS_FIELD: 'progress_link',
    TAB_ITEMS: 'water,hydration', TAB_PROGRAMS: 'adult', PIN_PEPPER: 'a-long-pepper-for-tests', DB, ...extraEnv,
  };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
  let at = NOW;
  const sent = { progress: [], pin: [] };
  const app = createApp(schedule, {
    runRosterSync: async () => ({ outcome: 'ok' }),
    notifyWaiver: async () => ({ ok: true }),
    progressLink: async (e, contactId, url, when, opts) => { sent.progress.push([contactId, url, opts || null]); return { ok: true }; },
    pinLink: async (e, contactId, link) => { sent.pin.push([contactId, link]); return { ok: true }; },
    now: () => at,
    ...deps,
  }, { tabItems });
  // Each caller its own address, so the 60-a-minute limit never trips here.
  let n = 0;
  const call = (path, { method = 'GET', body, ip } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip || `10.0.${Math.floor(n / 200)}.${(n++ % 200) + 1}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const givePin = async (contactId, pin) => {
    const t = await createSetupToken(env, contactId, 'staff', at);
    assert.equal((await completeSetup(env, t.token, pin, at)).ok, true);
  };
  const login = async (contactId, pin) => call('/api/member/login', { method: 'POST', body: { contactId: await opaqueId(contactId, SALT), pin } });
  const link = (kid, parent) => DB.raw.prepare('UPDATE members SET payer_contact_id = ? WHERE ghl_contact_id = ?').run(parent, kid);
  const tick = (ms) => { at = new Date(at.getTime() + ms); };
  return { env, DB, call, givePin, login, link, sent, tick, at: () => at };
}

test('options say what the page can offer', async () => {
  const on = await setup();
  assert.deepEqual(await (await on.call('/api/member/options')).json(), { enabled: true, canPin: true, canText: true });
  const noField = await setup({ extraEnv: { PROGRESS_FIELD: '' } });
  assert.deepEqual(await (await noField.call('/api/member/options')).json(), { enabled: true, canPin: true, canText: false });
  const noTab = await setup({ noTab: true });
  assert.deepEqual(await (await noTab.call('/api/member/options')).json(), { enabled: true, canPin: false, canText: true }, 'no PIN tables, no PIN login');
  const noPepper = await setup({ extraEnv: { PIN_PEPPER: '' } });
  assert.equal((await (await noPepper.call('/api/member/options')).json()).canPin, false);
  resetSchemaCaps();
});

test('the right PIN opens the page: the link back is the member\'s own', async () => {
  const { givePin, login, call } = await setup();
  await givePin('c_dan', '4821');
  const res = await login('c_dan', '4821');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, url: `/me?t=${await progressToken('c_dan', SALT)}` });
  // And that link really is the page.
  const page = await (await call(`/api/progress?t=${body.url.slice(-32)}`)).json();
  assert.deepEqual(page.people.map((p) => p.first), ['Dan']);
});

test('a kid is opened with the parent\'s PIN, and the page is the family\'s', async () => {
  const { givePin, login, link, call } = await setup();
  link('c_jack', PARENT);
  link('c_emma', PARENT);
  await givePin(PARENT, '7007');
  await givePin('c_jack', '2468'); // a PIN on the kid's own contact is not the account's
  assert.equal((await login('c_jack', '2468')).status, 401);
  const res = await login('c_jack', '7007');
  assert.equal(res.status, 200);
  const { url } = await res.json();
  assert.equal(url, `/me?t=${await progressToken(PARENT, SALT)}`);
  const page = await (await call(`/api/progress?t=${url.slice(-32)}`)).json();
  assert.deepEqual(page.people.map((p) => p.first), ['Emma', 'Jack']);
  // Either kid's tile works with the same PIN.
  assert.equal((await login('c_emma', '7007')).status, 200);
});

test('wrong, missing and malformed PINs each say what happened', async () => {
  const { givePin, login, call } = await setup();
  await givePin('c_dan', '4821');
  const wrong = await login('c_dan', '0000');
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { ok: false, reason: 'wrong', left: WEB_FAIL_LIMIT - 1 });
  const none = await login('c_jack', '4821');
  assert.equal(none.status, 409);
  assert.equal((await none.json()).reason, 'no_pin');
  for (const bad of ['', '12', '12345', 'abcd', null]) {
    const r = await login('c_dan', bad);
    assert.equal(r.status, 400, String(bad));
    assert.equal((await r.json()).reason, 'bad_format');
  }
  assert.equal((await call('/api/member/login', { method: 'POST', body: { contactId: 'f'.repeat(20), pin: '4821' } })).status, 404);
  assert.equal((await call('/api/member/login', { method: 'POST' })).status, 400);
});

test('five wrong tries pause that account for a day, even for the right PIN; others are unaffected', async () => {
  const { env, givePin, login, tick, at } = await setup();
  await givePin('c_dan', '4821');
  await givePin('c_maria', '5150');
  for (let i = 1; i <= WEB_FAIL_LIMIT; i += 1) {
    const r = await (await login('c_dan', '0000')).json();
    assert.deepEqual([r.reason, r.left], ['wrong', WEB_FAIL_LIMIT - i]);
  }
  const paused = await login('c_dan', '4821');
  assert.equal(paused.status, 423, 'the right PIN is refused too');
  assert.equal((await paused.json()).reason, 'paused');
  assert.equal((await login('c_maria', '5150')).status, 200, 'another member logs in fine');
  assert.deepEqual(await webFailures(env, 'c_dan', at()), { own: 5, all: 5 });

  // Just short of a day: still paused. A day after the first wrong try: open again.
  tick(WEB_WINDOW_MS - 60_000);
  assert.equal((await login('c_dan', '4821')).status, 423);
  tick(120_000);
  assert.equal((await login('c_dan', '4821')).status, 200);
});

test('a burst of guesses sent together cannot outrun the limit', async () => {
  const { env, givePin, at } = await setup();
  await givePin('c_dan', '4821');
  // Twenty at once, the right PIN among them. Counting before writing let
  // every one of these read "no failures yet" and have its guess checked.
  const pins = Array.from({ length: 19 }, (_, i) => String(3000 + i * 37)).concat('4821');
  const results = await Promise.all(pins.map((p) => memberLogin(env, 'c_dan', p, at())));
  const checked = results.filter((r) => r.ok || r.reason === 'wrong').length;
  assert.ok(checked <= WEB_FAIL_LIMIT, `${checked} guesses were checked`);
  const after = await webFailures(env, 'c_dan', at());
  assert.ok(after.own <= WEB_FAIL_LIMIT, 'and no more than the limit were recorded');
  // Tries that were turned away gave their claim back, so they did not
  // start a pause of their own.
  assert.equal(after.own, results.filter((r) => r.reason === 'wrong').length);
  if (after.own < WEB_FAIL_LIMIT) assert.deepEqual(await memberLogin(env, 'c_dan', '4821', at()), { ok: true });
});

test('a right PIN leaves nothing behind, and a wrong one says how many tries are left', async () => {
  const { env, givePin, DB, at } = await setup();
  await givePin('c_dan', '4821');
  assert.deepEqual(await memberLogin(env, 'c_dan', '4821', at()), { ok: true });
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pin_failures').get().n, 0);
  assert.deepEqual(await memberLogin(env, 'c_dan', '5555', at()), { ok: false, reason: 'wrong', left: WEB_FAIL_LIMIT - 1 });
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pin_failures').get().n, 1);
  // During a pause nothing more is written, so guessing cannot stretch it.
  for (let i = 0; i < 10; i += 1) await memberLogin(env, 'c_dan', '5555', at());
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM pin_failures').get().n, WEB_FAIL_LIMIT);
});

test('guessing online never touches the kiosk: no lock on purchases, and a kiosk lock does not stop the login', async () => {
  const { env, givePin, login, at } = await setup();
  await givePin('c_dan', '4821');
  for (let i = 0; i < WEB_FAIL_LIMIT + 2; i += 1) await login('c_dan', '0000');
  assert.deepEqual(await pinStatus(env, 'c_dan', at()), { hasPin: true, locked: false, lockedUntil: null });
  assert.equal((await verifyPin(env, 'c_dan', '4821', at())).ok, true, 'the kiosk still takes the PIN');

  // The other way round: five wrong at the kiosk lock purchases, not the login.
  const other = await setup();
  await other.givePin('c_dan', '4821');
  for (let i = 0; i < 5; i += 1) await verifyPin(other.env, 'c_dan', '0000', other.at());
  assert.equal((await pinStatus(other.env, 'c_dan', other.at())).locked, true);
  assert.equal((await other.login('c_dan', '4821')).status, 200);
  assert.equal((await pinStatus(other.env, 'c_dan', other.at())).locked, true, 'and logging in does not clear the kiosk lock');
});

test('thirty wrong tries across accounts pause PIN login for everyone, and staff see the count', async () => {
  const { env, DB, givePin, login, at } = await setup();
  await givePin('c_dan', '4821');
  // Spread over many accounts, under the per-account limit on each.
  const ins = DB.raw.prepare('INSERT INTO pin_failures (payer_contact_id, failed_at) VALUES (?, ?)');
  for (let i = 0; i < WEB_GLOBAL_LIMIT - 1; i += 1) ins.run(`web:someone${i}`, at().toISOString());
  assert.equal((await login('c_dan', '4821')).status, 200, 'one short of the limit');
  ins.run('web:someoneelse', at().toISOString());
  const r = await login('c_dan', '4821');
  assert.equal(r.status, 423);
  assert.equal((await r.json()).reason, 'paused');
  assert.equal((await pinActivity(env, new Date(at().getTime() - 3600_000).toISOString(), at())).failed, WEB_GLOBAL_LIMIT, 'web guesses count on the staff page');
});

test('text me my link: written for the account, and it says nothing about who that is', async () => {
  const { call, link, sent } = await setup();
  const jack = await opaqueId('c_jack', SALT);
  let res = await call('/api/member/link', { method: 'POST', body: { contactId: jack } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, sent: true });
  link('c_jack', PARENT);
  res = await call('/api/member/link', { method: 'POST', body: { contactId: jack } });
  assert.deepEqual(await res.json(), { ok: true, sent: true }, 'no hint that it went to a parent');
  assert.deepEqual(sent.progress, [
    ['c_jack', `https://checkin.bttbridgewater.com/me?t=${await progressToken('c_jack', SALT)}`, null],
    [PARENT, `https://checkin.bttbridgewater.com/me?t=${await progressToken(PARENT, SALT)}`, null],
  ]);
  assert.equal((await call('/api/member/link', { method: 'POST', body: { contactId: 'f'.repeat(20) } })).status, 404);
});

test('text me my link: the Worker itself sends one a day per account, whoever taps and however often', async () => {
  const { call, link, sent, tick, DB } = await setup();
  const dan = await opaqueId('c_dan', SALT);
  const post = (id) => call('/api/member/link', { method: 'POST', body: { contactId: id } });
  assert.deepEqual(await (await post(dan)).json(), { ok: true, sent: true });
  for (let i = 0; i < 5; i += 1) {
    const again = await post(dan);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, sent: false, reason: 'today' });
  }
  assert.equal(sent.progress.length, 1, 'nothing more was written to GHL');

  // Two kids of one parent are one account: the second tap sends nothing.
  link('c_jack', PARENT);
  link('c_emma', PARENT);
  assert.equal((await (await post(await opaqueId('c_jack', SALT))).json()).sent, true);
  assert.equal((await (await post(await opaqueId('c_emma', SALT))).json()).sent, false);
  assert.equal(sent.progress.length, 2);

  // The next ET day it goes again. 15:00Z is 11 AM; 14 hours on is 1 AM the next day.
  tick(14 * 3600_000);
  assert.equal((await (await post(dan)).json()).sent, true);
  assert.equal(sent.progress.length, 3);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE job = 'member_link'").get().n, 3);
});

test('text me my link: a ceiling across every account in 24 hours, and a failed write is not counted', async () => {
  let fail = true;
  const sentTo = [];
  const { call, DB, env, at } = await setup({ deps: { progressLink: async (e, contactId) => { if (fail) return { ok: false, reason: 'GHL 500' }; sentTo.push(contactId); return { ok: true }; } } });
  const dan = await opaqueId('c_dan', SALT);
  const post = (id) => call('/api/member/link', { method: 'POST', body: { contactId: id } });
  assert.equal((await post(dan)).status, 502);
  fail = false;
  assert.equal((await (await post(dan)).json()).sent, true, 'the failed try did not use up the day');

  // Fill the ceiling with other accounts' sends, as if a stranger tapped every name.
  const ins = DB.raw.prepare("INSERT INTO sync_log (job, ran_at, outcome, detail) VALUES ('member_link', ?, 'ok', ?)");
  for (let i = 1; i < WEB_LINKS_GLOBAL; i += 1) ins.run(at().toISOString(), `someone${i}|2026-09-23`);
  const blocked = await post(await opaqueId('c_maria', SALT));
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { ok: false, reason: 'busy' });
  assert.deepEqual(sentTo, ['c_dan']);
  // A day later the ceiling has cleared.
  assert.deepEqual(await linkAllowance(env, 'c_maria', '2026-09-24', new Date(at().getTime() + WEB_WINDOW_MS + 1000)), { ok: true });
});

test('the stamp: a member\'s own request changes once a day, a staff send changes by the minute', async () => {
  const puts = [];
  const deps = { getFieldIds: async () => new Map([['progress_link', 'fld']]), putContact: async (id, fields) => { puts.push(fields[0].field_value); } };
  const env = { PROGRESS_FIELD: 'progress_link', TZ: 'America/New_York' };
  await writeProgressLink(env, deps, 'abc', 'u?t=1', new Date('2026-09-23T15:00:00Z'));
  await writeProgressLink(env, deps, 'abc', 'u?t=1', new Date('2026-09-23T21:30:00Z'));
  await writeProgressLink(env, deps, 'abc', 'u?t=1', new Date('2026-09-23T15:00:00Z'), { resend: true });
  await writeProgressLink(env, deps, 'abc', 'u?t=1', new Date('2026-09-23T15:07:00Z'), { resend: true });
  assert.deepEqual(puts, ['u?t=1&d=20260923', 'u?t=1&d=20260923', 'u?t=1&d=20260923&s=1500', 'u?t=1&d=20260923&s=1507']);
});

test('a link that could not be written is a failure the member is told about, and it is logged', async () => {
  const { call, DB } = await setup({ deps: { progressLink: async () => ({ ok: false, reason: 'custom field progress_link not found in GHL' }) } });
  const res = await call('/api/member/link', { method: 'POST', body: { contactId: await opaqueId('c_jack', SALT) } });
  assert.equal(res.status, 502);
  const row = DB.raw.prepare("SELECT outcome, detail FROM sync_log WHERE job = 'progress_link'").get();
  assert.equal(row.outcome, 'failed');
  assert.match(row.detail, /progress_link not found/);
});

test('set up or reset my PIN: a one-time link for the account, one per ten minutes', async () => {
  const { call, link, sent, tick, env, DB } = await setup();
  link('c_jack', PARENT);
  const jack = await opaqueId('c_jack', SALT);
  let r = await (await call('/api/member/pin-link', { method: 'POST', body: { contactId: jack } })).json();
  assert.deepEqual(r, { ok: true, sent: true });
  assert.equal(sent.pin.length, 1);
  assert.equal(sent.pin[0][0], PARENT, 'the parent sets the PIN for the account');
  assert.match(sent.pin[0][1], /^https:\/\/checkin\.bttbridgewater\.com\/pin\?t=[0-9a-f]{64}$/);
  r = await (await call('/api/member/pin-link', { method: 'POST', body: { contactId: jack } })).json();
  assert.deepEqual(r, { ok: true, sent: false, reason: 'recent' });
  assert.equal(sent.pin.length, 1);
  tick(10 * 60_000 + 1000);
  assert.equal((await (await call('/api/member/pin-link', { method: 'POST', body: { contactId: jack } })).json()).sent, true);

  // The link sets the PIN, and that PIN then logs the kid's family in.
  const token = sent.pin[1][1].split('t=')[1];
  const set = await call('/api/tab/pin-set', { method: 'POST', body: { token, pin: '3344' } });
  assert.equal(set.status, 200);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM purchase_pins WHERE payer_contact_id = ?').get(PARENT).n, 1);
  assert.equal((await memberLogin(env, PARENT, '3344', new Date())).ok, true);
});

test('set up or reset my PIN: no more than three links a day for one account', async () => {
  const { call, sent, tick } = await setup();
  const dan = await opaqueId('c_dan', SALT);
  const post = async () => (await call('/api/member/pin-link', { method: 'POST', body: { contactId: dan } })).json();
  for (let i = 0; i < WEB_PIN_LINKS_PER_DAY; i += 1) {
    assert.deepEqual(await post(), { ok: true, sent: true }, `link ${i + 1}`);
    tick(11 * 60_000);
  }
  assert.deepEqual(await post(), { ok: true, sent: false, reason: 'today' });
  assert.equal(sent.pin.length, WEB_PIN_LINKS_PER_DAY);
  tick(WEB_WINDOW_MS);
  assert.deepEqual(await post(), { ok: true, sent: true }, 'a day on, it sends again');
});

test('with the tab off there is no PIN to type or set, but the text link still works', async () => {
  const { call, sent } = await setup({ extraEnv: { TAB_ITEMS: '' } });
  const dan = await opaqueId('c_dan', SALT);
  const login = await call('/api/member/login', { method: 'POST', body: { contactId: dan, pin: '4821' } });
  assert.equal(login.status, 409);
  assert.equal((await login.json()).reason, 'off');
  assert.equal((await call('/api/member/pin-link', { method: 'POST', body: { contactId: dan } })).status, 409);
  assert.equal((await call('/api/member/link', { method: 'POST', body: { contactId: dan } })).status, 200);
  assert.equal(sent.progress.length, 1);
});

test('with no field named there is no text link', async () => {
  const { call } = await setup({ extraEnv: { PROGRESS_FIELD: '' } });
  const res = await call('/api/member/link', { method: 'POST', body: { contactId: await opaqueId('c_dan', SALT) } });
  assert.equal(res.status, 409);
});

test('the member routes are rate-limited like the kiosk\'s', async () => {
  const { call } = await setup();
  let last = null;
  for (let i = 0; i < 61; i += 1) last = await call('/api/member/options', { ip: '203.0.113.9' });
  assert.equal(last.status, 429);
});

test('switched off: no page and no routes', async () => {
  const { env, call } = await setup({ extraEnv: { PROGRESS_PAGE: 'off' } });
  env.ASSETS = { fetch: async () => new Response('page') };
  assert.equal((await call('/member')).status, 404);
  assert.equal((await call('/api/member/options')).status, 404);
  assert.equal((await call('/api/member/login', { method: 'POST', body: { contactId: await opaqueId('c_dan', SALT), pin: '4821' } })).status, 404);
});

test('/member serves the page', async () => {
  const { env, call } = await setup();
  env.ASSETS = { fetch: async (req) => new Response(new URL(req.url).pathname) };
  assert.equal(await (await call('/member')).text(), '/member.html');
  assert.equal(await (await call('/me?t=abc')).text(), '/me.html');
});
