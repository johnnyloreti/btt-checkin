import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContact, buildRoster, rosterConfig, parseList, syncRoster } from '../src/roster.js';
import { loadSchedule } from '../src/schedule.js';
import { readRepoFile } from './helpers.js';
import { memoryD1 } from './d1.js';
import { CONTACTS } from './fixtures/contacts.js';

const schedule = loadSchedule(readRepoFile('schedule.json'));
const ENV = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-' };
const cfg = rosterConfig(ENV, schedule);
const NOW = new Date('2026-09-05T18:00:00Z');

const byId = (id) => CONTACTS.find((c) => c.id === id);

test('parseList splits, trims, lowercases, drops empties', () => {
  assert.deepEqual(parseList(' founding-member , Foundations-,, '), ['founding-member', 'foundations-']);
  assert.deepEqual(parseList(undefined), []);
});

test('founding-member exact tag makes a member', () => {
  assert.equal(classifyContact(byId('c_jack'), cfg).isMember, true);
});

test('foundations- prefix makes a member, including future cohorts', () => {
  assert.equal(classifyContact(byId('c_maria'), cfg).isMember, true);
  assert.equal(classifyContact(byId('c_future'), cfg).isMember, true);
});

test('program tag without a member tag is not a member', () => {
  assert.equal(classifyContact(byId('c_lead'), cfg).isMember, false);
  assert.equal(classifyContact(byId('c_nobody'), cfg).isMember, false);
  assert.equal(classifyContact(byId('c_notags'), cfg).isMember, false);
});

test('program tags parse case-insensitively and in schedule order', () => {
  assert.deepEqual(classifyContact(byId('c_jack'), cfg).programs, ['kids-6-9']);
  assert.deepEqual(classifyContact(byId('c_emma'), cfg).programs, ['kids-6-9']);
  assert.deepEqual(classifyContact(byId('c_leo'), cfg).programs, ['kids-10-14', 'adult']);
  assert.deepEqual(classifyContact(byId('c_dan'), cfg).programs, ['adult']);
});

test('foundations without a program tag is adult, silently', () => {
  const r = classifyContact(byId('c_maria'), cfg);
  assert.deepEqual(r.programs, ['adult']);
  assert.equal(r.flag, null);
});

test('founding-member without a program tag is adult and flagged', () => {
  const r = classifyContact(byId('c_sam'), cfg);
  assert.deepEqual(r.programs, ['adult']);
  assert.match(r.flag, /no program tag/);
});

test('buildRoster keeps members only, flags by name, skips blank first names', () => {
  const { members, flagged } = buildRoster(CONTACTS, cfg);
  assert.deepEqual(
    members.map((m) => m.ghl_contact_id),
    ['c_jack', 'c_emma', 'c_leo', 'c_maria', 'c_dan', 'c_future', 'c_sam'],
  );
  assert.deepEqual(
    flagged.map((f) => `${f.name}: ${f.reason}`),
    ['Sam Untagged: no program tag, defaulted to adult', 'Blank: no first name, skipped'],
  );
  assert.equal(members.find((m) => m.ghl_contact_id === 'c_maria').first_name, 'María');
});

test('syncRoster writes members, logs ok with flagged names', async () => {
  const DB = memoryD1();
  const result = await syncRoster({ ...ENV, DB }, schedule, {
    fetchContacts: async () => ({ contacts: CONTACTS, pages: 2 }),
    now: NOW,
  });
  assert.equal(result.outcome, 'ok');
  assert.equal(result.members, 7);
  assert.equal(result.contacts, CONTACTS.length);
  assert.equal(result.deactivated, 0);
  assert.deepEqual(result.flagged, [
    'Sam Untagged: no program tag, defaulted to adult',
    'Blank: no first name, skipped',
  ]);

  const rows = DB.raw.prepare('SELECT * FROM members ORDER BY ghl_contact_id').all();
  assert.equal(rows.length, 7);
  const leo = rows.find((r) => r.ghl_contact_id === 'c_leo');
  assert.deepEqual(JSON.parse(leo.programs), ['kids-10-14', 'adult']);
  assert.equal(leo.active, 1);
  assert.equal(leo.synced_at, NOW.toISOString());

  const log = DB.raw.prepare('SELECT * FROM sync_log').all();
  assert.equal(log.length, 1);
  assert.equal(log[0].job, 'roster');
  assert.equal(log[0].outcome, 'ok');
  assert.match(log[0].detail, /Sam Untagged/);
});

