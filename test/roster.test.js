import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContact, buildRoster, rosterConfig, parseList, syncRoster, tidyName } from '../src/roster.js';
import { FIELD_KEYS, resetFieldCache } from '../src/rollup.js';
import { requiredFieldKeys } from '../src/fields.js';
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

test('a program tag alone makes a member', () => {
  const lead = classifyContact(byId('c_lead'), cfg);
  assert.equal(lead.isMember, true);
  assert.deepEqual(lead.programs, ['adult']);
  assert.equal(lead.flag, null);
  const kid = classifyContact(byId('c_newkid'), cfg);
  assert.equal(kid.isMember, true);
  assert.deepEqual(kid.programs, ['kids-3-5']);
});

test('no tags at all is not a member', () => {
  assert.equal(classifyContact(byId('c_nobody'), cfg).isMember, false);
  assert.equal(classifyContact(byId('c_notags'), cfg).isMember, false);
});

test('a misspelled program tag is flagged, and hides nobody who is otherwise a member', () => {
  const typo = classifyContact(byId('c_typo'), cfg);
  assert.equal(typo.isMember, false);
  assert.match(typo.flag, /unknown program tag program:kid-6-9/);
  const founding = classifyContact({ id: 'f', tags: ['founding-member', 'program:kid-6-9'] }, cfg);
  assert.equal(founding.isMember, true);
  assert.deepEqual(founding.programs, ['adult']);
  assert.match(founding.flag, /unknown program tag/);
  const fine = classifyContact({ id: 'g', tags: ['program:kids-6-9', 'program:kid-6-9'] }, cfg);
  assert.deepEqual(fine.programs, ['kids-6-9']);
  assert.match(fine.flag, /unknown program tag/);
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

test('program:none is a paying non-student: not a member, not flagged', () => {
  const r = classifyContact(byId('c_parent'), cfg);
  assert.equal(r.isMember, false);
  assert.equal(r.notStudent, true);
  assert.equal(r.flag, null);
  // program:none alongside a real program tag still means not a student.
  const both = classifyContact({ id: 'x', tags: ['founding-member', 'program:adult', 'program:none'] }, cfg);
  assert.equal(both.isMember, false);
  // Without a member tag it is simply a non-member.
  assert.equal(classifyContact({ id: 'y', tags: ['program:none'] }, cfg).notStudent, undefined);
});

test('buildRoster keeps members only, flags by name, skips blank first names', () => {
  const { members, flagged, notStudents } = buildRoster(CONTACTS, cfg);
  assert.deepEqual(notStudents, ['c_parent']);
  assert.deepEqual(
    members.map((m) => m.ghl_contact_id),
    ['c_jack', 'c_emma', 'c_leo', 'c_maria', 'c_dan', 'c_future', 'c_sam', 'c_lead', 'c_newkid'],
  );
  assert.deepEqual(
    flagged.map((f) => `${f.name}: ${f.reason}`),
    ['Sam Untagged: no program tag, defaulted to adult', 'Blank: no first name, skipped', 'Ty Po: unknown program tag program:kid-6-9'],
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
  assert.equal(result.members, 9);
  assert.equal(result.contacts, CONTACTS.length);
  assert.equal(result.deactivated, 0);
  assert.equal(result.notStudents, 1);
  assert.equal(result.removed, 0);
  assert.deepEqual(result.flagged, [
    'Sam Untagged: no program tag, defaulted to adult',
    'Blank: no first name, skipped',
    'Ty Po: unknown program tag program:kid-6-9',
  ]);

  const rows = DB.raw.prepare('SELECT * FROM members ORDER BY ghl_contact_id').all();
  assert.equal(rows.length, 9);
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

test('the sync checks every field the Worker writes, and says when it did not', async () => {
  resetFieldCache();
  const env = { ...ENV, WAIVER_TAG: 'waiver-signed', WAIVER_FIELD: 'checkin_last_at', DB: memoryD1() };
  const all = new Map([...FIELD_KEYS.map((k, i) => [k, `id_${i}`]), ['checkin_last_at', 'id_ck']]);
  let fetches = 0;
  const ok = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), fetchFields: async () => (fetches += 1, all), now: NOW });
  assert.equal(ok.outcome, 'ok');
  assert.deepEqual(ok.missingFields, []);
  assert.equal(fetches, 1);

  // Second run inside the hour uses the cached map: no second read of GHL.
  const again = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), fetchFields: async () => (fetches += 1, all), now: new Date(NOW.getTime() + 60_000) });
  assert.equal(again.outcome, 'ok');
  assert.equal(fetches, 1);

  // Without the dep, the check is reported as skipped, never as passed.
  const skipped = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() + 120_000) });
  assert.equal(skipped.outcome, 'ok');
  assert.equal(skipped.missingFields, null);
  assert.equal(skipped.fieldCheck, 'skipped');
  resetFieldCache();
});

