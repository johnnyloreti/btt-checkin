// A staff note on a member (§15.11). One short note per member on the staff
// member screen. Staff-only, never on the kiosk or the progress page, and
// switched off unless MEMBER_NOTES says on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, health } from '../src/app.js';
import { syncRoster } from '../src/roster.js';
import { memberNotesEnabled, memberNote, saveMemberNote, MAX_NOTE_CHARS } from '../src/notes.js';
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
const NOW = new Date('2026-09-23T15:00:00Z');

async function setup({ extraEnv = {}, noMemberNotes = false } = {}) {
  resetFallback();
  const DB = memoryD1({ noMemberNotes });
  const env = {
    MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: SALT, TZ: 'America/New_York',
    MEMBER_NOTES: 'on', LESSON_NOTES: 'off', DB, ...extraEnv,
  };
  await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
  let at = NOW;
  const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok' }), notifyWaiver: async () => ({ ok: true }), now: () => at });
  let cookie = '';
  const call = (path, { method = 'GET', body, anon = false } = {}) =>
    app.fetch(new Request(`https://x.test${path}`, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.1', ...(cookie && !anon ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const login = await call('/api/staff/login', { method: 'POST', body: { pin: '1234' } });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const jack = await opaqueId('c_jack', SALT);
  const save = (body, o = {}) => call('/api/staff/member/note', { method: 'POST', body: { contactId: jack, body }, ...o });
  const read = async () => (await (await call(`/api/staff/member?id=${jack}`)).json()).note;
  return { env, DB, call, save, read, jack, tick: (ms) => { at = new Date(at.getTime() + ms); } };
}

test('off unless MEMBER_NOTES says on: no note on the screen, no save, and /health asks for nothing', async () => {
  assert.equal(memberNotesEnabled({}), false);
  for (const v of ['off', '0', 'false', '', 'maybe']) assert.equal(memberNotesEnabled({ MEMBER_NOTES: v }), false, v);
  for (const v of ['on', 'ON', ' on ', '1', 'true']) assert.equal(memberNotesEnabled({ MEMBER_NOTES: v }), true, v);
  const { env, save, read } = await setup({ extraEnv: { MEMBER_NOTES: 'off' }, noMemberNotes: true });
  assert.deepEqual(await read(), { enabled: false });
  assert.equal((await save('left knee')).status, 404);
  const h = await health(env, schedule, NOW);
  assert.ok(!JSON.stringify(h).includes('008_member_notes'), 'switched off, the migration is not asked for');
});

test('save, read back, edit and clear', async () => {
  const { save, read, DB, tick } = await setup();
  assert.deepEqual(await read(), { enabled: true, max: MAX_NOTE_CHARS, body: '', updatedAt: null });
  const res = await save('  Left knee, no takedowns.\r\nPicked up by grandma on Thursdays.  ');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, note: 'Left knee, no takedowns.\nPicked up by grandma on Thursdays.', updatedAt: NOW.toISOString() });
  assert.equal((await read()).body, 'Left knee, no takedowns.\nPicked up by grandma on Thursdays.');
  tick(60_000);
  await save('Knee is fine now.');
  const n = await read();
  assert.equal(n.body, 'Knee is fine now.');
  assert.equal(n.updatedAt, new Date(NOW.getTime() + 60_000).toISOString());
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM member_notes').get().n, 1, 'one note per member');
  assert.deepEqual(await (await save('   ')).json(), { ok: true, note: '', updatedAt: null });
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM member_notes').get().n, 0, 'a blank save removes the row');
});

test('limits and refusals: too long, unknown member, no body, and no staff cookie', async () => {
  const { save, call, DB } = await setup();
  assert.equal((await save('x'.repeat(MAX_NOTE_CHARS))).status, 200);
  const long = await save('x'.repeat(MAX_NOTE_CHARS + 1));
  assert.equal(long.status, 400);
  assert.match((await long.json()).error, /at most 1000/);
  assert.equal((await call('/api/staff/member/note', { method: 'POST', body: { contactId: 'f'.repeat(20), body: 'hi' } })).status, 404);
  assert.equal((await save('nope', { anon: true })).status, 401, 'the staff PIN gates it');
  assert.equal(DB.raw.prepare('SELECT LENGTH(body) AS n FROM member_notes').get().n, MAX_NOTE_CHARS);
});

test('a note is plain text: markup is stored and returned as typed, never interpreted', async () => {
  const { save, read } = await setup();
  await save('<b>bold</b> <script>alert(1)</script>');
  assert.equal((await read()).body, '<b>bold</b> <script>alert(1)</script>');
  const page = readRepoFile('public/staff.html');
  assert.ok(!/innerHTML\s*=\s*[^'"]/.test(page.replace(/innerHTML = '';/g, '')), 'the staff page only ever clears innerHTML');
});

test('the note stays on the staff screen: not in the kiosk roster, a check-in, or the progress page', async () => {
  const { save, call, jack } = await setup();
  await save('SECRET-NOTE-TEXT');
  const leak = async (res) => (await res.text()).includes('SECRET-NOTE-TEXT');
  assert.equal(await leak(await call('/api/roster', { anon: true })), false);
  assert.equal(await leak(await call('/api/checkin', { method: 'POST', anon: true, body: { contactId: jack, classStartLocal: '2026-09-23T16:30', className: 'Kids 6-9', clientTs: NOW.toISOString() } })), false);
  assert.equal(await leak(await call(`/api/progress?t=${await progressToken('c_jack', SALT)}`, { anon: true })), false);
  assert.equal(await leak(await call(`/api/staff/member?id=${jack}`)), true, 'staff do see it');
});

test('switched on before migration 008: the box is hidden, a save names the file, check-in is untouched, /health says so, and running it is noticed', async () => {
  const { env, DB, save, read, call, jack } = await setup({ noMemberNotes: true });
  assert.deepEqual(await read(), { enabled: false });
  const res = await save('left knee');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /008_member_notes\.sql/);
  const checkin = await call('/api/checkin', { method: 'POST', anon: true, body: { contactId: jack, classStartLocal: '2026-09-23T16:30', className: 'Kids 6-9', clientTs: NOW.toISOString() } });
  assert.equal(checkin.status, 200);
  const h = await health(env, schedule, NOW);
  assert.equal(h.ok, false);
  assert.ok(JSON.stringify(h).includes('008_member_notes.sql'));

  DB.raw.exec(readRepoFile('src/db/migrations/008_member_notes.sql'));
  ageSchemaCaps();
  assert.equal((await save('left knee')).status, 200);
  assert.equal((await read()).body, 'left knee');
  assert.deepEqual(await memberNote(env, 'c_emma'), { enabled: true, max: MAX_NOTE_CHARS, body: '', updatedAt: null });
  await assert.rejects(() => saveMemberNote({ ...env, MEMBER_NOTES: 'off' }, 'c_jack', 'x'), /off/);
});
