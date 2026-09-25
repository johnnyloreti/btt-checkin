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
import { loadTabItems } from '../../src/tab.js';
import { recordPurchase } from '../../src/purchases.js';
import { tabConfig } from '../../src/tab.js';
import { memoryD1 } from '../d1.js';
import { CONTACTS } from '../fixtures/contacts.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] || join(ROOT, '.screenshots');
mkdirSync(OUT, { recursive: true });

const schedule = loadSchedule(readFileSync(join(ROOT, 'schedule.json'), 'utf8'));
const tabItems = loadTabItems(readFileSync(join(ROOT, 'tab-items.json'), 'utf8'));
const NOW = new Date('2026-09-05T15:05:00Z'); // Sat 11:05 ET
const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: 'browser-test-salt', TZ: 'America/New_York', STRIPE_CLASSES: '7', STRIPE_PROGRAMS: 'kids-3-5,kids-6-9,kids-10-14', TAB_ITEMS: 'water,hydration', TAB_PROGRAMS: 'adult', PIN_PEPPER: 'a-long-pepper-for-the-browser', PUBLIC_ORIGIN: 'https://checkin.bttbridgewater.com', DB: memoryD1() };
await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
env.ASSETS = {
  fetch: async (req) => {
    const p = join(ROOT, 'public', new URL(req.url).pathname);
    if (!existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(p), { headers: { 'content-type': TYPES[extname(p)] || 'application/octet-stream' } });
  },
};
const app = createApp(schedule, { runRosterSync: async () => ({ outcome: 'ok', members: 7 }), now: () => NOW }, { tabItems });

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
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures += 1;
    // Keep Playwright's call-log line: the first line alone never names the
    // selector it gave up on, which makes a timeout here impossible to read.
    const lines = e.message.split('\n');
    const waiting = lines.find((l) => /waiting for|locator\(/.test(l));
    console.log(`FAIL ${name}\n     ${lines[0]}${waiting ? `\n     ${waiting.trim()}` : ''}`);
  }
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
await step('typing the instant the add overlay opens still finds the member', async () => {
  // The overlay focuses the box before the roster fetch resolves. Typing
  // into that gap must not leave the list empty.
  await page.click('#add-student');
  await page.waitForSelector('#add-overlay.active');
  await page.fill('#add-search', 'emm');           // no wait: race the fetch
  await page.waitForSelector('#add-tiles .tile', { timeout: 5000 });
  assert.match((await page.locator('#add-tiles .tile').allTextContents()).join(' '), /Emma Jones/);
  await page.click('#add-close');
});

await step('back to Tonight reflects the count', async () => {
  await page.click('#add-student');
  await page.waitForSelector('#add-overlay.active');
  await page.fill('#add-search', 'emma');
  await page.waitForSelector('#add-tiles .tile');
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
await step('stripes: eligible kid listed, recorded on a two-tap confirm, then cleared', async () => {
  // Seven attended classes for Jack, on distinct past dates.
  const ins = env.DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method) VALUES ('c_jack', 'Kids 6-9', ?, ?, 'kiosk')");
  for (let i = 1; i <= 7; i += 1) ins.run(`2026-08-0${i}T16:30`, `2026-08-0${i}T20:30:00Z`);

  await page.click('.tab[data-tab="stripes"]');
  await page.waitForSelector('#stripes-list .row');
  const rows = await page.locator('#stripes-list .row').allTextContents();
  assert.equal(rows.length, 1, `expected one eligible, got ${rows.length}`);
  assert.match(rows[0], /Jack Silva/);
  assert.match(rows[0], /7 since their first class/);
  assert.match(await page.locator('#stripes-note').textContent(), /Eligible for review/);
  await page.screenshot({ path: join(OUT, 'staff-stripes.png') });

  // One tap arms, the second records.
  await page.click('#stripes-list .award');
  assert.equal(await page.locator('#stripes-list .award').textContent(), 'Confirm stripe');
  await page.click('#stripes-list .award');
  await page.waitForFunction(() => /Nobody is eligible/.test(document.getElementById('stripes-list').textContent));
  // node:sqlite rows have a null prototype, so compare fields, not objects.
  const stored = env.DB.raw.prepare('SELECT kind, at_class_count FROM promotions').all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'stripe');
  assert.equal(stored[0].at_class_count, 7);
});