test('a field the Worker writes that GHL lacks makes the sync degraded, by name, and is re-read next run', async () => {
  resetFieldCache();
  const env = { ...ENV, WAIVER_TAG: 'waiver-signed', WAIVER_FIELD: 'checkin_last_at', DB: memoryD1() };
  const withoutWaiver = new Map(FIELD_KEYS.map((k, i) => [k, `id_${i}`]));
  let fetches = 0;
  const r = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), fetchFields: async () => (fetches += 1, withoutWaiver), now: NOW });
  assert.equal(r.outcome, 'degraded');
  assert.equal(r.members, 9, 'the roster itself still synced');
  assert.deepEqual(r.missingFields, ['checkin_last_at']);
  const log = env.DB.raw.prepare("SELECT outcome, detail FROM sync_log WHERE job = 'roster'").get();
  assert.equal(log.outcome, 'degraded');
  assert.match(log.detail, /checkin_last_at/);

  // The cache was dropped, so the next run re-reads GHL and clears as soon as the field exists.
  const fixed = new Map([...withoutWaiver, ['checkin_last_at', 'id_ck']]);
  const r2 = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), fetchFields: async () => (fetches += 1, fixed), now: new Date(NOW.getTime() + 60_000) });
  assert.equal(fetches, 2);
  assert.equal(r2.outcome, 'ok');
  assert.deepEqual(r2.missingFields, []);

  // With the waiver feature off, its field is not required.
  resetFieldCache();
  const off = await syncRoster({ ...env, WAIVER_TAG: '' }, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), fetchFields: async () => withoutWaiver, now: new Date(NOW.getTime() + 120_000) });
  assert.equal(off.outcome, 'ok');
  assert.deepEqual(off.missingFields, []);

  // A rollup field missing is caught the same way.
  resetFieldCache();
  const noWeek = new Map(fixed);
  noWeek.delete('attendance_week');
  const r3 = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), fetchFields: async () => noWeek, now: new Date(NOW.getTime() + 180_000) });
  assert.equal(r3.outcome, 'degraded');
  assert.deepEqual(r3.missingFields, ['attendance_week']);
  resetFieldCache();
});

test('if GHL cannot be read for the field check, the roster still syncs and the run is degraded with the reason', async () => {
  resetFieldCache();
  const env = { ...ENV, DB: memoryD1() };
  const r = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), fetchFields: async () => { throw new Error('GHL 503'); }, now: NOW });
  assert.equal(r.outcome, 'degraded');
  assert.equal(r.members, 9);
  assert.equal(r.missingFields, null);
  assert.match(r.fieldCheck, /GHL 503/);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM members').get().n, 9);
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
  assert.deepEqual(result.flagged, ['Blank: no first name, skipped', 'Ty Po: unknown program tag program:kid-6-9']);
  const sam = DB.raw.prepare("SELECT * FROM members WHERE ghl_contact_id = 'c_sam'").get();
  assert.equal(sam.last_name, 'Tagged');
  assert.deepEqual(JSON.parse(sam.programs), ['kids-3-5']);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM members').get().n, 9);
});

test('zero members from GHL logs degraded and leaves the table untouched', async () => {
  const DB = memoryD1();
  const env = { ...ENV, DB };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: NOW });
  const before = DB.raw.prepare('SELECT * FROM members ORDER BY ghl_contact_id').all();

  for (const contacts of [[], [byId('c_typo'), byId('c_nobody')]]) {
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
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM members WHERE active = 1').get().n, 9);
  const last = DB.raw.prepare('SELECT outcome, detail FROM sync_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(last.outcome, 'failed');
  assert.match(last.detail, /401/);
});

test('tidyName capitalizes all-lowercase names and leaves mixed case alone', () => {
  assert.equal(tidyName('nicolas'), 'Nicolas');
  assert.equal(tidyName('mendes'), 'Mendes');
  assert.equal(tidyName('mary ann'), 'Mary Ann');
  assert.equal(tidyName("o'brien-smith"), "O'Brien-Smith");
  assert.equal(tidyName('josé'), 'José');
  assert.equal(tidyName('McDonald'), 'McDonald');
  assert.equal(tidyName('da Silva'), 'da Silva');
  assert.equal(tidyName('DeLuca'), 'DeLuca');
  assert.equal(tidyName('  jack  '), 'Jack');
  assert.equal(tidyName(''), '');
  assert.equal(tidyName(undefined), '');
});

test('buildRoster tidies lowercase names from GHL', () => {
  const { members } = buildRoster([{ id: 'x', firstName: 'nicolas', lastName: 'mendes', tags: ['founding-member', 'program:adult'] }], cfg);
  assert.equal(members[0].first_name, 'Nicolas');
  assert.equal(members[0].last_name, 'Mendes');
});

test('tagging a synced parent program:none removes their row; attendance stays', async () => {
  const DB = memoryD1();
  const env = { ...ENV, DB };
  // First sync: the parent is a plain founding member and lands in Adult, flagged.
  const before = CONTACTS.map((c) => (c.id === 'c_parent' ? { ...c, tags: ['founding-member'] } : c));
  let r = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: before, pages: 1 }), now: NOW });
  assert.equal(r.members, 10);
  assert.ok(r.flagged.some((f) => f.startsWith('Paula Payer')));
  DB.raw
    .prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method) VALUES ('c_parent', 'open mat / unscheduled', '2026-09-05T00:00', '2026-09-05T14:00:00Z', 'kiosk')")
    .run();
  // Second sync: tagged program:none.
  r = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() + 60_000) });
  assert.equal(r.members, 9);
  assert.equal(r.removed, 1);
  assert.equal(r.notStudents, 1);
  assert.ok(!r.flagged.some((f) => f.startsWith('Paula')));
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM members WHERE ghl_contact_id = 'c_parent'").get().n, 0);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM attendance WHERE ghl_contact_id = 'c_parent'").get().n, 1);
  // Third sync, same tags: nothing to remove, still quiet.
  r = await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() + 120_000) });
  assert.equal(r.removed, 0);
});

test('requiredFieldKeys is the five rollup fields plus the waiver field when that feature is on', () => {
  assert.deepEqual(requiredFieldKeys({}), FIELD_KEYS);
  assert.deepEqual(requiredFieldKeys({ WAIVER_TAG: 'waiver-signed', WAIVER_FIELD: ' Checkin_Last_At ' }), [...FIELD_KEYS, 'checkin_last_at']);
  assert.deepEqual(requiredFieldKeys({ WAIVER_TAG: '', WAIVER_FIELD: 'checkin_last_at' }), FIELD_KEYS);
});
