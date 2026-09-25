// §6 and §15.3: the exhaustive allowlist of GHL calls. Every request leaves
// through ghlRequest(env, 'METHOD', 'path', ...) in src/ghl.js with a literal
// method and path, so this test can read them all and refuse anything else.
// A new GHL call means a new row in CLAUDE.md §15.3's table and here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './helpers.js';

const GHL_FILE = 'src/ghl.js';

// method + path with `${...}` collapsed to `{}`.
const ALLOWED = new Set([
  'GET /contacts/',
  'GET /locations/{}/customFields',
  'PUT /contacts/{}',
  'GET /contacts/{}',
  'GET /payments/transactions',
  'GET /payments/transactions/{}',
  'GET /invoices/schedule',
  'GET /invoices/schedule/{}',
  'POST /invoices/schedule',
  'POST /invoices/schedule/{}/schedule',
  'GET /invoices/',
  'GET /invoices/{}',
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'src')).map((p) => ({ rel: relative(ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));
const ghl = files.find((f) => f.rel === GHL_FILE);

test('only src/ghl.js talks to GHL', () => {
  assert.ok(ghl, `${GHL_FILE} missing`);
  for (const f of files) {
    if (f.rel === GHL_FILE) continue;
    assert.doesNotMatch(f.text, /leadconnectorhq|GHL_BASE|GHL_TOKEN|Bearer\s|ghlRequest/i, `${f.rel} references GHL directly`);
  }
});

test('src/ghl.js has exactly one fetch, inside ghlRequest', () => {
  const fetches = ghl.text.match(/fetchImpl\(|\bfetch\(/g) || [];
  assert.equal(fetches.length, 1, 'every request must go through ghlRequest');
  const idx = ghl.text.search(/fetchImpl\(/);
  const before = ghl.text.slice(0, idx);
  assert.ok(/export async function ghlRequest\(/.test(before) && before.lastIndexOf('export async function') === before.lastIndexOf('export async function ghlRequest('), 'the fetch must be inside ghlRequest');
  // ghlRequest itself never hard-codes a method.
  assert.doesNotMatch(ghl.text, /method\s*:\s*['"`]/, 'no fetch init may carry a literal method; it comes from the call site');
});

test('every ghlRequest call site is a literal method and path on the allowlist', () => {
  const calls = [...ghl.text.matchAll(/ghlRequest\(\s*env\s*,\s*(['"`])([A-Z]+)\1\s*,\s*(`[^`]*`|'[^']*'|"[^"]*")/g)];
  // Count every ghlRequest( that is not the definition, and make sure the regex caught them all.
  const invocations = (ghl.text.match(/ghlRequest\(/g) || []).length - 1;
  assert.equal(calls.length, invocations, 'a ghlRequest call without a literal method and path');
  assert.ok(calls.length >= ALLOWED.size, 'expected a call site for every allowed pair');
  const seen = new Set();
  for (const m of calls) {
    const method = m[2];
    const path = m[3].slice(1, -1).replace(/\$\{[^}]*\}/g, '{}');
    const key = `${method} ${path}`;
    assert.ok(ALLOWED.has(key), `GHL call not on the allowlist: ${key}`);
    seen.add(key);
  }
  for (const k of ALLOWED) assert.ok(seen.has(k), `allowlisted call has no call site: ${k}`);
});

test('no other HTTP verbs appear anywhere in src', () => {
  for (const f of files) {
    assert.doesNotMatch(f.text, /['"`](DELETE|PATCH)['"`]/, `${f.rel} names a forbidden verb`);
  }
  // Exactly three writes in the whole of src: the contact PUT and the two schedule POSTs.
  const writes = [...ghl.text.matchAll(/ghlRequest\(\s*env\s*,\s*['"`](PUT|POST)['"`]/g)];
  assert.equal(writes.length, 3);
});
