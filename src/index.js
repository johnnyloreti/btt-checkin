// index.js — Worker entry. Validates schedule.json at module load so a bad
// schedule fails the deploy, not a check-in.

import scheduleJson from '../schedule.json';
import { validateSchedule } from './schedule.js';
import { createApp } from './app.js';
import { jobForCron } from './cron.js';

const schedule = validateSchedule(scheduleJson);
const app = createApp(schedule);

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    const job = jobForCron(event.cron, new Date(event.scheduledTime), env.TZ || schedule.timezone);
    if (!job) return;
    // Roster sync lands in §10 step 2, rollup push in step 6.
    console.log(`cron ${event.cron}: ${job} not implemented yet`);
  },
};
