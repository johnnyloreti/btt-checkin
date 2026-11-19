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
import { progressToken } from '../../src/progress.js';
import { createSetupToken, completeSetup } from '../../src/pin.js';
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
const env = { MEMBER_TAGS: 'founding-member', MEMBER_TAG_PREFIXES: 'foundations-', STAFF_PIN: '1234', ID_SALT: 'browser-test-salt', TZ: 'America/New_York', STRIPE_CLASSES: '7', STRIPE_PROGRAMS: 'kids-3-5,kids-6-9,kids-10-14', TAB_ITEMS: 'water,hydration', TAB_PROGRAMS: 'adult', PIN_PEPPER: 'a-long-pepper-for-the-browser', PUBLIC_ORIGIN: 'https://checkin.bttbridgewater.com', PROGRESS_FIELD: 'progress_link', DB: memoryD1() };
await syncRoster(env, schedule, { fetchContacts: async () => ({ contacts: CONTACTS, pages: 1 }), now: new Date(NOW.getTime() - 3600_000) });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
env.ASSETS = {
  fetch: async (req) => {
    const p = join(ROOT, 'public', new URL(req.url).pathname);
    if (!existsSync(p)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(p), { headers: { 'content-type': TYPES[extname(p)] || 'application/octet-stream' } });
  },
};
// A scripted GHL for the close-out: Dan has a card saved on a funnel payment, Emma has none.
const ghlState = { schedules: [], active: {}, invoices: {} };
const fakeGhl = {
  getContact: async (e, id) => ({ id, name: id === 'c_dan' ? 'Dan Kim' : 'Someone', email: `${id}@example.test`, phone: '+15555550100' }),
  listTransactions: async (e, id) => (id === 'c_dan' ? [{ _id: 't1', status: 'succeeded', liveMode: true, entitySourceType: 'funnel', createdAt: '2026-08-01T00:00:00Z' }] : []),
  getTransaction: async () => ({ _id: 't1', chargeSnapshot: { customer: 'cus_dan', payment_method: { id: 'pm_dan', card: { brand: 'visa', last4: '6222' } } } }),
  findSchedules: async () => [],
  getSchedule: async (e, id) => ghlState.active[id] || { _id: id, status: 'draft' },
  createSchedule: async (e, body) => { const id = `sch_${ghlState.schedules.length + 1}`; ghlState.schedules.push({ _id: id, ...body }); return { id, raw: {} }; },
  activateSchedule: async (e, id, auto) => { ghlState.active[id] = { _id: id, status: 'active', autoPayment: auto }; return {}; },
  listInvoices: async (e, id) => ghlState.invoices[id] || [],
};
const progressLinks = [];
const pinLinks = [];
const app = createApp(schedule, {
  runRosterSync: async () => ({ outcome: 'ok', members: 7 }),
  ghl: fakeGhl,
  progressLink: async (e, contactId, url) => { progressLinks.push([contactId, url]); return { ok: true }; },
  pinLink: async (e, contactId, link) => { pinLinks.push([contactId, link]); return { ok: true }; },
  now: () => NOW,
}, { tabItems });

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
    console.log(`FAIL ${name}\n     ${lines.slice(0, 4).join(' / ')}${waiting ? `\n     ${waiting.trim()}` : ''}`);
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
  // Six attended classes for Jack, on distinct past dates: one away.
  const ins = env.DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method) VALUES ('c_jack', 'Kids 6-9', ?, ?, 'kiosk')");
  for (let i = 1; i <= 6; i += 1) ins.run(`2026-08-0${i}T16:30`, `2026-08-0${i}T20:30:00Z`);

  await page.click('.tab[data-tab="stripes"]');
  await page.waitForSelector('#stripes-next .row');
  assert.match(await page.locator('#stripes-list').textContent(), /Nobody is eligible/);
  assert.equal(await page.locator('#stripes-next-box').isVisible(), true);
  const next = await page.locator('#stripes-next .row').allTextContents();
  assert.equal(next.length, 1);
  assert.match(next[0], /Jack Silva/);
  assert.match(next[0], /6 since their first class/);
  assert.match(next[0], /Next class makes 7/);
  assert.equal(await page.locator('#stripes-next button').count(), 0, 'no record button one class away');
  await page.screenshot({ path: join(OUT, 'staff-stripes-next.png') });

  // The seventh check-in moves him up.
  ins.run('2026-08-08T16:30', '2026-08-08T20:30:00Z');
  await page.click('.tab[data-tab="tonight"]');
  await page.click('.tab[data-tab="stripes"]');
  await page.waitForSelector('#stripes-list .row');
  assert.equal(await page.locator('#stripes-next-box').isVisible(), false);
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