test('a contact that loses its member tags goes inactive, never deleted', async () => {
  const DB = memoryD1();
  const env = { ...ENV, DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: NOW });

  // Give Jack some attendance, then drop his tags on the next sync.
  DB.raw
    .prepare(
      "INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method) VALUES ('c_jack', 'Kids 6-9', '2026-09-05T11:00', '2026-09-05T14:55:00Z', 'kiosk')",
    )
    .run();
  const later = new Date(NOW.getTime() + 30 * 60 * 1000);
  const next = CONTACTS.map((c) => (c.id === 'c_jack' ? { ...c, tags: ['past-member'] } : c));
  const result = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: next, pages: 1 }), now: later });

  assert.equal(result.outcome, 'ok');
  assert.equal(result.deactivated, 1);
  const jack = DB.raw.prepare("SELECT * FROM members WHERE ghl_contact_id = 'c_jack'").get();
  assert.equal(jack.active, 0);
  assert.equal(jack.synced_at, NOW.toISOString());
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM attendance WHERE ghl_contact_id = 'c_jack'").get().n, 1);

  // Tags back, member back.
  const again = new Date(later.getTime() + 30 * 60 * 1000);
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: again });
  assert.equal(DB.raw.prepare("SELECT active FROM members WHERE ghl_contact_id = 'c_jack'").get().active, 1);
});

test('re-sync updates names and programs in place', async () => {
  const DB = memoryD1();
  const env = { ...ENV, DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: NOW });
  const next = CONTACTS.map((c) =>
    c.id === 'c_sam' ? { ...c, lastName: 'Tagged', tags: ['founding-member', 'program:kids-3-5'] } : c,
  );
  const result = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: next, pages: 1 }), now: NOW });
  assert.deepEqual(result.flagged, ['Blank: no first name, skipped']);
  const sam = DB.raw.prepare("SELECT * FROM members WHERE ghl_contact_id = 'c_sam'").get();
  assert.equal(sam.last_name, 'Tagged');
  assert.deepEqual(JSON.parse(sam.programs), ['kids-3-5']);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM members').get().n, 7);
});

test('zero members from GHL logs degraded and leaves the table untouched', async () => {
  const DB = memoryD1();
  const env = { ...ENV, DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: NOW });
  const before = DB.raw.prepare('SELECT * FROM members ORDER BY ghl_contact_id').all();

  for (const contacts of [[], [byId('c_lead'), byId('c_nobody')]]) {
    const result = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts, pages: 1 }), now: new Date() });
    assert.equal(result.outcome, 'degraded');
    assert.match(result.reason, /untouched/);
  }

  const after = DB.raw.prepare('SELECT * FROM members ORDER BY ghl_contact_id').all();
  assert.deepEqual(after, before);
  const outcomes = DB.raw.prepare('SELECT outcome FROM sync_log ORDER BY id').all().map((r) => r.outcome);
  assert.deepEqual(outcomes, ['ok', 'degraded', 'degraded']);
});

test('a GHL failure logs failed and leaves the table untouched', async () => {
  const DB = memoryD1();
  const env = { ...ENV, DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: NOW });
  const result = await syncRoster(env, schedule, {
    fetchContacts: async () => {
      throw new Error('GHL 401 on /contacts/');
    },
    now: new Date(),
  });
  assert.equal(result.outcome, 'failed');
  assert.match(result.error, /401/);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM members WHERE active = 1').get().n, 7);
  const last = DB.raw.prepare('SELECT outcome, detail FROM sync_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(last.outcome, 'failed');
  assert.match(last.detail, /401/);
});
