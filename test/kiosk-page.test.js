// §9.9 and §0.9: the kiosk page never carries an email, a phone number, or
// the string "billing", and its copy has no exclamation points, no em
// dashes, and no emoji other than the checkmark.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './helpers.js';

const html = readRepoFile('public/index.html');
const stripped = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const visible = stripped.replace(/<[^>]+>/g, ' ');
const scripts = [...html.matchAll(/<script[\s\S]*?<\/script>/g)].map((m) => m[0]).join('\n');
const jsStrings = [...scripts.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);

test('no email, phone, or billing anywhere in the page', () => {
  assert.doesNotMatch(html, /[\w.+-]+@[\w-]+\.[\w.]+/, 'email');
  assert.doesNotMatch(html, /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/, 'phone');
  assert.doesNotMatch(html, /billing|balance|payment|membership status|inactive/i);
});

test('visible copy has no exclamation points or em dashes', () => {
  assert.doesNotMatch(visible, /!/);
  assert.doesNotMatch(visible, /—/);
  for (const s of jsStrings) {
    if (/^[\w./-]*$/.test(s) || s.startsWith('/') || s.includes('btt.')) continue; // urls, keys, selectors
    assert.doesNotMatch(s, /!/, `exclamation in copy: ${s}`);
    assert.doesNotMatch(s, /—/, `em dash in copy: ${s}`);
  }
});

test('the only emoji-like glyph is the checkmark', () => {
  const nonAscii = [...new Set((html.match(/[^\x00-\x7F]/g) || []))];
  assert.deepEqual(nonAscii, ['̀', 'ͯ'].filter(() => false).concat(nonAscii.filter((c) => c === '✓' || c === '̀' || c === 'ͯ')));
  assert.match(html, /&#10003;|✓/, 'checkmark present on the success screen');
});

test('brand tokens and fonts are the ones from the brief', () => {
  assert.match(html, /#09090a/i);
  assert.match(html, /#f4f1e9/i);
  assert.match(html, /#e7c24c/i);
  assert.match(html, /Oswald/);
  assert.match(html, /Inter/);
  assert.match(html, /Type your name/);
  assert.match(html, /No class right now/);
  assert.match(html, /Check in anyway/);
  assert.match(html, /You're checked in/);
});