await step('away: who has gone quiet, longest first, and a tap opens the member', async () => {
  // Jack's last real class was Aug 8 (today's add was removed): 28 days.
  await page.click('.tab[data-tab="away"]');
  await page.waitForSelector('#away-list .row');
  assert.match(await page.locator('#away-rule').textContent(), /14 days or more/);
  const rows = await page.locator('#away-list .row').allTextContents();
  assert.equal(rows.length, 1, `expected one away, got ${rows.length}`);
  // Two taps before the first answer is back used to draw the list twice.
  await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="away"]'); t.click(); t.click(); });
  await page.waitForSelector('#away-list .row');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#away-list .row').count(), 1, 'a double tap still shows each member once');
  assert.match(rows[0], /Jack Silva/);
  assert.match(rows[0], /Kids 6-9/);
  assert.match(rows[0], /Last class Sat, Aug 8/);
  assert.match(rows[0], /28 days/);
  // Emma was in today, so she is on neither list.
  assert.equal(await page.locator('#away-never-box').isVisible(), true);
  const never = await page.locator('#away-never .row').allTextContents();
  assert.ok(never.length >= 1);
  assert.ok(!never.some((t) => /Emma Jones|Jack Silva/.test(t)));
  await page.screenshot({ path: join(OUT, 'staff-away.png') });
  await page.click('#away-list .row');
  await page.waitForSelector('#member.active');
  assert.equal(await page.locator('#member-title').textContent(), 'Jack Silva');
});

await step('trends: four weeks of headcount per class, this week in gold', async () => {
  // Today is Sat Sep 5. Jack's seven classes sit on Aug 1 to 8; Emma was in today.
  await page.click('.tab[data-tab="trends"]');
  await page.waitForSelector('#trends-box table.trend');
  const head = await page.locator('table.trend th').allTextContents();
  assert.deepEqual(head, ['Class', 'Aug 10', 'Aug 17', 'Aug 24', 'This week']);
  assert.equal(await page.locator('table.trend tr').count(), 1 + 15 + 2, 'header, 15 classes, two totals');
  const sat = await page.locator('table.trend tr:has-text("Sat"):has-text("Kids 6-9") td').allTextContents();
  assert.deepEqual(sat.slice(1), ['0', '0', '0', '1'], 'Emma, today');
  const totals = await page.locator('table.trend tr.sum.first td').allTextContents();
  assert.deepEqual(totals, ['All check-ins', '0', '0', '0', '1']);
  assert.equal(await page.locator('table.trend td.now').count(), 17);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(wide, false, 'no horizontal scroll');
  await page.screenshot({ path: join(OUT, 'staff-trends.png') });
  await page.click('.tab[data-tab="away"]');
  await page.click('#away-list .row');
  await page.waitForSelector('#member.active');
});

