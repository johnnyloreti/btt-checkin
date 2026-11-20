// The monthly podium on the member progress page (§15.13): the top three for
// classes this month, kids and adults apart, by first name and last initial.
// The one place a member sees anything about another member, so these tests
// pin what it shows, who is on it, and how a family is kept off it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, health } from '../src/app.js';
import { syncRoster, buildRoster, rosterConfig } from '../src/roster.js';
import { boardEnabled, boardSize, boardHideTag, boardGroup, boardName, monthOf, podiums, DEFAULT_HIDE_TAG } from '../src/board.js';
import { progressToken } from '../src/progress.js';
import { loadSchedule } from '../src/schedule.js';
import { opaqueId } from '../src/ids.js';
import { resetFallback } from '../src/ratelimit.js';
import { ageSchemaCaps } from '../src/schema-caps.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const SALT = 'unit-test-salt-value';
const NOW = new Date('2026-09-23T15:00:00Z'); // Wed Sep 23, 11:00 ET
const PARENT = 'PARENTcontact0000001';

async function setup({ extraEnv = {}, noBoard = false, contacts = CONTACTS } = {}) {
  resetFallback();
  const DB = memoryD1({ noBoard });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York', DB, ...extraEnv,
  };
  const sync = (list = contacts, at = new Date(NOW.getTime() - 3600_000)) => syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: list, pages: 1 }), now: at });
  const first = await sync();
  let at = NOW;
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => at });
  const call = (path, opts = {}) => app.fetch(new Request(`https://x.test${path}`, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1' }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), env, { waitUntil: () => {} });
  // `times` classes for a member, one a day counting back from `last`.
  const train = (contactId, times, last = '2026-09-22', status = 'attended') => {
    const ins = DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method, status) VALUES (?, 'Kids 6-9', ?, ?, 'kiosk', ?)");
    const end = new Date(`${last}T12:00:00Z`);
    for (let i = 0; i < times; i += 1) {
      const d = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      ins.run(contactId, `${d}T16:30`, `${d}T20:30:00Z`, status);
    }
  };
  const link = (kid, parent) => DB.raw.prepare('UPDATE members SET payer_contact_id = ? WHERE ghl_contact_id = ?').run(parent, kid);
  const page = async (contactId) => (await call(`/api/progress?t=${await progressToken(contactId, SALT)}`)).json();
  const boards = async (contactId) => (await page(contactId)).boards;
  return { env, DB, call, train, link, page, boards, sync, first, setNow: (d) => { at = d; } };
}

// ---------- pure ----------

test('config: on unless switched off, three places, and a tag that keeps a member off', () => {
  assert.equal(boardEnabled({}), true);
  for (const v of ['off', '0', 'false', 'OFF']) assert.equal(boardEnabled({ LEADERBOARD: v }), false, v);
  assert.equal(boardSize({}), 3);
  assert.equal(boardSize({ LEADERBOARD_SIZE: '5' }), 5);
  assert.equal(boardSize({ LEADERBOARD_SIZE: '0' }), 3);
  assert.equal(boardSize({ LEADERBOARD_SIZE: 'all' }), 3);
  assert.equal(boardSize({ LEADERBOARD_SIZE: '99' }), 10);
  assert.equal(boardHideTag({}), DEFAULT_HIDE_TAG);
  assert.equal(DEFAULT_HIDE_TAG, 'leaderboard-hide');
  assert.equal(boardHideTag({ LEADERBOARD_HIDE_TAG: ' No-Board ' }), 'no-board');
  assert.equal(boardHideTag({ LEADERBOARD_HIDE_TAG: '' }), '', 'blank: nobody is kept off by tag');
});

test('a name on the board is a first name and a last initial, never more', () => {
  assert.equal(boardName('Jack', 'Silva'), 'Jack S.');
  assert.equal(boardName('María', 'núñez'), 'María N.');
  assert.equal(boardName('Daniela', 'De Assis'), 'Daniela D.');
  assert.equal(boardName('Alice', ''), 'Alice');
  assert.equal(boardName('Alice', null), 'Alice');
});

test('groups: any kids program is the kids board, everyone else the adult board', () => {
  assert.equal(boardGroup(['kids-6-9']), 'kids');
  assert.equal(boardGroup(['adult']), 'adults');
  assert.equal(boardGroup(['kids-10-14', 'adult']), 'kids', 'a teen in both is ranked with the kids');
  assert.equal(boardGroup([]), 'adults');
});

test('months: the calendar month, its edges, and the one before, across a year end', () => {
  assert.deepEqual(monthOf('2026-09-23'), { key: '2026-09', name: 'September', from: '2026-09-01T00:00', to: '2026-10-01T00:00' });
  assert.deepEqual(monthOf('2026-09-23', 1), { key: '2026-08', name: 'August', from: '2026-08-01T00:00', to: '2026-09-01T00:00' });
  assert.deepEqual(monthOf('2026-12-31'), { key: '2026-12', name: 'December', from: '2026-12-01T00:00', to: '2027-01-01T00:00' });
  assert.deepEqual(monthOf('2027-01-02', 1), { key: '2026-12', name: 'December', from: '2026-12-01T00:00', to: '2027-01-01T00:00' });
});

