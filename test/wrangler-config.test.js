// wrangler.toml: every setting the Worker reads from env has to sit under
// [vars]. On 2026-11-20 two were appended at the end of the file, which put
// them inside the last [[ratelimits]] table. Wrangler only warned, the deploy
// went through, and production ran without them: the Family box Johnny had
// approved stayed off. This pins the file's shape so that cannot recur.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './helpers.js';

const lines = readRepoFile('wrangler.toml').replace(/^﻿/, '').split(/\r?\n/);

// Each KEY = value line, with the [section] it falls under.
function settings() {
  const out = [];
  let section = '(top)';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (head) { section = head[1].trim(); continue; }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=/);
    if (kv) out.push({ key: kv[1], section });
  }
  return out;
}

test('every upper-case setting is under [vars], where the Worker can read it', () => {
  const stray = settings().filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s.key) && s.section !== 'vars');
  assert.deepEqual(stray.map((s) => `${s.key} under [${s.section}]`), []);
});

test('the switches the code reads are all set, each once', () => {
  const vars = settings().filter((s) => s.section === 'vars').map((s) => s.key);
  for (const key of ['FAMILY_VIEW', 'MEMBER_NOTES', 'LEADERBOARD', 'KIDS_STRIPES', 'ROLLUP_BATCH', 'PROGRESS_PAGE', 'LESSON_NOTES', 'TAB_ITEMS', 'STRIPE_PROGRAMS', 'BELTS_KIDS', 'BELTS_ADULT']) {
    assert.equal(vars.filter((k) => k === key).length, 1, key);
  }
});

test('the rate-limit tables carry only what Cloudflare expects', () => {
  const allowed = new Set(['name', 'namespace_id', 'simple']);
  const extra = settings().filter((s) => s.section === 'ratelimits' && !allowed.has(s.key));
  assert.deepEqual(extra.map((s) => s.key), []);
});
