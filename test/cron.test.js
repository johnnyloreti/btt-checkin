import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobForCron } from '../src/cron.js';
import { localParts } from '../src/time.js';

const TZ = 'America/New_York';

test('roster cron always maps to roster', () => {
  assert.equal(jobForCron('*/30 * * * *', new Date('2026-09-06T12:00:00Z'), TZ), 'roster');
});

test('rollup runs at 07:00 UTC during EDT and skips 08:00 UTC', () => {
  // July: EDT (UTC-4), so 07:00 UTC is 03:00 ET.
  assert.equal(jobForCron('0 7 * * *', new Date('2026-07-15T07:00:00Z'), TZ), 'rollup');
  assert.equal(jobForCron('0 8 * * *', new Date('2026-07-15T08:00:00Z'), TZ), null);
});

test('rollup runs at 08:00 UTC during EST and skips 07:00 UTC', () => {
  // January: EST (UTC-5), so 08:00 UTC is 03:00 ET.
  assert.equal(jobForCron('0 8 * * *', new Date('2026-01-15T08:00:00Z'), TZ), 'rollup');
  assert.equal(jobForCron('0 7 * * *', new Date('2026-01-15T07:00:00Z'), TZ), null);
});

test('unknown cron maps to nothing', () => {
  assert.equal(jobForCron('0 0 * * *', new Date(), TZ), null);
});

test('localParts gives ET wall clock across DST', () => {
  const summer = localParts(new Date('2026-09-05T20:30:00Z'), TZ);
  assert.equal(summer.date, '2026-09-05');
  assert.equal(summer.time, '16:30');
  assert.equal(summer.weekday, 'Sat');

  const winter = localParts(new Date('2026-01-15T21:30:00Z'), TZ);
  assert.equal(winter.date, '2026-01-15');
  assert.equal(winter.time, '16:30');
  assert.equal(winter.weekday, 'Thu');

  // Midnight ET must come back as hour 0, not 24.
  const midnight = localParts(new Date('2026-09-07T04:00:00Z'), TZ);
  assert.equal(midnight.time, '00:00');
  assert.equal(midnight.date, '2026-09-07');
});