// ---------- the board ----------

test('the top three for the month, most classes first, with the page\'s own member marked', async () => {
  const { train, boards } = await setup();
  train('c_jack', 5);
  train('c_emma', 8);
  train('c_newkid', 3);
  train('c_leo', 1);
  const [kids, ...rest] = await boards('c_jack');
  assert.deepEqual(rest, [], 'a kid\'s page has the kids board and no other');
  assert.deepEqual([kids.group, kids.title, kids.month, kids.monthName, kids.final], ['kids', 'Kids', '2026-09', 'September', false]);
  assert.deepEqual(kids.podium, [
    { place: 1, name: 'Emma J.', classes: 8, you: false },
    { place: 2, name: 'Jack S.', classes: 5, you: true },
    { place: 3, name: 'Nora N.', classes: 3, you: false },
  ]);
});

test('nothing on the board but a first name, an initial and a count: no last name, no id', async () => {
  const { train, page } = await setup();
  train('c_jack', 2);
  train('c_emma', 4);
  const text = JSON.stringify((await page('c_jack')).boards);
  for (const leak of ['Jones', 'Silva', 'c_emma', 'c_jack', 'ghl_contact_id', 'programs']) assert.ok(!text.includes(leak), leak);
});

test('a tie goes to whoever got there first, and the order holds from one look to the next', async () => {
  const { train, boards } = await setup();
  train('c_jack', 4, '2026-09-22'); // reached four on the 22nd
  train('c_emma', 4, '2026-09-19'); // reached four on the 19th
  train('c_newkid', 4, '2026-09-21');
  const order = async () => (await boards('c_jack'))[0].podium.map((p) => p.name);
  assert.deepEqual(await order(), ['Emma J.', 'Nora N.', 'Jack S.']);
  assert.deepEqual(await order(), ['Emma J.', 'Nora N.', 'Jack S.']);
});

test('only this month counts, a removed check-in is not a class, and someone inactive is not on it', async () => {
  const { train, boards, DB } = await setup();
  train('c_jack', 2, '2026-09-22');
  train('c_jack', 20, '2026-08-31'); // all of it last month
  train('c_emma', 6, '2026-09-10', 'voided');
  train('c_emma', 1, '2026-09-22');
  train('c_newkid', 9, '2026-09-22');
  DB.raw.prepare("UPDATE members SET active = 0 WHERE ghl_contact_id = 'c_newkid'").run();
  assert.deepEqual((await boards('c_jack'))[0].podium.map((p) => [p.name, p.classes]), [['Jack S.', 2], ['Emma J.', 1]]);
});

test('kids and adults are ranked apart, and a page shows the board for whoever is on it', async () => {
  const { train, boards, link } = await setup();
  train('c_jack', 3);
  train('c_dan', 9);
  train('c_maria', 4);
  const adult = await boards('c_dan');
  assert.deepEqual(adult.map((b) => b.group), ['adults']);
  assert.deepEqual(adult[0].podium.map((p) => [p.name, p.you]), [['Dan K.', true], ['María N.', false]]);
  assert.deepEqual((await boards('c_jack')).map((b) => b.group), ['kids']);

  // A parent's page has their kids on it, so it shows the kids board. The
  // parent does not train, so there is no adult board to show.
  link('c_jack', PARENT);
  const family = await boards(PARENT);
  assert.deepEqual(family.map((b) => b.group), ['kids']);
  assert.equal(family[0].podium[0].you, true);
});

test('before anyone trains in a new month, last month\'s top three stand, and say so', async () => {
  const { train, boards, setNow } = await setup();
  train('c_jack', 6, '2026-09-22');
  train('c_emma', 2, '2026-09-22');
  setNow(new Date('2026-10-01T13:00:00Z')); // the morning of the 1st
  let [kids] = await boards('c_jack');
  assert.deepEqual([kids.month, kids.monthName, kids.final], ['2026-09', 'September', true]);
  assert.deepEqual(kids.podium.map((p) => p.name), ['Jack S.', 'Emma J.']);
  // The first class of October starts the new board.
  train('c_emma', 1, '2026-10-01');
  [kids] = await boards('c_jack');
  assert.deepEqual([kids.month, kids.final, kids.podium.map((p) => p.name)], ['2026-10', false, ['Emma J.']]);
});

test('with no classes this month or last there is no board at all', async () => {
  const { train, boards } = await setup();
  train('c_jack', 5, '2026-07-10');
  assert.deepEqual(await boards('c_jack'), []);
});

