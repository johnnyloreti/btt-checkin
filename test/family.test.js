// The Family box on the staff member screen (§15.10): a parent and the kids
// linked to them, built from members.payer_contact_id. Staff-only, read-only,
// and switched off unless FAMILY_VIEW says on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { familyEnabled, household } from '../src/family.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-23T15:00:00Z'); // Wed Sep 23, 11:00 ET
const AWAY_PARENT = 'PARENTcontact0000001'; // does not train: not in members
const MAT_PARENT = 'TRAINparent000000001'; // trains: a members row of their own

async function setup({ extraEnv = {}, noPayer = false, noBelt = false } = {}) {
  resetFallback();
  const DB = memoryD1({ noPayer, noBelt });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York',
    WAIVER_TAG: 'waiver-signed', FAMILY_VIEW: 'on', DB, ...extraEnv,
  };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
  DB.raw.prepare("INSERT INTO members (ghl_contact_id, first_name, last_name, programs, active, synced_at) VALUES (?, 'Rosa', 'Silva', '[\"adult\"]', 1, ?)").run(MAT_PARENT, NOW.toISOString());
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => NOW });
  let cookie = '';
  const call = (path, { method = 'GET', body } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const attend = (contactId, startLocal, status = 'attended') =>
    DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status) VALUES (?, 'Kids 6-9', ?, ?, 'kiosk', ?)")
      .run(contactId, startLocal, `${startLocal}:00Z`, status);
  const link = (kid, parent) => { if (!noPayer) DB.raw.prepare('UPDATE members SET payer_contact_id = ? WHERE ghl_contact_id = ?').run(parent, kid); };
  const family = async (contactId) => (await (await call(`/api/staff/member?id=${await opaqueId(contactId, SALT)}`)).json()).family;
  return { env, DB, call, attend, link, family };
}

test('off unless FAMILY_VIEW says on', async () => {
  assert.equal(familyEnabled({}), false);
  for (const v of ['off', '0', 'false', '', 'yes please']) assert.equal(familyEnabled({ FAMILY_VIEW: v }), false, v);
  for (const v of ['on', 'ON', ' on ', '1', 'true']) assert.equal(familyEnabled({ FAMILY_VIEW: v }), true, v);
  const { family, link } = await setup({ extraEnv: { FAMILY_VIEW: 'off' } });
  link('c_jack', AWAY_PARENT);
  link('c_emma', AWAY_PARENT);
  assert.deepEqual(await family('c_jack'), { enabled: false });
});

test('siblings under a parent who does not train: both kids, each with their own numbers, and no name for the parent', async () => {
  const { family, link, attend } = await setup();
  link('c_jack', AWAY_PARENT);
  link('c_emma', AWAY_PARENT);
  attend('c_jack', '2026-09-22T16:30');
  attend('c_jack', '2026-09-15T16:30');
  attend('c_jack', '2026-08-01T11:00'); // older than 30 days
  attend('c_jack', '2026-09-17T16:30', 'voided'); // removed: not a class
  attend('c_emma', '2026-09-16T16:30');

  const f = await family('c_jack');
  assert.equal(f.enabled, true);
  assert.equal(f.parent, 'on_file');
  assert.deepEqual(f.people.map((p) => [p.first, p.self, p.parent, p.lifetime, p.last30, p.lastClass]), [
    ['Emma', false, false, 1, 1, '2026-09-16'],
    ['Jack', true, false, 3, 2, '2026-09-22'],
  ]);
  assert.deepEqual(f.people[0].programLabels, ['Kids 6-9']);
  assert.equal(f.people[0].rank.label, 'White belt');
  // Seen from the sibling, the same two, with the other one marked.
  const g = await family('c_emma');
  assert.deepEqual(g.people.map((p) => [p.first, p.self]), [['Emma', true], ['Jack', false]]);
  // The id is the kiosk's opaque one, so a tap can open that member. Never a contact id.
  assert.equal(f.people[0].id, await opaqueId('c_emma', SALT));
  const text = JSON.stringify(f);
  assert.ok(!text.includes('c_emma') && !text.includes(AWAY_PARENT), 'no contact id leaves the Worker');
});

test('a parent who trains heads the list, from their own screen and from a kid\'s', async () => {
  const { family, link, attend } = await setup();
  link('c_jack', MAT_PARENT);
  link('c_newkid', MAT_PARENT);
  attend(MAT_PARENT, '2026-09-22T18:15');
  for (const who of ['c_jack', MAT_PARENT]) {
    const f = await family(who);
    assert.equal(f.parent, 'trains', who);
    assert.deepEqual(f.people.map((p) => [p.first, p.parent]), [['Rosa', true], ['Jack', false], ['Nora', false]], who);
  }
  const f = await family(MAT_PARENT);
  assert.equal(f.people[0].self, true);
  assert.deepEqual(f.people[0].programLabels, ['Adult']);
  assert.equal(f.people[0].rank.label, 'White belt', 'an adult is ranked on the adult belts');
});

test('a member on their own has no box: no link, a link with no siblings, or a parent with no kids', async () => {
  const { family, link } = await setup();
  assert.deepEqual(await family('c_dan'), { enabled: true, parent: 'none', people: [] });
  link('c_jack', AWAY_PARENT);
  assert.deepEqual(await family('c_jack'), { enabled: true, parent: 'on_file', people: [] });
  assert.deepEqual(await family(MAT_PARENT), { enabled: true, parent: 'none', people: [] });
});

test('waiver, inactive and no classes yet are each shown as they are', async () => {
  const { family, link, DB, attend } = await setup();
  link('c_jack', AWAY_PARENT);
  link('c_emma', AWAY_PARENT);
  DB.raw.prepare("UPDATE members SET waiver = 1 WHERE ghl_contact_id = 'c_jack'").run();
  DB.raw.prepare("UPDATE members SET waiver = 0, active = 0 WHERE ghl_contact_id = 'c_emma'").run();
  attend('c_jack', '2026-09-22T16:30');
  const f = await family('c_jack');
  const [emma, jack] = f.people;
  assert.deepEqual([emma.waiver, emma.active, emma.lifetime, emma.last30, emma.lastClass], [false, false, 0, 0, null]);
  assert.deepEqual([jack.waiver, jack.active], [true, true]);
});

test('with the waiver feature off there is no waiver to show', async () => {
  const { family, link } = await setup({ extraEnv: { WAIVER_TAG: '' } });
  link('c_jack', AWAY_PARENT);
  link('c_emma', AWAY_PARENT);
  assert.deepEqual((await family('c_jack')).people.map((p) => p.waiver), [null, null]);
});

test('before migration 005 there are no links to read: the box is off and the member screen still loads', async () => {
  const { call, env } = await setup({ noPayer: true });
  const res = await call(`/api/staff/member?id=${await opaqueId('c_jack', SALT)}`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).family, { enabled: false });
  assert.deepEqual(await household(env, schedule, { ghl_contact_id: 'c_jack', programs: [] }, NOW), { enabled: false });
});

test('before migration 006 the family still lists, without ranks', async () => {
  const { family, link } = await setup({ noBelt: true });
  link('c_jack', AWAY_PARENT);
  link('c_emma', AWAY_PARENT);
  const f = await family('c_jack');
  assert.equal(f.people.length, 2);
  assert.deepEqual(f.people.map((p) => p.rank), [null, null]);
});