await step('belts: record a rank on the member screen, add a stripe, and see it on the roster', async () => {
  // Still on Jack's member screen. White until told otherwise.
  assert.equal(await page.locator('#member-rank').isVisible(), true);
  assert.match(await page.locator('#member-facts').textContent(), /Rank\s*White belt/);
  assert.equal(await page.locator('#rank-belt option').count(), 13, 'a kid is offered the kids belts');
  await page.selectOption('#rank-belt', 'grey');
  await page.selectOption('#rank-stripes', '2');
  await page.check('#rank-held');
  await page.click('#rank-save');
  assert.equal(await page.locator('#rank-save').textContent(), 'Confirm belt');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM promotions').get().n, 0, 'one tap only arms');
  await page.click('#rank-save');
  await page.waitForFunction(() => /Grey belt, 2 stripes/.test(document.getElementById('member-facts').textContent));
  const history = await page.locator('#member-promotions').textContent();
  assert.match(history, /Grey belt, 2 stripes/);
  assert.match(history, /already held/);
  const stored = env.DB.raw.prepare('SELECT kind, belt, stripes, starting FROM promotions').all();
  assert.deepEqual(stored.map((r) => [r.kind, r.belt, r.stripes, r.starting]), [['belt', 'grey', 2, 1]]);

  // A stripe given on the spot adds to the belt.
  await page.click('#stripe-add');
  assert.equal(await page.locator('#stripe-add').textContent(), 'Confirm stripe');
  await page.click('#stripe-add');
  await page.waitForFunction(() => /Grey belt, 3 stripes/.test(document.getElementById('member-facts').textContent));
  await page.screenshot({ path: join(OUT, 'staff-member-belt.png') });

  // A new belt starts with no stripes: picking another belt clears the
  // stripes box instead of carrying the old belt's three across, and going
  // back to the belt they hold puts them back. Nothing is recorded here.
  assert.equal(await page.locator('#rank-stripes').inputValue(), '3');
  await page.selectOption('#rank-belt', 'yellow');
  assert.equal(await page.locator('#rank-stripes').inputValue(), '0');
  await page.selectOption('#rank-belt', 'grey');
  assert.equal(await page.locator('#rank-stripes').inputValue(), '3');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM promotions').get().n, 2);

  // The class roster shows rank beside the name. An earlier step left the
  // date bar on Sunday; step back to Saturday and put it back after.
  await page.click('.tab[data-tab="tonight"]');
  await page.click('#prev-day');
  await page.waitForSelector('#tonight-list .row[data-name="Kids 6-9"]');
  await page.click('#tonight-list .row[data-name="Kids 6-9"]');
  await page.waitForSelector('#class-list .row');
  assert.match(await page.locator('#class-list .row').first().textContent(), /Emma Jones.*White belt/);
  await page.screenshot({ path: join(OUT, 'staff-class-rank.png') });
  await page.click('#class-back');
  await page.waitForSelector('#tonight.active');
  await page.click('#next-day');
  await page.waitForFunction(() => /No classes this day/.test(document.getElementById('tonight-list').textContent));
});

