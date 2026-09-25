// Browser check for the kiosk page. Not part of `npm test`: it needs
// Playwright with Chromium. Run with:
//   NODE_PATH=$(npm root -g) node test/browser/kiosk.mjs [screenshot-dir]
// Serves public/ with mocked /api routes, drives the flow at iPad and
// phone sizes, exercises the offline queue, and writes screenshots.

import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] || join(ROOT, '.screenshots');
mkdirSync(OUT, { recursive: true });

const ROSTER = [
  { id: 'aaaaaaaaaaaaaaaaaaaa', first: 'Jack', last: 'Silva', program: 'Kids 6-9', programs: ['kids-6-9'] },
  // Two programs both in the mocked window so the two-button confirm screen renders.
  { id: 'bbbbbbbbbbbbbbbbbbbb', first: 'Leo', last: 'Ortiz', program: 'Kids 6-9 / Kids 10-14', programs: ['kids-6-9', 'kids-10-14'] },
  { id: 'cccccccccccccccccccc', first: 'María', last: 'Núñez', program: 'Adult', programs: ['adult'] },
  { id: 'dddddddddddddddddddd', first: 'Jamie', last: 'Baker', program: 'Kids 3-5', programs: ['kids-3-5'] },
  { id: 'eeeeeeeeeeeeeeeeeeee', first: 'Jaden', last: 'Adams', program: 'Kids 3-5', programs: ['kids-3-5'] },
  { id: 'ffffffffffffffffffff', first: 'Jasmine', last: 'Kim', program: 'Kids 6-9', programs: ['kids-6-9'] },
  { id: '11111111111111111111', first: 'Jax', last: 'Tan', program: 'Kids 6-9', programs: ['kids-6-9'] },
  { id: '22222222222222222222', first: 'Jayden', last: 'Ross', program: 'Kids 6-9', programs: ['kids-6-9'] },
  { id: '33333333333333333333', first: 'Jake', last: 'Miller', program: 'Adult', programs: ['adult'] },
];
// Sat 11:00 ET: Kids 6-9 (11:00) and Kids 10-14 (11:45) are in window; adults are not.
const CURRENT = {
  now: '2026-09-05T15:00:00.000Z', nowLocal: '2026-09-05T11:00', date: '2026-09-05', weekday: 'Sat',
  window: { earlyMin: 180, lateMin: 180 },
  matches: [
    { name: 'Kids 6-9', program: 'kids-6-9', programLabel: 'Kids 6-9', start: '11:00', minutes: 45, startLocal: '2026-09-05T11:00', startsInMin: 0 },
    { name: 'Kids 10-14', program: 'kids-10-14', programLabel: 'Kids 10-14', start: '11:45', minutes: 60, startLocal: '2026-09-05T11:45', startsInMin: 45 },
  ],
};

