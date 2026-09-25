// index.js — Worker entry. Validates schedule.json and tab-items.json at
// module load so a bad file fails the deploy, not a check-in.

import scheduleJson from '../schedule.json';
import tabItemsJson from '../tab-items.json';
import { validateSchedule } from './schedule.js';
import { validateTabItems } from './tab.js';
import { createApp, defaultDeps } from './app.js';
import { jobsForCron } from './cron.js';

const schedule = validateSchedule(scheduleJson);
const tabItems = validateTabItems(tabItemsJson);
const deps = defaultDeps();
const app = createApp(schedule, deps, { tabItems });

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
