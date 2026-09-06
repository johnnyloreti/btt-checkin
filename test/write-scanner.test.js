// §6: the only GHL write is PUT /contacts/{id} with custom field values.
// This scans src/ so a stray POST, DELETE, or second PUT fails the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './helpers.js';

const GHL_FILE = 'src/ghl.js';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'src')).map((p) => ({ rel: relative(ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

test('only src/ghl.js talks to GHL', () => {
  for (const f of files) {
    if (f.rel === GHL_FILE) continue;
    assert.doesNotMatch(f.text, /leadconnectorhq|GHL_BASE|GHL_TOKEN|Bearer\s/i, `${f.rel} references GHL directly`);
  }
});

test('src/ghl.js uses only GET, plus one PUT to /contacts/{id}', () => {
  const ghl = files.find((f) => f.rel === GHL_FILE);
  assert.ok(ghl, `${GHL_FILE} missing`);

  const methods = [...ghl.text.matchAll(/method\s*:\s*['"`]([A-Z]+)['"`]/g)].map((m) => m[1]);
  assert.ok(methods.length > 0, 'expected explicit method: on every fetch');
  for (const m of methods) assert.ok(m === 'GET' || m === 'PUT', `disallowed HTTP method ${m}`);

  // Every fetch call must spell its method out, so nothing hides behind a default.
  const fetchCalls = (ghl.text.match(/fetchImpl\(|\bfetch\(/g) || []).length;
  assert.equal(fetchCalls, methods.length, 'every fetch call must set method explicitly');

  const puts = methods.filter((m) => m === 'PUT');
  assert.ok(puts.length <= 1, 'at most one PUT');
  if (puts.length === 1) {
    // The PUT must sit inside a function whose path is /contacts/<id>.
    const idx = ghl.text.search(/method\s*:\s*['"`]PUT['"`]/);
    const before = ghl.text.slice(Math.max(0, idx - 800), idx);
    assert.match(before, /\/contacts\/\$\{/, 'PUT must target /contacts/{id}');
    assert.doesNotMatch(before, /\/(opportunities|conversations|calendars|tags|workflows|campaigns)/i);
  }
});

test('no other HTTP verbs appear anywhere in src', () => {
  for (const f of files) {
    assert.doesNotMatch(f.text, /method\s*:\s*['"`](DELETE|PATCH)['"`]/, `${f.rel} uses a forbidden verb`);
  }
});