const state = { failCheckins: false, checkins: [], seen: new Set(), purchases: [], links: [], pins: { cccccccccccccccccccc: '1234' }, failPurchases: false, locked: new Set() };
const TAB_ITEMS = [{ key: 'water', label: 'Water', amountCents: 100, price: '$1' }, { key: 'hydration', label: 'Hydration', amountCents: 300, price: '$3' }];
// Adults may buy (María has a PIN, Jake does not); kids never see the row.
const ADULTS = new Set(['cccccccccccccccccccc', '33333333333333333333']);
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(JSON.parse(b || '{}'))); });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/roster') return send(200, ROSTER);
  if (url.pathname === '/api/current-class') return send(200, CURRENT);
  if (url.pathname === '/api/checkin' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (state.failCheckins) return send(500, { error: 'boom' });
      const rec = JSON.parse(body);
      state.checkins.push(rec);
      const key = `${rec.contactId}|${rec.classStartLocal}`;
      const duplicate = state.seen.has(key);
      state.seen.add(key);
      const count = [...state.seen].filter((k) => k.startsWith(rec.contactId)).length;
      const out = { ok: true, duplicate, className: rec.className, classStartLocal: rec.classStartLocal, classCount: count, classCountLabel: `Class #${count}`, waiverNeeded: rec.contactId === 'ffffffffffffffffffff' };
      if (ADULTS.has(rec.contactId)) out.tab = { items: TAB_ITEMS, hasPin: Boolean(state.pins[rec.contactId]), locked: state.locked.has(rec.contactId) };
      send(200, out);
    });
    return;
  }
  if (url.pathname === '/api/tab/purchase' && req.method === 'POST') {
    readBody(req).then((b) => {
      if (state.failPurchases) return send(500, { error: 'boom' });
      if (!ADULTS.has(b.contactId)) return send(403, { reason: 'not_eligible' });
      if (state.locked.has(b.contactId)) return send(423, { ok: false, reason: 'locked' });
      if (!state.pins[b.contactId]) return send(409, { ok: false, reason: 'no_pin' });
      if (state.pins[b.contactId] !== b.pin) return send(401, { ok: false, reason: 'wrong' });
      const item = TAB_ITEMS.find((i) => i.key === b.item);
      state.purchases.push(b);
      send(200, { ok: true, item: item.key, label: item.label, amountCents: item.amountCents, message: `Added to your tab. ${item.label}, ${item.price}.` });
    });
    return;
  }
  if (url.pathname === '/api/tab/pin-link' && req.method === 'POST') {
    readBody(req).then((b) => {
      const sent = !state.links.includes(b.contactId);
      state.links.push(b.contactId);
      send(200, { ok: true, sent, reason: sent ? undefined : 'recent' });
    });
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const p = join(ROOT, 'public', file);
  if (!existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
let failures = 0;
let activePage = null;
async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures += 1;
    const lines = e.message.split('\n');
    const waiting = lines.find((l) => /waiting for|locator\(/.test(l));
    console.log(`FAIL ${name}\n     ${lines[0]}${waiting ? `\n     ${waiting.trim()}` : ''}`);
    if (activePage) await activePage.reload().catch(() => {});
  }
}

// ---------- iPad portrait ----------
const ipad = await browser.newContext({ ...devices['iPad (gen 7)'], viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1 });
const page = await ipad.newPage();
activePage = page;
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await page.goto(`${base}/`);
await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'name-input');
await page.screenshot({ path: join(OUT, 'ipad-home.png') });

