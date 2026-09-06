// app.js — HTTP router. Pure: takes the validated schedule and a deps
// object so tests can pass their own without touching the JSON import.

import { syncRoster } from './roster.js';
import { fetchAllContacts } from './ghl.js';
import { isStaff } from './staff-auth.js';
import { buildIdMap, opaqueId, requireSalt } from './ids.js';
import { matchClasses } from './classes.js';
import { allowRequest } from './ratelimit.js';
import { recordCheckin } from './checkin.js';
import { localParts } from './time.js';
import { normalize } from '../public/search.js';

/** Static files the Worker will hand to the assets binding. Everything else is 404. */
const PUBLIC_ASSETS = new Set(['/', '/index.html', '/search.js', '/logo.png', '/favicon.ico']);
const LAST_KEY_CHARS = 4;

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

/**
 * Public roster: opaque id, first name, last initial, program label(s),
 * program keys, and lastKey: the first few normalized letters of the last
 * name so the kiosk can match a last-name prefix without shipping full
 * last names. Nothing else (§2, §7).
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
      lastInitial: row.last_name ? row.last_name[0].toUpperCase() : '',
      lastKey: normalize(row.last_name).slice(0, LAST_KEY_CHARS),
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

/** Default job runners. Tests inject fixtures through deps. */
export function defaultDeps() {
  return {
    runRosterSync: (env, schedule, now) =>
      syncRoster(env, schedule, { fetchContacts: () => fetchAllContacts(env), now }),
    now: () => new Date(),
  };
}

export function createApp(schedule, deps = defaultDeps()) {
  const tz = schedule.timezone;
  const now = () => (deps.now ? deps.now() : new Date());

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method;

      try {
        if (method === 'GET' && PUBLIC_ASSETS.has(path)) {
          if (!env.ASSETS) return json({ error: 'not found' }, 404);
          return env.ASSETS.fetch(request);
        }

        if (method === 'GET' && path === '/health') {
          const body = await health(env, schedule);
          return json(body, body.ok ? 200 : 503);
        }

        // ---- public, rate-limited ----
        if (path === '/api/roster' || path === '/api/current-class' || path === '/api/checkin') {
          if (!(await allowRequest(env, request))) return json({ error: 'slow down' }, 429, { 'retry-after': '60' });
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
          const member = await resolveMember(env, body.contactId);
          if (!member) return json({ error: 'unknown member' }, 404);
          const at = now();
          const result = await recordCheckin(env, schedule, {
            contactId: member.ghl_contact_id,
            className: body.className,
            classStartLocal: body.classStartLocal,
            clientTs: body.clientTs,
            method: 'kiosk',
            memberActive: Number(member.active) === 1,
            now: at,
            todayLocal: localParts(at, env.TZ || tz).date,
          });
          return json(result.body, result.status);
        }

        // ---- staff ----
        if (method === 'POST' && path === '/api/staff/sync') {
          if (!isStaff(request, env)) return json({ error: 'unauthorized' }, 401);
          const result = await deps.runRosterSync(env, schedule, now());
          return json(result, result.outcome === 'failed' ? 502 : 200);
        }

        return json({ error: 'not found' }, 404);
      } catch (e) {
        console.error(`${method} ${path} failed:`, e && e.stack ? e.stack : e);
        return json({ error: 'server error' }, 500);
      }
    },
  };
}
