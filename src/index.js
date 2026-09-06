// index.js — Worker entry. Validates schedule.json at module load so a bad
// schedule fails the deploy, not a check-in.

import scheduleJson from '../schedule.json';
import { validateSchedule } from './schedule.js';
import { createApp, defaultDeps } from './app.js';
import { jobForCron } from './cron.js';

const schedule = validateSchedule(scheduleJson);
const deps = defaultDeps();
const app = createApp(schedule, deps);

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    const job = jobForCron(event.cron, now, env.TZ || schedule.timezone);
    if (job === 'roster') {
      const result = await deps.runRosterSync(env, schedule, now);
      console.log(`roster sync: ${result.outcome}`, JSON.stringify(result));
      return;
    }
    if (job === 'rollup') {
      // Rollup push lands in §10 step 6.
      console.log(`cron ${event.cron}: rollup not implemented yet`);
    }
  },
};