await step('the award shows on the member screen and undo removes it', async () => {
  await page.click('.tab[data-tab="members"]');
  await page.fill('#member-search', 'jack');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Jack Silva")');
  await page.waitForSelector('#member.active');
  await page.waitForFunction(() => /Stripe/.test(document.getElementById('member-promotions').textContent));
  assert.match(await page.locator('#member-promotions').textContent(), /at class 7/);
  await page.screenshot({ path: join(OUT, 'staff-member-stripes.png') });

  await page.click('#member-promotions .undo');
  assert.equal(await page.locator('#member-promotions .undo').textContent(), 'Confirm undo');
  await page.click('#member-promotions .undo');
  await page.waitForFunction(() => /No stripes or belts recorded/.test(document.getElementById('member-promotions').textContent));
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM promotions').get().n, 0);
});

await step('add a class from the member screen: pick a day, see only their classes', async () => {
  await page.click('.tab[data-tab="members"]');
  await page.fill('#member-search', 'emma');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Emma Jones")');
  await page.waitForSelector('#member.active');

  await page.click('#member-add-class');
  await page.waitForSelector('#pick-overlay.active');
  await page.waitForSelector('#pick-list .row');
  assert.match(await page.locator('#pick-title').textContent(), /Add a class for Emma/);
  // Emma is Kids 6-9. Saturday runs four classes; she is offered hers, plus open mat.
  assert.deepEqual(await page.locator('#pick-list .row .name').allTextContents(), ['Kids 6-9', 'Open mat']);
  const first = await page.locator('#pick-list .row').first().textContent();
  assert.match(first, /11:00 AM/);
  assert.match(first, /already on/, 'she was added to this class earlier in the run');
  assert.equal(await page.locator('#pick-date').inputValue(), '2026-09-05');
  assert.equal(await page.locator('#pick-date').getAttribute('max'), '2026-09-05');
  assert.equal(await page.locator('#pick-date').getAttribute('min'), '2026-08-06', 'thirty days of reach');
  await page.screenshot({ path: join(OUT, 'staff-add-class.png') });
});

