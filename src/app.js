// app.js — HTTP router. Pure: takes the validated schedule and a deps
// object so tests can pass their own without touching the JSON import.

import { syncRoster } from './roster.js';
import { fetchAllContacts } from './ghl.js';
import { isStaff } from './staff-auth.js';

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

/** Default job runners. Tests inject fixtures through deps. */
export function defaultDeps() {
  return {
    runRosterSync: (env, schedule, now) =>
      syncRoster(env, schedule, { fetchContacts: () => fetchAllContacts(env), now }),
  };
}

export function createApp(schedule, deps = defaultDeps()) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method;

      if (method === 'GET' && path === '/health') {
        const body = await health(env, schedule);
        return json(body, body.ok ? 200 : 503);
      }

      // Manual roster sync for §12 acceptance and for "why is X missing".
      if (method === 'POST' && path === '/api/staff/sync') {
        if (!isStaff(request, env)) return json({ error: 'unauthorized' }, 401);
        const result = await deps.runRosterSync(env, schedule, new Date());
        return json(result, result.outcome === 'failed' ? 502 : 200);
      }

      return json({ error: 'not found' }, 404);
    },
  };
}
