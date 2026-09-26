// cron.js — map a cron firing to the jobs it should run.
// One trigger, every 30 minutes, drives every job: the roster sync runs on
// every tick, the rollup on the tick that lands at 03:00 in the gym's
// timezone, and the drink tab (§15.3) on every tick too, doing real work
// only when there is something to continue or when the auto-close-out hour
// comes round. One schedule keeps the Worker inside the Workers Free limit
// of 5 cron triggers per account, and DST needs no redeploy.

import { localParts } from './time.js';

export const TICK_CRON = '*/30 * * * *';
export const ROLLUP_HOUR_LOCAL = 3;
export const ROLLUP_MINUTE_LOCAL = 0;

/**
 * Returns the jobs to run, in order. The tab job runs on every tick when the
 * tab is on (it is cheap when there is nothing to do); `tabStart` says
 * whether this is the tick that opens a new close-out for everyone due.
 */
export function jobsForCron(cron, now, tz, { tabOn = false, tabAutoHour = null } = {}) {
  if (cron !== TICK_CRON) return [];
  const local = localParts(now, tz);
  const jobs = ['roster'];
  if (local.hour === ROLLUP_HOUR_LOCAL && local.minute === ROLLUP_MINUTE_LOCAL) jobs.push('rollup');
  if (tabOn) jobs.push('tab');
  return jobs;
}

/** True on the one tick a day that opens the auto close-out. */
export function isTabStartTick(now, tz, tabAutoHour) {
  if (tabAutoHour === null || tabAutoHour === undefined) return false;
  const local = localParts(now, tz);
  return local.hour === tabAutoHour && local.minute === 0;
}