await step('a past day backfills onto that day, not today', async () => {
  await page.fill('#pick-date', '2026-08-20'); // Thursday, a fortnight back
  await page.waitForFunction(() => /4:30 PM/.test(document.getElementById('pick-list').textContent));
  assert.deepEqual(await page.locator('#pick-list .row .name').allTextContents(), ['Kids 6-9', 'Open mat']);

  await page.click('#pick-list .row:has-text("Kids 6-9")');
  await page.waitForFunction(() => /Added Emma/.test(document.getElementById('toast').textContent));
  await page.waitForSelector('#pick-overlay', { state: 'hidden' });
  // The row lands on the class it names, so the rollup dates come out right.
  const row = env.DB.raw
    .prepare("SELECT class_start_local, method FROM attendance WHERE ghl_contact_id = 'c_emma' AND class_start_local LIKE '2026-08-20%'")
    .get();
  assert.equal(row.class_start_local, '2026-08-20T16:30');
  assert.equal(row.method, 'staff');
  assert.match(await page.locator('#member-history').textContent(), /Kids 6-9 4:30 PM/);
  assert.match(await page.locator('#member-facts').textContent(), /Class #2/);
});

await step('a member with no class that day is still offered the others', async () => {
  await page.click('.tab[data-tab="members"]');
  await page.fill('#member-search', 'nora');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Nora Newkid")');
  await page.waitForSelector('#member.active');
  await page.click('#member-add-class');
  await page.waitForSelector('#pick-list .row');

  // Nora is Kids 3-5, which does not run on a Wednesday. The other three show.
  await page.fill('#pick-date', '2026-08-19');
  await page.waitForFunction(() => /All classes are listed/.test(document.getElementById('pick-note').textContent));
  assert.match(await page.locator('#pick-note').textContent(), /Nothing in Nora's program that day/);
  assert.deepEqual(await page.locator('#pick-list .row .name').allTextContents(), ['Kids 6-9', 'Kids 10-14', 'Adult No-Gi', 'Open mat']);

  // Friday runs nothing at all. Open mat is still there.
  await page.fill('#pick-date', '2026-08-21');
  await page.waitForFunction(() => /No classes that day/.test(document.getElementById('pick-note').textContent));
  assert.deepEqual(await page.locator('#pick-list .row .name').allTextContents(), ['Open mat']);

  await page.click('#pick-close');
  await page.waitForSelector('#pick-overlay', { state: 'hidden' });
});

await step('tab: the day\'s lines with a total, remove with confirm, a locked member with a clear', async () => {
  const cfg = tabConfig(env, tabItems);
  await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'water', method: 'kiosk', now: new Date(NOW.getTime() - 20 * 60_000) });
  await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'hydration', method: 'staff', now: new Date(NOW.getTime() - 5 * 60_000) });
  env.DB.raw.prepare("INSERT INTO purchase_pins (payer_contact_id, pin_hash, salt, set_at, set_by, failed_count, first_failed_at, locked_until) VALUES ('c_dan', 'x', 'y', ?, 'staff', 5, ?, ?)")
    .run(NOW.toISOString(), NOW.toISOString(), new Date(NOW.getTime() + 10 * 60_000).toISOString());
  env.DB.raw.prepare("INSERT INTO pin_failures (payer_contact_id, failed_at) VALUES ('c_dan', ?), ('c_dan', ?)").run(NOW.toISOString(), NOW.toISOString());

  await page.click('.tab[data-tab="tab"]');
  await page.waitForSelector('#tabview.active');
  await page.waitForSelector('#tab-list .row');
  assert.match(await page.locator('#tab-title').textContent(), /Tab, Sat, Sep 5/);
  assert.match(await page.locator('#tab-summary').textContent(), /2 open lines today, \$4\. 2 wrong PINs today\./);
  const rows = await page.locator('#tab-list .row').allTextContents();
  assert.equal(rows.length, 2);
  assert.match(rows[0], /Dan Kim.*Hydration \$3.*staff/);
  assert.match(rows[1], /Dan Kim.*Water \$1/);
  assert.match(await page.locator('#tab-activity').textContent(), /Dan Kim.*locked/);
  await page.screenshot({ path: join(OUT, 'staff-tab.png') });

  await page.click('#tab-list .row:has-text("Hydration") .remove');
  assert.equal(await page.locator('#tab-list .row:has-text("Hydration") .remove').textContent(), 'Confirm remove');
  await page.click('#tab-list .row:has-text("Hydration") .remove');
  await page.waitForFunction(() => /1 open line today, \$1\./.test(document.getElementById('tab-summary').textContent));
  assert.match((await page.locator('#tab-list .row').allTextContents())[0], /Hydration.*removed/);
  assert.equal(env.DB.raw.prepare("SELECT status FROM purchases WHERE item_key = 'hydration'").get().status, 'voided');

  await page.click('#tab-activity .remove');
  await page.waitForFunction(() => document.getElementById('tab-activity').children.length === 0);
  assert.equal(env.DB.raw.prepare("SELECT locked_until FROM purchase_pins WHERE payer_contact_id = 'c_dan'").get().locked_until, null);
});

await step('member screen: the tab section, and Set up PIN hands over a setup link', async () => {
  await page.click('.tab[data-tab="members"]');
  await page.fill('#member-search', 'dan');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Dan Kim")');
  await page.waitForSelector('#member.active');
  await page.waitForFunction(() => document.getElementById('member-tab').style.display !== 'none');
  assert.match(await page.locator('#member-tab-total').textContent(), /1 open, \$1/);
  assert.match(await page.locator('#member-tab-actions').textContent(), /Purchase PIN set/);
  const lines = await page.locator('#member-tab-list .row').allTextContents();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Hydration \$3.*removed/);
  assert.match(lines[1], /Water \$1/);

  await page.click('#member-pin-setup');
  await page.waitForSelector('#member-pin-link');
  const href = await page.locator('#member-pin-link').getAttribute('href');
  assert.match(href, /^https:\/\/checkin\.bttbridgewater\.com\/pin\?t=[0-9a-f]{64}$/);
  assert.equal(env.DB.raw.prepare("SELECT via FROM pin_setup_tokens WHERE payer_contact_id = 'c_dan' ORDER BY created_at DESC LIMIT 1").get().via, 'staff');
  await page.screenshot({ path: join(OUT, 'staff-member-tab.png') });

  // A kid: the section shows but says not eligible, no setup button.
  await page.click('#member-back');
  await page.fill('#member-search', 'jack');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Jack Silva")');
  await page.waitForSelector('#member.active');
  await page.waitForFunction(() => /not eligible/.test(document.getElementById('member-tab-actions').textContent));
  assert.equal(await page.locator('#member-pin-setup').count(), 0);
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
