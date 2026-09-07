// app.js — HTTP router. Pure: takes the validated schedule and a deps
// object so tests can pass their own without touching the JSON import.

import { syncRoster } from './roster.js';
import { fetchAllContacts, fetchCustomFieldIds, ghlPutContactCustomFields } from './ghl.js';
import { runRollup } from './rollup.js';
import { isStaff, pinMatches, issueToken, cookieHeader, SESSION_MS } from './staff-auth.js';
import { buildIdMap, opaqueId, requireSalt } from './ids.js';
import { matchClasses } from './classes.js';
import { allowRequest, PUBLIC, LOGIN } from './ratelimit.js';
import { recordCheckin } from './checkin.js';
import { today, classRoster, voidAttendance, memberHistory } from './staff.js';
import { localParts } from './time.js';

/** Static files the Worker will hand to the assets binding. Everything else is 404. */
const PUBLIC_ASSETS = new Set(['/', '/index.html', '/search.js', '/logo.png', '/favicon.ico']);

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
    lastRollup: null,
    lastRollupOutcome: null,
    pendingRollups: null,
    schedulePresent: Boolean(schedule && Array.isArray(schedule.classes) && schedule.classes.length > 0),
  };
  try {
    const [count, last, rollup, pending] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE active = 1').first(),
      env.DB.prepare(
        "SELECT ran_at, outcome FROM sync_log WHERE job = 'roster' ORDER BY ran_at DESC, id DESC LIMIT 1",
      ).first(),
      env.DB.prepare(
        "SELECT ran_at, outcome FROM sync_log WHERE job = 'rollup' ORDER BY ran_at DESC, id DESC LIMIT 1",
      ).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM pending_rollups').first(),
    ]);
    out.memberCount = count ? Number(count.n) : 0;
    if (last) {
      out.lastRosterSync = last.ran_at;
      out.lastRosterOutcome = last.outcome;
    }
    if (rollup) {
      out.lastRollup = rollup.ran_at;
      out.lastRollupOutcome = rollup.outcome;
    }
    out.pendingRollups = pending ? Number(pending.n) : 0;
  } catch (e) {
    out.ok = false;
    out.error = `d1: ${e && e.message ? e.message : String(e)}`;
  }
  if (!out.schedulePresent) out.ok = false;
  return out;
}

/**
 * Public roster: opaque id, first name, last name, program label(s),
 * program keys. Nothing else. Johnny chose full last names on the tiles
 * on 2026-09-06, so the roster carries them; it still never carries
 * contact ids, status, or contact details.
 */
export async function publicRoster(env, schedule) {
  const salt = requireSalt(env);
  const { results } = await env.DB.prepare(
    'SELECT ghl_contact_id, first_name, last_name, programs FROM members ORDER BY first_name, last_name',
  ).all();
  const out = [];
  for (const row of results) {
    let programs = [];
    try {
      programs = JSON.parse(row.programs);
    } catch {
      programs = [];
    }
    programs = programs.filter((p) => schedule.programs[p]);
    out.push({
      id: await opaqueId(row.ghl_contact_id, salt),
      first: row.first_name,
      last: row.last_name || '',
      program: programs.map((p) => schedule.programs[p].label).join(' / '),
      programs,
    });
  }
  return out;
}

/** Resolve an opaque id back to a member row, or null. */
export async function resolveMember(env, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{20}$/.test(id)) return null;
  const salt = requireSalt(env);
  const { results } = await env.DB.prepare('SELECT ghl_contact_id, first_name, active FROM members').all();
  const map = await buildIdMap(results, salt);
  return map.get(id) || null;
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function asset(env, request, path) {
  if (!env.ASSETS) return json({ error: 'not found' }, 404);
  const url = new URL(request.url);
  url.pathname = path;
  return env.ASSETS.fetch(new Request(url.toString(), { method: 'GET', headers: request.headers }));
}

/** Default job runners. Tests inject fixtures through deps. */
export function defaultDeps() {
  return {
    runRosterSync: (env, schedule, now) =>
      syncRoster(env, schedule, { fetchContacts: () => fetchAllContacts(env), now }),
    runRollup: (env, schedule, now) =>
      runRollup(env, schedule, {
        fetchFields: () => fetchCustomFieldIds(env),
        putContact: (id, fields) => ghlPutContactCustomFields(env, id, fields),
        now,
      }),
    now: () => new Date(),
  };
}