await step('lessons: a note for the class and a plan for the week, shown on Tonight and laid out on Plan', async () => {
  // The date bar is on Sunday; step back to Saturday Sep 5.
  await page.click('.tab[data-tab="tonight"]');
  await page.click('#prev-day');
  await page.waitForSelector('#tonight-list .row[data-name="Kids 6-9"]');
  assert.equal(await page.locator('#plan-nav').isVisible(), true);
  assert.equal(await page.locator('#tonight-list .lesson').count(), 0, 'nothing planned yet');
  await page.click('#tonight-list .row[data-name="Kids 6-9"]');
  await page.waitForSelector('#class-lesson .lessonbox');
  const boxes = page.locator('#class-lesson .lessonbox');
  assert.equal(await boxes.count(), 2);
  assert.match(await boxes.nth(0).textContent(), /This class.*No note for this class/);
  assert.match(await boxes.nth(1).textContent(), /This week, Kids 6-9.*No plan for the week yet/);

  // The week's plan first.
  await boxes.nth(1).locator('.edit').click();
  await boxes.nth(1).locator('textarea').fill('Closed guard.\nScissor sweep, then hip bump.');
  await boxes.nth(1).locator('.save').click();
  await page.waitForFunction(() => /Scissor sweep/.test(document.querySelectorAll('#class-lesson .lessonbox')[1].querySelector('.body')?.textContent || ''));
  // Cancel leaves a box as it was.
  await boxes.nth(0).locator('.edit').click();
  await boxes.nth(0).locator('textarea').fill('typed by mistake');
  await boxes.nth(0).locator('button:has-text("Cancel")').click();
  assert.match(await boxes.nth(0).textContent(), /No note for this class/);
  // Then a note for this class, with markup that must stay text.
  await boxes.nth(0).locator('.edit').click();
  await boxes.nth(0).locator('textarea').fill('Belt test prep <b>today</b>');
  await boxes.nth(0).locator('.save').click();
  await page.waitForFunction(() => /Belt test prep/.test(document.querySelector('#class-lesson .lessonbox .body')?.textContent || ''));
  assert.equal(await boxes.nth(0).locator('.body b').count(), 0, 'rendered as text, not markup');
  assert.equal(await boxes.nth(0).locator('.body').textContent(), 'Belt test prep <b>today</b>');
  await page.screenshot({ path: join(OUT, 'staff-class-lesson.png') });
  const stored = env.DB.raw.prepare('SELECT class_start_local, class_name, body FROM class_notes').all();
  assert.deepEqual(stored.map((r) => [r.class_start_local, r.class_name, r.body]), [['2026-09-05T11:00', 'Kids 6-9', 'Belt test prep <b>today</b>']]);
  assert.deepEqual(env.DB.raw.prepare('SELECT week_start, program FROM lesson_plans').all().map((r) => [r.week_start, r.program]), [['2026-08-31', 'kids-6-9']]);

  // Tonight shows the first line: the class note where there is one.
  await page.click('#class-back');
  await page.waitForSelector('#tonight-list .lesson');
  assert.equal(await page.locator('#tonight-list .row[data-name="Kids 6-9"] .lesson').textContent(), 'Belt test prep <b>today</b>');
  assert.equal(await page.locator('#tonight-list .lesson').count(), 1);
  await page.screenshot({ path: join(OUT, 'staff-tonight-lesson.png') });

  // Plan lays the week out by program.
  await page.click('.tab[data-tab="plan"]');
  await page.waitForSelector('#plan-box .lessonbox');
  assert.equal(await page.locator('#plan-title').textContent(), 'Week of Aug 31');
  assert.deepEqual(await page.locator('#plan-box .planprog').allTextContents(), ['Kids 3-5', 'Kids 6-9', 'Kids 10-14', 'Adult']);
  const text = await page.locator('#plan-box').textContent();
  assert.match(text, /Scissor sweep, then hip bump/);
  assert.match(text, /Sat, Sep 5, 11:00 AM.*Belt test prep/);
  assert.match(text, /Wed, Sep 2, 6:15 PM, Adult No-Gi/, 'a class named differently from its program says so');
  await page.screenshot({ path: join(OUT, 'staff-plan.png'), fullPage: true });
  // Next week is blank and its own.
  await page.click('#plan-next');
  await page.waitForFunction(() => document.getElementById('plan-title').textContent === 'Week of Sep 7');
  assert.doesNotMatch(await page.locator('#plan-box').textContent(), /Scissor sweep|Belt test prep/);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(wide, false, 'no horizontal scroll');

  // Put the date bar back on Sunday for the steps that follow.
  await page.click('.tab[data-tab="tonight"]');
  await page.waitForSelector('#tonight-list .row');
  await page.click('#next-day');
  await page.waitForFunction(() => /No classes this day/.test(document.getElementById('tonight-list').textContent));
});