test('LEADERBOARD_SIZE widens it, and switching it off removes it from the page', async () => {
  const wide = await setup({ extraEnv: { LEADERBOARD_SIZE: '5' } });
  for (const [id, n] of [['c_jack', 5], ['c_emma', 4], ['c_newkid', 3], ['c_leo', 2]]) wide.train(id, n);
  assert.equal((await wide.boards('c_jack'))[0].podium.length, 4);
  const off = await setup({ extraEnv: { LEADERBOARD: 'off' } });
  off.train('c_jack', 5);
  const page = await off.page('c_jack');
  assert.deepEqual(page.boards, []);
  assert.equal(page.people.length, 1, 'their own page is untouched');
});

// ---------- keeping a member off ----------

test('the tag on a member keeps them off, and taking it away puts them back', async () => {
  const tagged = CONTACTS.map((c) => (c.id === 'c_emma' ? { ...c, tags: [...c.tags, 'Leaderboard-Hide'] } : c));
  const { train, boards, sync, first, DB } = await setup({ contacts: tagged });
  assert.equal(first.offPodium, 1, 'the sync says how many are kept off');
  assert.equal(DB.raw.prepare("SELECT board_hidden FROM members WHERE ghl_contact_id = 'c_emma'").get().board_hidden, 1);
  train('c_emma', 9);
  train('c_jack', 2);
  assert.deepEqual((await boards('c_jack'))[0].podium.map((p) => p.name), ['Jack S.']);
  // Emma's own page still shows her numbers, and the board she is not on.
  const emma = await boards('c_emma');
  assert.deepEqual(emma[0].podium.map((p) => [p.name, p.you]), [['Jack S.', false]]);

  const again = await sync(CONTACTS, NOW);
  assert.equal(again.offPodium, 0);
  assert.deepEqual((await boards('c_jack'))[0].podium.map((p) => p.name), ['Emma J.', 'Jack S.']);
});

test('the tag on a linked parent keeps their kids off; a blank tag keeps nobody off', () => {
  const FIELD = 'fld_payer';
  const contacts = [
    { id: 'KIDcontact0000000001', firstName: 'Ana', lastName: 'Lima', tags: ['program:kids-6-9'], customFields: [{ id: FIELD, value: PARENT }] },
    { id: 'KIDcontact0000000002', firstName: 'Bia', lastName: 'Lima', tags: ['program:kids-3-5'], customFields: [{ id: FIELD, value: PARENT }] },
    { id: 'KIDcontact0000000003', firstName: 'Caio', lastName: 'Reis', tags: ['program:kids-6-9'], customFields: [] },
    { id: PARENT, firstName: 'Paula', lastName: 'Lima', tags: ['program:none', 'leaderboard-hide'], customFields: [] },
  ];
  const cfg = { ...rosterConfig({ MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-' }, schedule), payerFieldId: FIELD };
  const hidden = Object.fromEntries(buildRoster(contacts, cfg).members.map((m) => [m.first_name, m.board_hidden]));
  assert.deepEqual(hidden, { Ana: 1, Bia: 1, Caio: 0 });
  const none = { ...rosterConfig({ MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', LEADERBOARD_HIDE_TAG: '' }, schedule), payerFieldId: FIELD };
  assert.deepEqual(buildRoster(contacts, none).members.map((m) => m.board_hidden), [0, 0, 0]);
});

// ---------- migration 009 ----------

test('before migration 009: no board, the page and check-in and the sync all work, /health names the file, and running it is noticed', async () => {
  const { env, DB, train, page, call, sync, first } = await setup({ noBoard: true });
  assert.equal(first.outcome, 'ok');
  assert.equal(first.offPodium, null, 'not counted, rather than counted as none');
  train('c_jack', 5);
  const before = await page('c_jack');
  assert.equal(before.ok, true);
  assert.deepEqual(before.boards, [], 'hidden: nobody could be kept off it yet');
  assert.equal(before.people[0].lifetime, 5);
  const checkin = await call('/api/checkin', { method: 'POST', body: { contactId: await opaqueId('c_jack', SALT), classStartLocal: '2026-09-23T16:30', className: 'Kids 6-9', clientTs: NOW.toISOString() } });
  assert.equal(checkin.status, 200);
  const h = await health(env, schedule, NOW);
  assert.equal(h.ok, false);
  assert.ok(JSON.stringify(h).includes('009_leaderboard.sql'));
  assert.deepEqual(await podiums(env, schedule, [{ ghl_contact_id: 'c_jack', programs: ['kids-6-9'] }], NOW), []);

  DB.raw.exec(readRepoFile('src/db/migrations/009_leaderboard.sql'));
  ageSchemaCaps();
  assert.equal((await sync(CONTACTS, NOW)).offPodium, 0);
  assert.equal((await page('c_jack')).boards[0].podium[0].name, 'Jack S.');
  assert.ok(!JSON.stringify(await health(env, schedule, NOW)).includes('009_leaderboard.sql'));
});

test('switched off, /health does not ask for the migration', async () => {
  const { env } = await setup({ noBoard: true, extraEnv: { LEADERBOARD: 'off' } });
  assert.ok(!JSON.stringify(await health(env, schedule, NOW)).includes('009_leaderboard.sql'));
});
