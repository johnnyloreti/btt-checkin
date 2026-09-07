// Browser check for the staff pages. Not part of `npm test`. Run with:
//   NODE_PATH=$(npm root -g) node test/browser/staff.mjs [screenshot-dir]
// Runs the real Worker router in-process against the in-memory D1, so
// the whole stack short of workerd is exercised: login cookie, tonight,
// class roster, add, void, member lookup.

import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../../src/app.js';
import { syncRoster } from '../../src/roster.js';
import { loadSchedule } from '../../src/schedule.js';
import { memoryD1 } from '../d1.js';
import { CONTACTS } from '../fixtures/contacts.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] || join(ROOT, '.screenshots');
mkdirSync(OUT, { recursive: true });

const schedule = loadSchedule(readFileSync(join(ROOT, 'schedule.json'), 'utf8'));
const NOW = new Date('2026-09-05T15:05:00Z'); // Sat 11:05 ET
const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: 'browser-test-salt', TZ: 'America/New_York', DB: memoryD1() };
await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
env.ASSETS = {
  fetch: async (req) => {
    const p = join(ROOT, 'public', new URL(req.url).pathname);
    if (!existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(p), { headers: { 'content-type': TYPES[extname(p)] || 'application/octet-stream' } });
  },
};
const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok', members: 7 }), now: () => NOW });

// Bridge node http → the Worker's fetch handler.
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  const url = `http://127.0.0.1${req.url}`;
  const out = await app.fetch(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPad (gen 7)'], viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
let failures = 0;
async function step(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures += 1; console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`); }
}

await step('/staff shows the login page and rejects a wrong PIN', async () => {
  await page.goto(`${base}/staff`);
  await page.waitForSelector('#pin');
  await page.screenshot({ path: join(OUT, 'staff-login.png') });
  await page.fill('#pin', '0000');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.getElementById('msg').textContent === 'Wrong PIN');
});
await step('right PIN lands on Tonight with counts', async () => {
  await page.fill('#pin', '1234');
  await page.click('button[type=submit]');
  await page.waitForSelector('#tonight-list .row');
  assert.match(await page.locator('#tonight-title').textContent(), /Sat, Sep 5/);
  const rows = await page.locator('#tonight-list .row').allTextContents();
  assert.equal(rows.length, 4);
  assert.match(rows[1], /11:00 AM.*Kids 6-9.*0 checked in/);
  await page.screenshot({ path: join(OUT, 'staff-tonight.png') });
});
await step('class roster: empty, then add a student via search, then remove with confirm', async () => {
  await page.click('#tonight-list .row[data-name="Kids 6-9"]');
  await page.waitForSelector('#class.active');
  await page.waitForFunction(() => /Nobody checked in yet/.test(document.getElementById('class-list').textContent));
  await page.click('#add-student');
  await page.waitForSelector('#add-overlay.active');
  await page.fill('#add-search', 'ja');
  await page.waitForSelector('#add-tiles .tile');
  await page.click('#add-tiles .tile:has-text("Jack Silva")');
  await page.waitForSelector('#class-list .row');
  const row = await page.locator('#class-list .row').first().textContent();
  assert.match(row, /Jack Silva/);
  assert.match(row, /11:05 AM/);
  assert.match(row, /staff/);
  await page.screenshot({ path: join(OUT, 'staff-class.png') });
  await page.click('#class-list .remove');
  assert.equal(await page.locator('#class-list .remove').textContent(), 'Confirm remove');
  await page.click('#class-list .remove');
  await page.waitForFunction(() => /Nobody checked in yet/.test(document.getElementById('class-list').textContent));
  const db = env.DB.raw.prepare('SELECT status, method FROM attendance').all();
  assert.equal(db.length, 1, 'row still exists');
  assert.equal(db[0].status, 'voided');
  assert.equal(db[0].method, 'staff');
});
await step('back to Tonight reflects the count', async () => {
  await page.click('#add-student');
  await page.fill('#add-search', 'emma');
  await page.click('#add-tiles .tile:has-text("Emma Jones")');
  await page.waitForSelector('#class-list .row');
  await page.click('#class-back');
  await page.waitForFunction(() => /1 checked in/.test(document.querySelector('#tonight-list .row[data-name="Kids 6-9"]').textContent));
});
await step('members: search, open, see lifetime and history', async () => {
  await page.click('.tab[data-tab="members"]');
  await page.fill('#member-search', 'emma');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Emma Jones")');
  await page.waitForSelector('#member.active');
  assert.equal(await page.locator('#member-title').textContent(), 'Emma Jones');
  const facts = await page.locator('#member-facts').textContent();
  assert.match(facts, /Class #1/);
  assert.match(facts, /Pending tonight/);
  assert.match(facts, /Active/);
  assert.match(await page.locator('#member-history').textContent(), /Kids 6-9 11:00 AM/);
  await page.screenshot({ path: join(OUT, 'staff-member.png') });
});
await step('day navigation: Sunday has no classes', async () => {
  await page.click('.tab[data-tab="tonight"]');
  await page.waitForSelector('#tonight-list .row');
  await page.click('#next-day');
  await page.waitForFunction(() => /No classes this day/.test(document.getElementById('tonight-list').textContent));
  assert.match(await page.locator('#tonight-title').textContent(), /Sun, Sep 6/);
});
await step('sync now posts and reports', async () => {
  await page.click('#sync-now');
  await page.waitForFunction(() => /Synced|Sync/.test(document.getElementById('toast').textContent), null, { timeout: 10000 }).catch(() => {});
  assert.match(await page.locator('#toast').textContent(), /Synced 7 members/);
});
await step('sign out returns to the login page', async () => {
  await page.click('#signout');
  await page.waitForSelector('#pin');
  await page.goto(`${base}/staff`);
  await page.waitForSelector('#pin');
});
await step('no page errors', () => assert.deepEqual(errors, []));

await browser.close();
server.close();
console.log(failures === 0 ? `\nall staff browser checks passed; screenshots in ${OUT}` : `\n${failures} staff browser check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