await step('progress page: staff copy or text the link; the page shows the member on a phone', async () => {
  await page.click('.tab[data-tab="members"]');
  await page.fill('#member-search', 'jack');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Jack Silva")');
  await page.waitForSelector('#member.active');
  assert.equal(await page.locator('#member-progress').isVisible(), true);
  assert.equal(await page.locator('#progress-to').textContent(), 'goes to the member');
  await page.click('#progress-text');
  assert.equal(await page.locator('#progress-text').textContent(), 'Confirm text');
  assert.equal(progressLinks.length, 0, 'one tap only arms');
  await page.click('#progress-text');
  await page.waitForFunction(() => /Sent to Jack/.test(document.getElementById('toast').textContent));
  const token = await progressToken('c_jack', env.ID_SALT);
  assert.deepEqual(progressLinks, [['c_jack', `https://checkin.bttbridgewater.com/me?t=${token}`]]);

  // The page itself, on a phone, with no staff cookie.
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const me = await phoneCtx.newPage();
  const meErrors = [];
  me.on('pageerror', (e) => meErrors.push(String(e)));
  await me.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await me.goto(`${base}/me?t=${token}`);
  await me.waitForSelector('.card');
  assert.equal(await me.locator('.card').count(), 1);
  assert.equal(await me.locator('.who h1').textContent(), 'Jack Silva');
  assert.equal(await me.locator('.who .prog').textContent(), 'Kids 6-9');
  assert.match(await me.locator('.count').textContent(), /^Class #7/);
  assert.match(await me.locator('.rank .label').textContent(), /Grey belt, 3 stripes/);
  assert.equal(await me.locator('.belt .bar i').count(), 3, 'three stripes drawn on the belt');
  assert.match(await me.locator('.next').textContent(), /3 classes to Class #10/);
  assert.equal(await me.locator('.recent li').count(), 7);
  assert.match(await me.locator('.recent li').first().textContent(), /Sat, Aug 8.*Kids 6-9.*4:30 PM/);
  const text = await me.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, /!|—|@|billing|balance|waiver|\$/i, 'copy rules, and nothing about money');
  const meWide = await me.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(meWide, false, 'no horizontal scroll on a phone');
  assert.equal(await me.title(), 'Jack at BTT Bridgewater');
  await me.screenshot({ path: join(OUT, 'me-progress.png'), fullPage: true });

  // A link that matches nobody says so, and nothing else.
  await me.goto(`${base}/me?t=${'0'.repeat(32)}`);
  await me.waitForFunction(() => /could not find this page/.test(document.getElementById('state').textContent));
  assert.equal(await me.locator('.card').count(), 0);
  assert.deepEqual(meErrors, []);
  await phoneCtx.close();
});

await step('family: siblings listed on the member screen, a tap moves between them, and it is off unless switched on', async () => {
  const openJack = async () => {
    await page.click('.tab[data-tab="members"]');
    await page.fill('#member-search', 'jack');
    await page.waitForSelector('#member-tiles .tile');
    await page.click('#member-tiles .tile:has-text("Jack Silva")');
    await page.waitForFunction(() => document.getElementById('member').classList.contains('active') && document.getElementById('member-title').textContent === 'Jack Silva');
  };
  const link = (parent) => env.DB.raw.prepare("UPDATE members SET payer_contact_id = ? WHERE ghl_contact_id IN ('c_jack', 'c_emma')").run(parent);
  link('PARENTcontact0000001');
  // Linked, but the switch is off: no box.
  await openJack();
  assert.equal(await page.locator('#member-family').isVisible(), false);

  env.FAMILY_VIEW = 'on';
  await openJack();
  await page.waitForSelector('#family-list .row');
  assert.equal(await page.locator('#family-list .row').count(), 2);
  assert.match(await page.locator('#family-sub').textContent(), /a parent is on file and does not train here/);
  const jack = page.locator('#family-list .row.self');
  assert.match(await jack.textContent(), /Jack Silva.*Kids 6-9, Grey belt, 3 stripes.*this member/s);
  const emma = page.locator('#family-list button.row');
  assert.match(await emma.textContent(), /Emma Jones.*Kids 6-9, White belt/s);
  await page.screenshot({ path: join(OUT, 'staff-member-family.png') });

  // A tap on the sibling opens her screen, with her marked instead.
  await emma.click();
  await page.waitForFunction(() => document.getElementById('member-title').textContent === 'Emma Jones');
  await page.waitForFunction(() => /Emma Jones/.test(document.querySelector('#family-list .row.self')?.textContent || ''));
  assert.equal(await page.locator('#family-list button.row').count(), 1);

  // Put things back for the steps that follow.
  link(null);
  await openJack();
  assert.equal(await page.locator('#member-family').isVisible(), false, 'on his own again: no box');
});

await step('staff note: hidden until switched on, then add, save and see it on the member screen', async () => {
  // Still on Jack's screen, and notes are off: no box.
  assert.equal(await page.locator('#member-note .lessonbox').count(), 0);
  env.MEMBER_NOTES = 'on';
  await page.click('#member-back');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Jack Silva")');
  await page.waitForSelector('#member-note .lessonbox');
  assert.match(await page.locator('#member-note').textContent(), /Staff note.*No note\. Staff see this, members never do\./s);
  await page.click('#member-note .edit');
  await page.fill('#member-note textarea', 'Left knee, no takedowns.\nPicked up by grandma on Thursdays.');
  assert.match(await page.locator('#member-note .left').textContent(), /^9\d\d left$/, 'counts down from 1,000');
  await page.click('#member-note .save');
  await page.waitForFunction(() => /Left knee, no takedowns/.test(document.querySelector('#member-note .body')?.textContent || ''));
  assert.equal(env.DB.raw.prepare("SELECT body FROM member_notes WHERE ghl_contact_id = 'c_jack'").get().body, 'Left knee, no takedowns.\nPicked up by grandma on Thursdays.');
  await page.screenshot({ path: join(OUT, 'staff-member-note.png') });

  // A note half typed survives the screen redrawing for the same member.
  await page.click('#member-note .edit');
  await page.fill('#member-note textarea', 'Half typed');
  await page.click('#stripe-add');
  await page.click('#stripe-add');
  await page.waitForFunction(() => /Stripe recorded/.test(document.getElementById('toast').textContent));
  await page.waitForFunction(() => /4 stripes/.test(document.getElementById('member-facts').textContent));
  assert.equal(await page.locator('#member-note textarea').inputValue(), 'Half typed');
  // Put the stripe back so the steps that follow see what they expect.
  await page.click('#member-note button:has-text("Cancel")');
  await page.click('#member-promotions .undo');
  await page.click('#member-promotions .undo');
  await page.waitForFunction(() => /Grey belt, 3 stripes/.test(document.getElementById('member-facts').textContent));
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
  assert.match(rows[0], /Dan Kim.*Hydrate \$3.*staff/);
  assert.match(rows[1], /Dan Kim.*Water \$1/);
  assert.match(await page.locator('#tab-activity').textContent(), /Dan Kim.*locked/);
  await page.screenshot({ path: join(OUT, 'staff-tab.png') });

  await page.click('#tab-list .row:has-text("Hydrate") .remove');
  assert.equal(await page.locator('#tab-list .row:has-text("Hydrate") .remove').textContent(), 'Confirm remove');
  await page.click('#tab-list .row:has-text("Hydrate") .remove');
  await page.waitForFunction(() => /1 open line today, \$1\./.test(document.getElementById('tab-summary').textContent));
  assert.match((await page.locator('#tab-list .row').allTextContents())[0], /Hydrate.*removed/);
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
  assert.match(lines[0], /Hydrate \$3.*removed/);
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

await step('close-out: review shows the card or the reason, then one confirm charges and shows progress', async () => {
  const cfg = tabConfig(env, tabItems);
  // Dan already has $1 open from the earlier step; two hydrations take him to $7. María: $1, rolls.
  await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'hydration', method: 'kiosk', now: new Date(NOW.getTime() - 3 * 60_000) });
  await recordPurchase(env, cfg, { buyerId: 'c_dan', payerId: 'c_dan', itemKey: 'hydration', method: 'kiosk', now: new Date(NOW.getTime() - 2 * 60_000) });
  await recordPurchase(env, cfg, { buyerId: 'c_maria', payerId: 'c_maria', itemKey: 'water', method: 'kiosk', now: new Date(NOW.getTime() - 60_000) });

  await page.click('.tab[data-tab="tab"]');
  await page.waitForSelector('#tab-closeout');
  await page.click('#tab-closeout');
  await page.waitForSelector('#closeout.active');
  await page.waitForFunction(() => /ending 6222/.test(document.getElementById('closeout-list').textContent));
  const text = await page.locator('#closeout-list').textContent();
  assert.match(text, /Dan Kim.*\$7.*visa ending 6222 \(funnel\)/);
  assert.match(text, /María Núñez.*\$1.*Rolling \(\$1, under \$5\)/);
  assert.equal(await page.locator('#closeout-charge').textContent(), 'Charge 1 member, $7');
  await page.screenshot({ path: join(OUT, 'staff-closeout-review.png') });

  await page.click('#closeout-charge');
  assert.match(await page.locator('#closeout-charge').textContent(), /^Confirm: charge 1 member, \$7/);
  await page.click('#closeout-charge');
  await page.waitForFunction(() => /Invoice sent, charging|Charging on/.test(document.getElementById('closeout-progress').textContent));
  const progress = await page.locator('#closeout-progress').textContent();
  assert.match(progress, /Dan Kim.*\$7.*Charging on Sat, Sep 5.*visa 6222/);
  await page.screenshot({ path: join(OUT, 'staff-closeout-progress.png') });

  const row = env.DB.raw.prepare('SELECT state, invoice_schedule_id, invoice_name FROM closeout_payers').get();
  assert.equal(row.state, 'autopay_on');
  assert.equal(row.invoice_schedule_id, 'sch_1');
  assert.equal(ghlState.schedules[0].name, row.invoice_name);
  assert.deepEqual(ghlState.schedules[0].items.map((i) => [i.name, i.qty, i.amount]), [['Water', 1, 1], ['Hydrate', 2, 3]]);
  assert.equal(ghlState.active.sch_1.autoPayment.paymentMethodId, 'pm_dan');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM purchases WHERE payer_contact_id = 'c_dan' AND status = 'invoiced'").get().n, 3);
  assert.equal(env.DB.raw.prepare("SELECT status FROM purchases WHERE payer_contact_id = 'c_maria'").get().status, 'open', 'María rolled');

  // The invoice gets paid; Check shows it.
  ghlState.invoices.c_dan = [{ _id: 'inv_1', scheduleId: 'sch_1', status: 'paid', amountPaid: 7 }];
  await page.click('#closeout-progress .row .remove:has-text("Check")');
  await page.waitForFunction(() => /Paid/.test(document.getElementById('closeout-progress').textContent));
  assert.equal(env.DB.raw.prepare('SELECT state FROM closeout_payers').get().state, 'paid');
  await page.click('#closeout-back');
  await page.waitForSelector('#tabview.active');
});

await step('member page: pick a name, a wrong PIN, the right PIN, remembered on the phone, and text me my link', async () => {
  // Dan's PIN, set the way the setup link sets it.
  const t = await createSetupToken(env, 'c_dan', 'staff', NOW);
  assert.equal((await completeSetup(env, t.token, '4821', NOW)).ok, true);
  const danToken = await progressToken('c_dan', env.ID_SALT);

  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const m = await phoneCtx.newPage();
  const mErrors = [];
  m.on('pageerror', (e) => mErrors.push(String(e)));
  await m.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await m.goto(`${base}/member`);
  await m.waitForSelector('#find.active');
  assert.equal(await m.locator('#find h1').textContent(), 'Your progress');
  await m.fill('#name', 'da');
  await m.waitForSelector('.tile');
  await m.screenshot({ path: join(OUT, 'member-search.png') });
  await m.click('.tile:has-text("Dan Kim")');
  await m.waitForSelector('#enter.active');
  assert.equal(await m.locator('#hello').textContent(), 'Hi Dan');
  assert.equal(await m.locator('#pin').isVisible(), true);
  assert.equal(await m.locator('#text-link').isVisible(), true);
  await m.screenshot({ path: join(OUT, 'member-login.png'), fullPage: true });

  await m.fill('#pin', '0000');
  await m.click('#open');
  await m.waitForFunction(() => /That PIN didn't match/.test(document.getElementById('msg').textContent));
  assert.equal(await m.inputValue('#pin'), '', 'cleared for another try');
  const text = await m.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, /!|—|@|billing|balance|\$/i, 'copy rules');

  await m.fill('#pin', '4821');
  await m.click('#open');
  await m.waitForURL(`**/me?t=${danToken}`);
  await m.waitForSelector('.card');
  assert.equal(await m.locator('.who h1').textContent(), 'Dan Kim');

  // The phone remembers: /member goes straight back to the page.
  await m.goto(`${base}/member`);
  await m.waitForURL(`**/me?t=${danToken}`);
  await m.waitForSelector('.card');
  // "Not you?" forgets it and asks again.
  await m.click('#switch');
  await m.waitForSelector('#find.active');
  assert.equal(await m.evaluate(() => localStorage.getItem('btt.member.link')), null);

  // No PIN: the text link, to the phone on file.
  const before = progressLinks.length;
  await m.fill('#name', 'emma');
  await m.click('.tile:has-text("Emma Jones")');
  await m.waitForSelector('#enter.active');
  await m.fill('#pin', '4821');
  await m.click('#open');
  await m.waitForFunction(() => /No PIN on this account yet/.test(document.getElementById('msg').textContent));
  await m.click('#text-link');
  await m.waitForFunction(() => /Sent\. Check your texts/.test(document.getElementById('msg').textContent));
  assert.equal(progressLinks.length, before + 1);
  assert.equal(progressLinks.at(-1)[0], 'c_emma');
  // And a PIN setup link, for someone who wants one.
  await m.click('#pin-setup');
  await m.waitForFunction(() => /Check your texts for a link to set your PIN/.test(document.getElementById('msg').textContent));
  assert.equal(pinLinks.at(-1)[0], 'c_emma');
  await m.click('#back');
  await m.waitForSelector('#find.active');
  const wide = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(wide, false, 'no horizontal scroll on a phone');
  assert.deepEqual(mErrors, []);
  await phoneCtx.close();
});

await step('kids stripes: the monthly colours on the member screen and the progress page, and the twelfth is the belt', async () => {
  await page.click('.tab[data-tab="members"]');
  await page.fill('#member-search', 'jack');
  await page.waitForSelector('#member-tiles .tile');
  await page.click('#member-tiles .tile:has-text("Jack Silva")');
  await page.waitForFunction(() => document.getElementById('member').classList.contains('active') && document.getElementById('member-title').textContent === 'Jack Silva');

  // A kid is offered none to eleven, each named by its colours.
  assert.equal(await page.locator('#rank-stripes option').count(), 12);
  assert.equal(await page.locator('#rank-stripes option').nth(0).textContent(), 'No stripes');
  assert.equal(await page.locator('#rank-stripes option').nth(6).textContent(), '6 stripes (2 red, 2 white)');
  assert.equal(await page.locator('#rank-stripes option').nth(11).textContent(), '11 stripes (3 yellow, 1 red)');
  const setStripes = async (n) => {
    await page.selectOption('#rank-belt', 'grey');
    await page.selectOption('#rank-stripes', String(n));
    await page.check('#rank-held');
    await page.click('#rank-save');
    await page.click('#rank-save');
  };
  await setStripes(6);
  await page.waitForFunction(() => /Grey belt, 6 stripes \(2 red, 2 white\)/.test(document.getElementById('member-facts').textContent));
  assert.equal(await page.locator('#member-stripe').isVisible(), true);
  await page.screenshot({ path: join(OUT, 'staff-member-coloured-stripes.png') });

  // The progress page draws the four stripes in their colours.
  const phoneCtx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const me = await phoneCtx.newPage();
  await me.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await me.goto(`${base}/me?t=${await progressToken('c_jack', env.ID_SALT)}`);
  await me.waitForSelector('.card');
  const drawn = await me.locator('.belt .bar i').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  assert.equal(drawn.length, 4, 'never more than four on the belt');
  assert.equal(new Set(drawn.slice(0, 2)).size, 1);
  assert.equal(new Set(drawn.slice(2)).size, 1);
  assert.notEqual(drawn[0], drawn[2], 'two red, then two white');
  assert.match(await me.locator('.rank .label').textContent(), /Grey belt, 6 stripes/);
  await me.screenshot({ path: join(OUT, 'me-coloured-stripes.png') });
  await phoneCtx.close();

  // On eleven there is no twelfth stripe to give: the page says what is next.
  await setStripes(11);
  await page.waitForFunction(() => /11 stripes \(3 yellow, 1 red\)/.test(document.getElementById('member-facts').textContent));
  assert.equal(await page.locator('#member-stripe').isVisible(), false);
  assert.match(await page.locator('#rank-next').textContent(), /Eleven stripes\. The next step is the Grey-black belt\./);

  // Seven more classes make him eligible again. The Stripes tab offers the belt, not a stripe.
  const ins = env.DB.raw.prepare("INSERT INTO attendance (ghl_contact_id, class_name, class_start_local, checked_in_at, method) VALUES ('c_jack', 'Kids 6-9', ?, ?, 'staff')");
  for (let i = 1; i <= 7; i += 1) ins.run(`2026-07-0${i}T09:09`, `2026-07-0${i}T13:09:00Z`);
  await page.click('.tab[data-tab="stripes"]');
  const row = page.locator('#stripes-list .row', { hasText: 'Jack Silva' });
  await row.waitFor();
  assert.match(await row.textContent(), /belt next/);
  const button = row.locator('.award');
  assert.equal(await button.textContent(), 'Record Grey-black belt');
  await button.click();
  assert.equal(await button.textContent(), 'Confirm Grey-black belt');
  await button.click();
  await page.waitForFunction(() => /Grey-black belt recorded for Jack/.test(document.getElementById('toast').textContent));
  const last = env.DB.raw.prepare("SELECT kind, belt, stripes, starting FROM promotions WHERE ghl_contact_id = 'c_jack' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual([last.kind, last.belt, last.stripes, last.starting], ['belt', 'grey-black', 0, 0]);
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
