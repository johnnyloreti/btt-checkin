// app.js — HTTP router. Pure: takes the validated schedule so tests can pass
// their own without touching the JSON import in index.js.

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Health snapshot. `ok` means every check ran and returned; it never means
 * "nothing came back" (§0.6). A D1 error makes ok=false with the message.
 */
export async function health(env, schedule) {
  const out = {
    ok: true,
    lastRosterSync: null,
    lastRosterOutcome: null,
    memberCount: null,
    schedulePresent: Boolean(schedule && Array.isArray(schedule.classes) && schedule.classes.length > 0),
  };
  try {
    const [count, last] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE active = 1').first(),
      env.DB.prepare(
        "SELECT ran_at, outcome FROM sync_log WHERE job = 'roster' ORDER BY ran_at DESC, id DESC LIMIT 1",
      ).first(),
    ]);
    out.memberCount = count ? Number(count.n) : 0;
    if (last) {
      out.lastRosterSync = last.ran_at;
      out.lastRosterOutcome = last.outcome;
    }
  } catch (e) {
    out.ok = false;
    out.error = `d1: ${e && e.message ? e.message : String(e)}`;
  }
  if (!out.schedulePresent) out.ok = false;
  return out;
}

export function createApp(schedule) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (request.method === 'GET' && path === '/health') {
        const body = await health(env, schedule);
        return json(body, body.ok ? 200 : 503);
      }

      return json({ error: 'not found' }, 404);
    },
  };
}
