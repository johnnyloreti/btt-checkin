import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchedule, validateSchedule, ScheduleError, parseTime } from '../src/schedule.js';
import { readRepoFile } from './helpers.js';

const good = () => JSON.parse(readRepoFile('schedule.json'));

test('committed schedule.json is valid', () => {
  const s = loadSchedule(readRepoFile('schedule.json'));
  assert.equal(s.timezone, 'America/New_York');
  assert.deepEqual(Object.keys(s.programs), ['kids-3-5', 'kids-6-9', 'kids-10-14', 'adult']);
  assert.equal(s.classes.length, 9);
});

test('loadSchedule tolerates UTF-8 BOM and CRLF', () => {
  const text = '﻿' + readRepoFile('schedule.json').replace(/\n/g, '\r\n');
  const s = loadSchedule(text);
  assert.equal(s.classes.length, 9);
});

test('loadSchedule fails loudly on bad JSON', () => {
  assert.throws(() => loadSchedule('{ not json'), ScheduleError);
  assert.throws(() => loadSchedule('{ not json'), /invalid JSON/);
});

test('parseTime accepts HH:MM and rejects everything else', () => {
  assert.equal(parseTime('00:00'), 0);
  assert.equal(parseTime('16:30'), 990);
  assert.equal(parseTime('23:59'), 1439);
  for (const bad of ['24:00', '9:00', '16:60', '4:30 PM', '', '1630']) {
    assert.throws(() => parseTime(bad), ScheduleError, bad);
  }
});

test('rejects overlapping same-program classes on the same day', () => {
  const s = good();
  s.classes.push({ name: 'Kids 6-9 extra', program: 'kids-6-9', days: ['Tue'], start: '17:00', minutes: 30 });
  assert.throws(() => validateSchedule(s), /overlaps/);
});

test('back-to-back same-program classes do not overlap', () => {
  const s = good();
  // Kids 6-9 Tue runs 16:30-17:15. A second one starting exactly at 17:15 is fine.
  s.classes.push({ name: 'Kids 6-9 late', program: 'kids-6-9', days: ['Tue'], start: '17:15', minutes: 30 });
  assert.doesNotThrow(() => validateSchedule(s));
});

test('different programs may overlap in time', () => {
  const s = good();
  s.classes.push({ name: 'Adult early', program: 'adult', days: ['Tue'], start: '16:30', minutes: 45 });
  assert.doesNotThrow(() => validateSchedule(s));
});

test('same program on different days never conflicts', () => {
  const s = good();
  s.classes.push({ name: 'Kids 6-9 Mon', program: 'kids-6-9', days: ['Mon'], start: '16:30', minutes: 45 });
  assert.doesNotThrow(() => validateSchedule(s));
});

test('rejects a bad day', () => {
  const s = good();
  s.classes[0].days = ['Tue', 'Tues'];
  assert.throws(() => validateSchedule(s), /bad day "Tues"/);
});

test('rejects a repeated day', () => {
  const s = good();
  s.classes[0].days = ['Tue', 'Tue'];
  assert.throws(() => validateSchedule(s), /repeats a day/);
});

test('rejects a bad time', () => {
  const s = good();
  s.classes[0].start = '4:00 PM';
  assert.throws(() => validateSchedule(s), /bad start time/);
});

test('rejects an unknown program', () => {
  const s = good();
  s.classes[0].program = 'teens';
  assert.throws(() => validateSchedule(s), /unknown program "teens"/);
});

test('rejects bad minutes', () => {
  for (const minutes of [0, -5, 1.5, '45', undefined]) {
    const s = good();
    s.classes[0].minutes = minutes;
    assert.throws(() => validateSchedule(s), /positive integer minutes/, String(minutes));
  }
});

test('rejects a class that runs past midnight', () => {
  const s = good();
  s.classes[0].start = '23:45';
  s.classes[0].minutes = 30;
  assert.throws(() => validateSchedule(s), /past midnight/);
});

test('rejects missing timezone, programs, or classes', () => {
  assert.throws(() => validateSchedule({ ...good(), timezone: '' }), /timezone/);
  assert.throws(() => validateSchedule({ ...good(), programs: {} }), /programs is empty/);
  assert.throws(() => validateSchedule({ ...good(), classes: [] }), /classes must be a non-empty array/);
  assert.throws(() => validateSchedule({ ...good(), programs: { adult: { label: 'Adult' } } }), /needs a tag/);
});