await step('home: input focused, no tiles under 2 chars', async () => {
  await page.fill('#name-input', 'j');
  assert.equal(await page.locator('.tile').count(), 0);
});
await step('search: "ja" shows at most 6 tiles with first and last name, program', async () => {
  await page.fill('#name-input', 'ja');
  await page.waitForSelector('.tile');
  const tiles = await page.locator('.tile').allTextContents();
  assert.equal(tiles.length, 6, `got ${tiles.length}`);
  assert.match(tiles[0], /Jack Silva/);
  assert.match(tiles[0], /Kids 6-9/);
  await page.screenshot({ path: join(OUT, 'ipad-search.png') });
});
await step('confirm: Jack pre-selects Kids 6-9 at 11:00 AM', async () => {
  await page.click('.tile:has-text("Jack Silva")');
  await page.waitForSelector('#checkin');
  const line = await page.locator('#confirm .class-line').textContent();
  assert.match(line, /Kids 6-9\s*11:00 AM/);
  assert.equal(await page.locator('#confirm-name').textContent(), 'Jack Silva');
  assert.equal(await page.locator('#confirm-program').textContent(), 'Kids 6-9');
  await page.screenshot({ path: join(OUT, 'ipad-confirm.png') });
});
await step('success: shows class, time, and Class #1, then returns home', async () => {
  await page.click('#checkin');
  await page.waitForSelector('#success.active');
  assert.equal(await page.locator('#success-class').textContent(), 'Kids 6-9, 11:00 AM');
  assert.equal(await page.locator('#success-count').textContent(), 'Class #1');
  assert.match(await page.locator('#success h2').textContent(), /You're checked in/);
  await page.screenshot({ path: join(OUT, 'ipad-success.png') });
  await page.waitForSelector('#home.active', { timeout: 5000 });
  assert.equal(await page.inputValue('#name-input'), '');
  assert.equal(state.checkins.length, 1);
  assert.equal(state.checkins[0].className, 'Kids 6-9');
  assert.equal(state.checkins[0].classStartLocal, '2026-09-05T11:00');
});
await step('duplicate: second tap still shows the success screen', async () => {
  await page.fill('#name-input', 'jack');
  await page.click('.tile:has-text("Jack Silva")');
  await page.click('#checkin');
  await page.waitForSelector('#success.active');
  assert.equal(await page.locator('#success-count').textContent(), 'Class #1');
  await page.waitForSelector('#home.active', { timeout: 5000 });
});
await step('two programs: Leo sees two large buttons', async () => {
  await page.fill('#name-input', 'leo');
  await page.click('.tile:has-text("Leo Ortiz")');
  await page.waitForSelector('#confirm .btn[data-class]');
  const labels = await page.locator('#confirm .btn[data-class]').allTextContents();
  assert.equal(labels.length, 2);
  assert.match(labels[0], /Kids 6-9/);
  assert.match(labels[1], /Kids 10-14/);
  await page.screenshot({ path: join(OUT, 'ipad-two-classes.png') });
  await page.click('#confirm .btn[data-class="Kids 10-14"]');
  await page.waitForSelector('#success.active');
  assert.equal(await page.locator('#success-class').textContent(), 'Kids 10-14, 11:45 AM');
  await page.waitForSelector('#home.active', { timeout: 5000 });
});
await step('no class: María (adult) gets "Check in anyway" and records open mat', async () => {
  await page.fill('#name-input', 'nun');
  await page.click('.tile:has-text("María Núñez")');
  await page.waitForSelector('#checkin-anyway');
  assert.match(await page.locator('#confirm .class-line').textContent(), /No class right now/);
  await page.screenshot({ path: join(OUT, 'ipad-no-class.png') });
  await page.click('#checkin-anyway');
  await page.waitForSelector('#success.active');
  const last = state.checkins.at(-1);
  assert.equal(last.className, 'open mat / unscheduled');
  assert.equal(last.classStartLocal, '2026-09-05T00:00');
  await page.waitForSelector('#home.active', { timeout: 5000 });
});
await step('waiver missing: success screen adds the prompt and holds longer', async () => {
  await page.fill('#name-input', 'jas');
  await page.click('.tile:has-text("Jasmine Kim")');
  await page.click('#checkin');
  await page.waitForSelector('#success.active');
  assert.equal(await page.locator('#waiver').isVisible(), true);
  assert.match(await page.locator('#waiver p').textContent(), /sign the waiver/);
  await page.screenshot({ path: join(OUT, 'ipad-waiver.png') });
  await page.waitForTimeout(4000);
  assert.equal(await page.locator('#success.active').count(), 1, 'still on the success screen after 4 s');
  await page.waitForSelector('#home.active', { timeout: 12000 });
  // A member with a waiver never sees it.
  await page.fill('#name-input', 'jack');
  await page.click('.tile:has-text("Jack Silva")');
  await page.click('#checkin');
  await page.waitForSelector('#success.active');
  assert.equal(await page.locator('#waiver').isVisible(), false);
  await page.waitForSelector('#home.active', { timeout: 5000 });
});

await step('drink tab: an adult with a PIN sees the row, types the PIN, the drink lands on the tab', async () => {
  await page.fill('#name-input', 'nun');
  await page.click('.tile:has-text("María Núñez")');
  await page.waitForSelector('#checkin-anyway');
  await page.click('#checkin-anyway');
  await page.waitForSelector('#success.active');
  await page.waitForSelector('#tab.active');
  assert.deepEqual(await page.locator('.drink .n').allTextContents(), ['Water', 'Hydration']);
  assert.deepEqual(await page.locator('.drink .p').allTextContents(), ['$1', '$3']);
  assert.equal(await page.locator('#tab-ask').textContent(), 'Thirsty?');
  assert.match(await page.locator('#tab-note').textContent(), /Charged to your account/);
  await page.screenshot({ path: join(OUT, 'ipad-drinks.png') });

  await page.click('.drink[data-item="water"]');
  await page.waitForSelector('#pad.active');
  assert.match(await page.locator('#pad-sub').textContent(), /Water, \$1/);
  await page.screenshot({ path: join(OUT, 'ipad-pin-pad.png') });
  // A wrong PIN says so and stays on the pad.
  for (const k of ['0', '0', '0', '0']) await page.click(`.key[data-key="${k}"]`);
  await page.waitForFunction(() => /didn't match/.test(document.getElementById('pad-msg').textContent));
  assert.equal(await page.locator('#pad.active').count(), 1);
  assert.equal(await page.locator('.dot.on').count(), 0, 'dots cleared for another try');
  // The right one.
  for (const k of ['1', '2', '3', '4']) await page.click(`.key[data-key="${k}"]`);
  await page.waitForFunction(() => /Added to your tab\. Water, \$1\./.test(document.getElementById('tab-msg').textContent));
  assert.equal(await page.locator('#pad.active').count(), 0);
  assert.equal(await page.locator('.drink').count(), 0, 'one drink per check-in screen');
  assert.equal(state.purchases.length, 1);
  assert.equal(state.purchases[0].item, 'water');
  assert.equal(state.purchases[0].pin, '1234');
  assert.equal(state.purchases[0].contactId, 'cccccccccccccccccccc');
  await page.screenshot({ path: join(OUT, 'ipad-drink-added.png') });
  // The screen held past the normal 3 seconds, then goes home.
  await page.waitForSelector('#home.active', { timeout: 12000 });
});
await step('drink tab: a kid never sees the row', async () => {
  await page.fill('#name-input', 'jack');
  await page.click('.tile:has-text("Jack Silva")');
  await page.click('#checkin');
  await page.waitForSelector('#success.active');
  assert.equal(await page.locator('#tab.active').count(), 0);
  await page.waitForSelector('#home.active', { timeout: 5000 });
});
await step('drink tab: no PIN yet offers a setup link, once', async () => {
  await page.fill('#name-input', 'jake');
  await page.click('.tile:has-text("Jake Miller")');
  await page.waitForSelector('#checkin-anyway');
  await page.click('#checkin-anyway');
  await page.waitForSelector('#pin-link');
  assert.equal(await page.locator('.drink').count(), 0);
  assert.match(await page.locator('#tab-setup').textContent(), /Set up your purchase PIN/);
  await page.screenshot({ path: join(OUT, 'ipad-pin-setup.png') });
  await page.click('#pin-link');
  await page.waitForFunction(() => /Check your texts for a link/.test(document.getElementById('tab-msg').textContent));
  assert.deepEqual(state.links, ['33333333333333333333']);
  await page.waitForSelector('#home.active', { timeout: 12000 });
  // Straight away again: not resent, and it says so.
  await page.fill('#name-input', 'jake');
  await page.click('.tile:has-text("Jake Miller")');
  await page.waitForSelector('#checkin-anyway');
  await page.click('#checkin-anyway');
  await page.waitForSelector('#pin-link');
  await page.click('#pin-link');
  await page.waitForFunction(() => /We just sent one/.test(document.getElementById('tab-msg').textContent));
  await page.waitForSelector('#home.active', { timeout: 12000 });
});
await step('drink tab: a failed purchase says so and nothing is queued', async () => {
  state.failPurchases = true;
  const before = state.purchases.length;
  await page.fill('#name-input', 'nun');
  await page.click('.tile:has-text("María Núñez")');
  await page.waitForSelector('#checkin-anyway');
  await page.click('#checkin-anyway');
  await page.waitForSelector('.drink[data-item="hydration"]');
  await page.click('.drink[data-item="hydration"]');
  await page.waitForSelector('#pad.active');
  for (const k of ['1', '2', '3', '4']) await page.click(`.key[data-key="${k}"]`);
  await page.waitForFunction(() => /didn't go through\. Nothing was added to your tab\./.test(document.getElementById('tab-msg').textContent));
  assert.equal(state.purchases.length, before);
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('btt.checkin.queue') || '[]'));
  assert.equal(queued.length, 0, 'purchases are never queued');
  state.failPurchases = false;
  await page.waitForSelector('#home.active', { timeout: 12000 });
});
await step('drink tab: Cancel on the pad, and the locked state', async () => {
  await page.fill('#name-input', 'nun');
  await page.click('.tile:has-text("María Núñez")');
  await page.waitForSelector('#checkin-anyway');
  await page.click('#checkin-anyway');
  await page.waitForSelector('.drink[data-item="water"]');
  await page.click('.drink[data-item="water"]');
  await page.waitForSelector('#pad.active');
  await page.click('.key[data-key="1"]');
  await page.click('.key[data-key="Delete"]');
  assert.equal(await page.locator('.dot.on').count(), 0);
  await page.click('.key[data-key="Cancel"]');
  assert.equal(await page.locator('#pad.active').count(), 0);
  await page.waitForSelector('#home.active', { timeout: 12000 });

  state.locked.add('cccccccccccccccccccc');
  await page.fill('#name-input', 'nun');
  await page.click('.tile:has-text("María Núñez")');
  await page.waitForSelector('#checkin-anyway');
  await page.click('#checkin-anyway');
  await page.waitForSelector('#tab.active');
  assert.equal(await page.locator('.drink').count(), 0);
  assert.match(await page.locator('#tab-msg').textContent(), /Purchases are paused for this account/);
  state.locked.delete('cccccccccccccccccccc');
  await page.waitForSelector('#home.active', { timeout: 5000 });
});

await step('back button returns home', async () => {
  await page.fill('#name-input', 'jam');
  await page.click('.tile:has-text("Jamie Baker")');
  await page.click('#back');
  await page.waitForSelector('#home.active');
});
await step('offline: failed POST still shows success and queues with its original timestamp', async () => {
  state.failCheckins = true;
  const before = state.checkins.length;
  await page.fill('#name-input', 'jas');
  await page.click('.tile:has-text("Jasmine Kim")');
  await page.click('#checkin');
  await page.waitForSelector('#success.active');
  assert.equal(await page.locator('#success-class').textContent(), 'Kids 6-9, 11:00 AM');
  assert.equal(await page.locator('#success-count').textContent(), '');
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('btt.checkin.queue') || '[]'));
  assert.equal(queued.length, 1);
  assert.equal(state.checkins.length, before);
  assert.match(await page.locator('#status').textContent(), /1 check-in waiting to sync/);
  await page.waitForSelector('#home.active', { timeout: 5000 });
  state.failCheckins = false;
  const ts = queued[0].clientTs;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => (localStorage.getItem('btt.checkin.queue') || '[]') === '[]');
  assert.equal(state.checkins.at(-1).clientTs, ts, 'original tap time retried');
  assert.equal(await page.locator('#status').textContent(), '');
});
await step('page text never shows an email, phone, billing, or status', async () => {
  const text = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, /@|billing|inactive|balance/i);
  assert.doesNotMatch(text, /!/);
  assert.doesNotMatch(text, /—/);
});
await step('no page errors', () => assert.deepEqual(errors, []));
await ipad.close();

