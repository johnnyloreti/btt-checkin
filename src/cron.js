// cron.js — map a cron firing to the jobs it should run.
// One trigger, every 30 minutes, drives both jobs: the roster sync runs on
// every tick, and the rollup runs on the tick that lands at 03:00 in the
// gym's timezone. One schedule keeps the Worker inside the Workers Free
// limit of 5 cron triggers per account, and DST needs no redeploy.

import { localParts } from './time.js';

export const TICK_CRON = '*/30 * * * *';
export const ROLLUP_HOUR_LOCAL = 3;
export const ROLLUP_MINUTE_LOCAL = 0;

/** Returns the jobs to run, in order: [] | ['roster'] | ['roster', 'rollup']. */
export function jobsForCron(cron, now, tz) {
  if (cron !== TICK_CRON) return [];
  const local = localParts(now, tz);
  const jobs = ['roster'];
  if (local.hour === ROLLUP_HOUR_LOCAL && local.minute === ROLLUP_MINUTE_LOCAL) jobs.push('rollup');
  return jobs;
}
