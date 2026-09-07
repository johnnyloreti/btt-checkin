import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobsForCron } from '../src/cron.js';
import { localParts } from '../src/time.js';

const TZ = 'America/New_York';

test('every tick runs the roster sync', () => {
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-09-06T12:00:00Z'), TZ), ['roster']);
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-09-06T12:30:00Z'), TZ), ['roster']);
});

test('the 03:00 ET tick also runs the rollup, in EDT and EST', () => {
  // July: EDT (UTC-4), so 07:00 UTC is 03:00 ET.
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-07-15T07:00:00Z'), TZ), ['roster', 'rollup']);
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-07-15T07:30:00Z'), TZ), ['roster']);
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-07-15T08:00:00Z'), TZ), ['roster']);
  // January: EST (UTC-5), so 08:00 UTC is 03:00 ET.
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-01-15T08:00:00Z'), TZ), ['roster', 'rollup']);
  assert.deepEqual(jobsForCron('*/30 * * * *', new Date('2026-01-15T07:00:00Z'), TZ), ['roster']);
});

test('unknown cron maps to nothing', () => {
  assert.deepEqual(jobsForCron('0 0 * * *', new Date(), TZ), []);
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
