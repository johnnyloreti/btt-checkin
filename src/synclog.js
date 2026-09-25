// synclog.js — one place to write a sync_log row. Jobs: roster, rollup,
// waiver (a nudge that did not land), pin_link (a setup link that did not
// land). Never throws; a log failure is warned, never surfaced to a member.

export async function logSyncRow(env, job, outcome, detail, now = new Date()) {
  try {
    await env.DB.prepare('INSERT INTO sync_log (job, ran_at, outcome, detail) VALUES (?, ?, ?, ?)')
      .bind(job, now.toISOString(), outcome, JSON.stringify(detail))
      .run();
  } catch (e) {
    console.warn(`could not write sync_log (${job}): ${e && e.message ? e.message : e}`);
  }
}