export function createApp(schedule, deps = defaultDeps()) {
  const tz = schedule.timezone;
  const now = () => (deps.now ? deps.now() : new Date());

  async function checkin(env, body, method) {
    const member = await resolveMember(env, body.contactId);
    if (!member) return json({ error: 'unknown member' }, 404);
    const at = now();
    const result = await recordCheckin(env, schedule, {
      contactId: member.ghl_contact_id,
      className: body.className,
      classStartLocal: body.classStartLocal,
      clientTs: body.clientTs,
      method,
      memberActive: Number(member.active) === 1,
      now: at,
      todayLocal: localParts(at, env.TZ || tz).date,
    });
    return json(result.body, result.status);
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method;

      try {
        if (method === 'GET' && PUBLIC_ASSETS.has(path)) {
          return asset(env, request, path === '/' ? '/index.html' : path);
        }

        if (method === 'GET' && path === '/health') {
          const body = await health(env, schedule);
          return json(body, body.ok ? 200 : 503);
        }

        // ---- staff page (PIN gate) ----
        if (method === 'GET' && path === '/staff') {
          const authed = await isStaff(request, env, now().getTime());
          return asset(env, request, authed ? '/staff.html' : '/staff-login.html');
        }

        if (method === 'POST' && path === '/api/staff/login') {
          if (!(await allowRequest(env, request, LOGIN))) return json({ error: 'too many attempts, wait a minute' }, 429, { 'retry-after': '60' });
          const body = await readJson(request);
          if (!body || !pinMatches(env, body.pin)) return json({ error: 'wrong PIN' }, 401);
          const token = await issueToken(env, now().getTime());
          return json({ ok: true }, 200, { 'set-cookie': cookieHeader(request, token, SESSION_MS / 1000) });
        }

        if (method === 'POST' && path === '/api/staff/logout') {
          return json({ ok: true }, 200, { 'set-cookie': cookieHeader(request, '', 0) });
        }

        // ---- public, rate-limited ----
        if (path === '/api/roster' || path === '/api/current-class' || path === '/api/checkin') {
          if (!(await allowRequest(env, request, PUBLIC))) return json({ error: 'slow down' }, 429, { 'retry-after': '60' });
        }

        if (method === 'GET' && path === '/api/roster') {
          return json(await publicRoster(env, schedule));
        }

        if (method === 'GET' && path === '/api/current-class') {
          // ?at=ISO is for testing on a quiet day; never used by the kiosk.
          const at = url.searchParams.get('at');
          const when = at ? new Date(at) : now();
          if (Number.isNaN(when.getTime())) return json({ error: 'bad at' }, 400);
          return json(matchClasses(schedule, when, env.TZ || tz));
        }

        if (method === 'POST' && path === '/api/checkin') {
          const body = await readJson(request);
          if (!body) return json({ error: 'expected JSON body' }, 400);
          return checkin(env, body, 'kiosk');
        }

        // ---- staff API (PIN) ----
        if (path.startsWith('/api/staff/')) {
          if (!(await isStaff(request, env, now().getTime()))) return json({ error: 'unauthorized' }, 401);

          if (method === 'POST' && path === '/api/staff/sync') {
            const result = await deps.runRosterSync(env, schedule, now());
            return json(result, result.outcome === 'failed' ? 502 : 200);
          }
          if (method === 'POST' && path === '/api/staff/rollup') {
            const result = await deps.runRollup(env, schedule, now());
            return json(result, result.outcome === 'failed' ? 502 : 200);
          }
          if (method === 'GET' && path === '/api/staff/today') {
            const date = url.searchParams.get('date') || localParts(now(), env.TZ || tz).date;
            return json(await today(env, schedule, date));
          }
          if (method === 'GET' && path === '/api/staff/class') {
            return json(await classRoster(env, schedule, url.searchParams.get('start'), url.searchParams.get('name')));
          }
          if (method === 'POST' && path === '/api/staff/add') {
            const body = await readJson(request);
            if (!body) return json({ error: 'expected JSON body' }, 400);
            return checkin(env, body, 'staff');
          }
          if (method === 'POST' && path === '/api/staff/void') {
            const body = await readJson(request);
            if (!body) return json({ error: 'expected JSON body' }, 400);
            return json(await voidAttendance(env, body.attendanceId));
          }
          if (method === 'GET' && path === '/api/staff/member') {
            const member = await resolveMember(env, url.searchParams.get('id'));
            if (!member) return json({ error: 'unknown member' }, 404);
            const history = await memberHistory(env, schedule, member.ghl_contact_id, now());
            return json(history);
          }
        }

        return json({ error: 'not found' }, 404);
      } catch (e) {
        if (e && e.status) return json({ error: e.message }, e.status);
        console.error(`${method} ${path} failed:`, e && e.stack ? e.stack : e);
        return json({ error: 'server error' }, 500);
      }
    },
  };
}
