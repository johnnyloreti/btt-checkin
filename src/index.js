// index.js — Worker entry. Validates schedule.json at module load so a bad
// schedule fails the deploy, not a check-in.

import scheduleJson from '../schedule.json';
import { validateSchedule } from './schedule.js';
import { createApp, defaultDeps } from './app.js';
import { jobsForCron } from './cron.js';

const schedule = validateSchedule(scheduleJson);
const deps = defaultDeps();
const app = createApp(schedule, deps);

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    for (const job of jobsForCron(event.cron, now, env.TZ || schedule.timezone)) {
      if (job === 'roster') {
        const result = await deps.runRosterSync(env, schedule, now);
        console.log(`roster sync: ${result.outcome}`, JSON.stringify(result));
      } else if (job === 'rollup') {
        const result = await deps.runRollup(env, schedule, now);
        console.log(`rollup push: ${result.outcome}`, JSON.stringify(result));
      }
    }
  },
};
