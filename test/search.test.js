import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search, normalize, formatTime, MIN_CHARS, MAX_RESULTS } from '../public/search.js';

const R = [
  { id: '1', first: 'Jack', lastInitial: 'S', lastKey: 'silv', program: 'Kids 6-9' },
  { id: '2', first: 'Jackson', lastInitial: 'P', lastKey: 'pere', program: 'Kids 10-14' },
  { id: '3', first: 'Emma', lastInitial: 'J', lastKey: 'jone', program: 'Kids 6-9' },
  { id: '4', first: 'María', lastInitial: 'N', lastKey: 'nune', program: 'Adult' },
  { id: '5', first: 'Mary Ann', lastInitial: 'S', lastKey: 'smit', program: 'Adult' },
  { id: '6', first: 'José', lastInitial: 'S', lastKey: 'silv', program: 'Adult' },
  { id: '7', first: 'Jo', lastInitial: 'L', lastKey: 'lee', program: 'Adult' },
  { id: '8', first: 'Jaden', lastInitial: 'A', lastKey: 'adam', program: 'Kids 3-5' },
  { id: '9', first: 'Jamie', lastInitial: 'B', lastKey: 'bake', program: 'Kids 3-5' },
];
const ids = (r) => r.map((m) => m.id);

test('normalize lowercases, strips diacritics and punctuation', () => {
  assert.equal(normalize('María Núñez'), 'maria nunez');
  assert.equal(normalize('  JOSÉ   da  Silva '), 'jose da silva');
  assert.equal(normalize("O'Brien-Smith"), "o'brien-smith");
  assert.equal(normalize(null), '');
});

test('nothing under 2 characters', () => {
  assert.equal(MIN_CHARS, 2);
  assert.deepEqual(search(R, ''), []);
  assert.deepEqual(search(R, 'j'), []);
  assert.deepEqual(search(R, ' j '), []);
  assert.equal(search(R, 'jo').length > 0, true);
});

test('first-name prefix, case-insensitive', () => {
  assert.deepEqual(ids(search(R, 'JAC')), ['1', '2']);
  assert.deepEqual(ids(search(R, 'emm')), ['3']);
});

test('last-name prefix via lastKey, including beyond the stored key', () => {
  assert.deepEqual(ids(search(R, 'sil')), ['1', '6']);
  assert.deepEqual(ids(search(R, 'silva')), ['1', '6'], 'query longer than the 4-char key still matches');
  assert.deepEqual(ids(search(R, 'smith')), ['5']);
  assert.deepEqual(ids(search(R, 'ad')), ['8']);
});

test('"first last" prefix', () => {
  assert.deepEqual(ids(search(R, 'jack s')), ['1']);
  assert.deepEqual(ids(search(R, 'jack p')), ['2']);
  assert.deepEqual(ids(search(R, 'jack sm')), []);
  assert.deepEqual(ids(search(R, 'mary ann')), ['5'], 'two-word first name');
  assert.deepEqual(ids(search(R, 'mary ann s')), ['5']);
});

test('diacritics in query or roster are ignored', () => {
  assert.deepEqual(ids(search(R, 'mar')), ['4', '5']);
  assert.deepEqual(ids(search(R, 'maría')), ['4']);
  assert.deepEqual(ids(search(R, 'nun')), ['4']);
  assert.deepEqual(ids(search(R, 'núñ')), ['4']);
  assert.deepEqual(ids(search(R, 'jose')), ['6']);
});

test('capped at 6 results, roster order', () => {
  assert.equal(MAX_RESULTS, 6);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: String(i), first: `Sam${i}`, lastKey: 'x' }));
  assert.deepEqual(ids(search(many, 'sam')), ['0', '1', '2', '3', '4', '5']);
});

test('formatTime renders 12-hour ET labels', () => {
  assert.equal(formatTime('16:30'), '4:30 PM');
  assert.equal(formatTime('10:30'), '10:30 AM');
  assert.equal(formatTime('12:00'), '12:00 PM');
  assert.equal(formatTime('00:05'), '12:05 AM');
  assert.equal(formatTime('nope'), 'nope');
});
