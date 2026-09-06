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
  { id: 'aaaaaaaaaaaaaaaaaaaa', first: 'Jack', lastInitial: 'S', lastKey: 'silv', program: 'Kids 6-9', programs: ['kids-6-9'] },
  // Two programs both in the mocked window so the two-button confirm screen renders.
  { id: 'bbbbbbbbbbbbbbbbbbbb', first: 'Leo', lastInitial: 'O', lastKey: 'orti', program: 'Kids 6-9 / Kids 10-14', programs: ['kids-6-9', 'kids-10-14'] },
  { id: 'cccccccccccccccccccc', first: 'María', lastInitial: 'N', lastKey: 'nune', program: 'Adult', programs: ['adult'] },
  { id: 'dddddddddddddddddddd', first: 'Jamie', lastInitial: 'B', lastKey: 'bake', program: 'Kids 3-5', programs: ['kids-3-5'] },
  { id: 'eeeeeeeeeeeeeeeeeeee', first: 'Jaden', lastInitial: 'A', lastKey: 'adam', program: 'Kids 3-5', programs: ['kids-3-5'] },
  { id: 'ffffffffffffffffffff', first: 'Jasmine', lastInitial: 'K', lastKey: 'kim', program: 'Kids 6-9', programs: ['kids-6-9'] },
  { id: '11111111111111111111', first: 'Jax', lastInitial: 'T', lastKey: 'tan', program: 'Kids 6-9', programs: ['kids-6-9'] },
  { id: '22222222222222222222', first: 'Jayden', lastInitial: 'R', lastKey: 'ross', program: 'Kids 6-9', programs: ['kids-6-9'] },
  { id: '33333333333333333333', first: 'Jake', lastInitial: 'M', lastKey: 'mill', program: 'Adult', programs: ['adult'] },
];
// Sat 11:00 ET: Kids 6-9 (11:00) and Kids 10-14 (11:45) are in window; adults are not.
const CURRENT = {
  now: '2026-09-05T15:00:00.000Z', nowLocal: '2026-09-05T11:00', date: '2026-09-05', weekday: 'Sat',
  window: { earlyMin: 45, lateMin: 15 },
  matches: [
    { name: 'Kids 6-9', program: 'kids-6-9', programLabel: 'Kids 6-9', start: '11:00', minutes: 45, startLocal: '2026-09-05T11:00', startsInMin: 0 },
    { name: 'Kids 10-14', program: 'kids-10-14', programLabel: 'Kids 10-14', start: '11:45', minutes: 60, startLocal: '2026-09-05T11:45', startsInMin: 45 },
  ],
};

const state = { failCheckins: false, checkins: [], seen: new Set() };
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
      send(200, { ok: true, duplicate, className: rec.className, classStartLocal: rec.classStartLocal, classCount: count, classCountLabel: `Class #${count}` });
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
    console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`);
    if (activePage) await activePage.reload().catch(() => {});
  }
}

// ---------- iPad portrait ----------
const ipad = await browser.newContext({ ...devices['iPad (gen 7)'], viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1 });
const page = await ipad.newPage();
activePage = page;
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}/`);
await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'name-input');
await page.screenshot({ path: join(OUT, 'ipad-home.png') });

await step('home: input focused, no tiles under 2 chars', async () => {
  await page.fill('#name-input', 'j');
  assert.equal(await page.locator('.tile').count(), 0);
});
await step('search: "ja" shows at most 6 tiles with first name, last initial, program', async () => {
  await page.fill('#name-input', 'ja');
  await page.waitForSelector('.tile');
  const tiles = await page.locator('.tile').allTextContents();
  assert.equal(tiles.length, 6, `got ${tiles.length}`);
  assert.match(tiles[0], /Jack S\./);
  assert.match(tiles[0], /Kids 6-9/);
  await page.screenshot({ path: join(OUT, 'ipad-search.png') });
});
await step('confirm: Jack pre-selects Kids 6-9 at 11:00 AM', async () => {
  await page.click('.tile:has-text("Jack S.")');
  await page.waitForSelector('#checkin');
  const line = await page.locator('#confirm .class-line').textContent();
  assert.match(line, /Kids 6-9\s*11:00 AM/);
  assert.equal(await page.locator('#confirm-name').textContent(), 'Jack S.');
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
  await page.click('.tile:has-text("Jack S.")');
  await page.click('#checkin');
  await page.waitForSelector('#success.active');
  assert.equal(await page.locator('#success-count').textContent(), 'Class #1');
  await page.waitForSelector('#home.active', { timeout: 5000 });
});
await step('two programs: Leo sees two large buttons', async () => {
  await page.fill('#name-input', 'leo');
  await page.click('.tile:has-text("Leo O.")');
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
  await page.click('.tile:has-text("María N.")');
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
await step('back button returns home', async () => {
  await page.fill('#name-input', 'jam');
  await page.click('.tile:has-text("Jamie B.")');
  await page.click('#back');
  await page.waitForSelector('#home.active');
});
await step('offline: failed POST still shows success and queues with its original timestamp', async () => {
  state.failCheckins = true;
  const before = state.checkins.length;
  await page.fill('#name-input', 'jas');
  await page.click('.tile:has-text("Jasmine K.")');
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
  await p2.click('.tile:has-text("Jack S.")');
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