// ---------- phone ----------
const phone = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
const p2 = await phone.newPage();
activePage = p2;
await p2.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p2.goto(`${base}/`);
await p2.waitForSelector('#name-input');
await p2.screenshot({ path: join(OUT, 'phone-home.png') });
await step('phone: search and confirm fit the viewport without horizontal scroll', async () => {
  await p2.fill('#name-input', 'ja');
  await p2.waitForSelector('.tile');
  await p2.screenshot({ path: join(OUT, 'phone-search.png') });
  const wide = await p2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(wide, false, 'horizontal overflow');
  const scrolls = await p2.evaluate(() => { const h = document.getElementById('home'); return h.scrollHeight > h.clientHeight && getComputedStyle(h).overflowY === 'auto'; });
  assert.equal(scrolls, true, 'tile list scrolls on a phone');
  await p2.click('.tile:has-text("Jack Silva")');
  await p2.waitForSelector('#checkin');
  const box = await p2.locator('#checkin').boundingBox();
  const vh = await p2.evaluate(() => window.innerHeight);
  assert.ok(box.y + box.height <= vh, 'check-in button is on screen');
  await p2.screenshot({ path: join(OUT, 'phone-confirm.png') });
});
await phone.close();

await browser.close();
server.close();
console.log(failures === 0 ? `\nall browser checks passed; screenshots in ${OUT}` : `\n${failures} browser check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
