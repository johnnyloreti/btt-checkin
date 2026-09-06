// cron.js — map a cron firing to a job. Cron runs in UTC; the rollup is
// registered at two UTC hours so one of them is 03:00 ET whatever DST is
// doing, and the other is skipped.

import { localParts } from './time.js';

export const ROSTER_CRON = '*/30 * * * *';
export const ROLLUP_CRONS = ['0 7 * * *', '0 8 * * *'];
export const ROLLUP_HOUR_LOCAL = 3;

/** Returns 'roster' | 'rollup' | null. */
export function jobForCron(cron, now, tz) {
  if (cron === ROSTER_CRON) return 'roster';
  if (ROLLUP_CRONS.includes(cron)) {
    return localParts(now, tz).hour === ROLLUP_HOUR_LOCAL ? 'rollup' : null;
  }
  return null;
}
