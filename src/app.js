// app.js — HTTP router. Pure: takes the validated schedule and a deps
// object so tests can pass their own without touching the JSON import.

import { syncRoster } from './roster.js';
import {
  fetchAllContacts, fetchCustomFieldIds, ghlPutContactCustomFields,
  ghlGetContact, ghlListTransactions, ghlGetTransaction, ghlFindSchedules, ghlGetSchedule, ghlCreateSchedule, ghlActivateSchedule, ghlListInvoices,
} from './ghl.js';
import { reviewPayers, payerCardStatus, startCloseout, runPayer, refreshPayer, markPaidAtPos, latestCloseout, closeoutPayers, tabTick } from './closeout.js';
import { runRollup } from './rollup.js';
import { notifyWaiverCheckin, waiverEnabled, logWaiverFailure } from './waiver.js';
import { hasWaiverColumn, hasPromotionsTable, hasTabTables } from './schema-caps.js';
import { tabConfig, canBuy } from './tab.js';
import { createSetupToken, readSetupToken, completeSetup, clearLockout, pinActivity, writePinLink, requirePepper } from './pin.js';
import { hasNoCardFlag, recordPurchase, purchasesBetween, voidPurchase, memberTab, clearNoCardFlag } from './purchases.js';
import { verifyPin, pinStatus } from './pin.js';
import { formatCents } from './tab.js';
import { logSyncRow } from './synclog.js';
import { getFieldIds } from './rollup.js';
import { stripeCandidates, recordPromotion, undoLastPromotion, promotionHistory, stripesEnabled } from './promotions.js';
import { isStaff, pinMatches, issueToken, cookieHeader, SESSION_MS } from './staff-auth.js';
import { buildIdMap, opaqueId, requireSalt } from './ids.js';
import { matchClasses, windowFromEnv } from './classes.js';
import { allowRequest, PUBLIC, LOGIN } from './ratelimit.js';
import { recordCheckin } from './checkin.js';
import { today, classRoster, voidAttendance, memberHistory } from './staff.js';
import { localParts, localDayBounds } from './time.js';

/** Static files the Worker will hand to the assets binding. Everything else is 404. */
const PUBLIC_ASSETS = new Set(['/', '/index.html', '/search.js', '/logo.png', '/waiver-qr.png', '/favicon.ico', '/pin', '/pin.html']);
const PUBLIC_API = new Set(['/api/roster', '/api/current-class', '/api/checkin', '/api/tab/pin-link', '/api/tab/pin-token', '/api/tab/pin-set', '/api/tab/purchase']);

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
export async function health(env, schedule, now = new Date(), opts = {}) {
  const out = {
    ok: true,
    lastRosterSync: null,
    lastRosterOutcome: null,
    memberCount: null,
    lastRollup: null,
    lastRollupOutcome: null,
    pendingRollups: null,
    lastTabRun: null,
    lastTabOutcome: null,
    missingFields: null,
    waiverFailures24h: null,
    waiverLastFailure: null,
    schemaCurrent: null,
    schedulePresent: Boolean(schedule && Array.isArray(schedule.classes) && schedule.classes.length > 0),
    tab: null,
  };
  try {
    const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const [count, last, rollup, pending, waiverFails, waiverLast, tabLast] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE active = 1').first(),
      env.DB.prepare(
        "SELECT ran_at, outcome, detail FROM sync_log WHERE job = 'roster' ORDER BY ran_at DESC, id DESC LIMIT 1",
      ).first(),
      env.DB.prepare(
        "SELECT ran_at, outcome FROM sync_log WHERE job = 'rollup' ORDER BY ran_at DESC, id DESC LIMIT 1",
      ).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM pending_rollups').first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM sync_log WHERE job = 'waiver' AND ran_at >= ?").bind(dayAgo).first(),
      env.DB.prepare("SELECT ran_at, detail FROM sync_log WHERE job = 'waiver' ORDER BY ran_at DESC, id DESC LIMIT 1").first(),
      env.DB.prepare("SELECT ran_at, outcome FROM sync_log WHERE job = 'tab' ORDER BY ran_at DESC, id DESC LIMIT 1").first(),
    ]);
    out.memberCount = count ? Number(count.n) : 0;
    if (last) {
      out.lastRosterSync = last.ran_at;
      out.lastRosterOutcome = last.outcome;
      // Custom fields the Worker writes that GHL does not have (fields.js).
      // null means the last sync did not check, which is not the same as none.
      try {
        const detail = last.detail ? JSON.parse(last.detail) : {};
        out.missingFields = Array.isArray(detail.missingFields) ? detail.missingFields : null;
      } catch {
        out.missingFields = null;
      }
      if (out.missingFields && out.missingFields.length) {
        out.ok = false;
        out.error = `GHL custom field(s) missing: ${out.missingFields.join(', ')}. Writes to them are being lost.`;
      }
    }
    if (tabLast) {
      out.lastTabRun = tabLast.ran_at;
      out.lastTabOutcome = tabLast.outcome;
    }
    out.waiverFailures24h = waiverFails ? Number(waiverFails.n) : 0;
    if (waiverLast && waiverLast.ran_at >= dayAgo) {
      try {
        const d = JSON.parse(waiverLast.detail || '{}');
        out.waiverLastFailure = `${waiverLast.ran_at} ${d.reason || ''}`.trim();
      } catch {
        out.waiverLastFailure = waiverLast.ran_at;
      }
    }
    if (rollup) {
      out.lastRollup = rollup.ran_at;
      out.lastRollupOutcome = rollup.outcome;
    }
    out.pendingRollups = pending ? Number(pending.n) : 0;
    // A migration Johnny has not run yet. Surfaced here so a half-applied
    // deploy is visible rather than silent (see schema-caps.js).
    const problems = [];
    if (!(await hasWaiverColumn(env))) problems.push('members.waiver missing: run src/db/migrations/002_waiver.sql');
    if (stripesEnabled(env) && !(await hasPromotionsTable(env))) problems.push('promotions table missing: run src/db/migrations/003_promotions.sql');
    // The tab (§15.3): off, on, or misconfigured, and whether its tables exist.
    const tab = tabConfig(env, opts.tabItems || {});
    const tabSchema = await hasTabTables(env);
    out.tab = { enabled: tab.enabled, schema: tabSchema, error: tab.error };
    if (tab.error) problems.push(tab.error);
    if (tab.enabled && !tabSchema) problems.push('drink tab tables missing: run src/db/migrations/004_tab.sql');
    if (tab.enabled && String(env.PIN_PEPPER || '').length < 16) problems.push('PIN_PEPPER secret not set: wrangler secret put PIN_PEPPER');
    out.schemaCurrent = problems.length === 0 || (problems.length === 1 && Boolean(tab.error));
    if (problems.length) {
      out.ok = false;
      out.error = [out.error, ...problems].filter(Boolean).join(' | ');
    }
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
  // waiver is optional: never name it unless the migration has run (see schema-caps.js).
  const cols = (await hasWaiverColumn(env)) ? 'ghl_contact_id, first_name, last_name, programs, active, waiver' : 'ghl_contact_id, first_name, last_name, programs, active';
  const { results } = await env.DB.prepare(`SELECT ${cols} FROM members`).all();
  const map = await buildIdMap(results, salt);
  return map.get(id) || null;
}

/** The cron's last tab run, for the staff page: { ranAt, outcome, started, advanced, refreshed, errors } or null. */
async function lastTabRun(env) {
  const row = await env.DB.prepare("SELECT ran_at, outcome, detail FROM sync_log WHERE job = 'tab' ORDER BY ran_at DESC, id DESC LIMIT 1").first();
  if (!row) return null;
  let d = {};
  try { d = row.detail ? JSON.parse(row.detail) : {}; } catch { d = {}; }
  return { ranAt: row.ran_at, outcome: row.outcome, started: d.started || 0, advanced: d.advanced || 0, refreshed: d.refreshed || 0, errors: d.errors || [] };
}

/** Program keys on a members row, or [] when the JSON is bad. */
export function memberPrograms(member) {
  try {
    const list = JSON.parse(member.programs || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
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

/** The GHL calls the close-out makes, as one object closeout.js can take. */
function ghlBundle() {
  return {
    getContact: ghlGetContact, listTransactions: ghlListTransactions, getTransaction: ghlGetTransaction,
    findSchedules: ghlFindSchedules, getSchedule: ghlGetSchedule, createSchedule: ghlCreateSchedule,
    activateSchedule: ghlActivateSchedule, listInvoices: ghlListInvoices,
  };
}

/** Default job runners. Tests inject fixtures through deps. */
export function defaultDeps() {
  return {
    runRosterSync: (env, schedule, now) =>
      syncRoster(env, schedule, { fetchContacts: () => fetchAllContacts(env), fetchFields: () => fetchCustomFieldIds(env), now }),
    runRollup: (env, schedule, now) =>
      runRollup(env, schedule, {
        fetchFields: () => fetchCustomFieldIds(env),
        putContact: (id, fields) => ghlPutContactCustomFields(env, id, fields),
        now,
      }),
    notifyWaiver: (env, contactId, now) =>
      notifyWaiverCheckin(
        env,
        { fetchFields: () => fetchCustomFieldIds(env), putContact: (id, fields) => ghlPutContactCustomFields(env, id, fields) },
        contactId,
        now,
      ),
    ghl: ghlBundle(),
    runTab: (env, cfg, now, opts) => tabTick(env, ghlBundle(), cfg, now, opts),
    pinLink: (env, contactId, link, now) =>
      writePinLink(
        env,
        { getFieldIds: (at) => getFieldIds(() => fetchCustomFieldIds(env), at), putContact: (id, fields) => ghlPutContactCustomFields(env, id, fields) },
        contactId,
        link,
        now,
      ),
    now: () => new Date(),
  };
}

export function createApp(schedule, deps = defaultDeps(), opts = {}) {
  const tz = schedule.timezone;
  const tabItems = opts.tabItems || {};

  // The tab (§15.3) exists only when it is switched on and its migration has
  // run. Everything else about it hangs off this returning a config.
  async function tabReady(env) {
    const cfg = tabConfig(env, tabItems);
    if (!cfg.enabled) return null;
    if (!(await hasTabTables(env))) return null;
    return cfg;
  }
  async function buyer(env, cfg, member) {
    return canBuy(memberPrograms(member), cfg, { noCard: await hasNoCardFlag(env, member.ghl_contact_id) });
  }
  function setupLink(cfg, url, token) {
    return `${cfg.publicOrigin || url.origin}/pin?t=${token}`;
  }
  const now = () => (deps.now ? deps.now() : new Date());

  async function checkin(env, body, method, ctx) {
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
    if (!result.ok) return json(result.body, result.status);

    // §15.1: waiver missing. Tell the kiosk, and nudge GHL after the response goes out.
    const waiverNeeded = waiverEnabled(env) && Number(member.waiver ?? 1) === 0;
    const body2 = { ...result.body, waiverNeeded };
    // §15.3: the drink row, only for a member who may buy, only on a check-in
    // that reached the server. A queued check-in never shows it.
    if (method === 'kiosk') {
      const cfg = await tabReady(env);
      if (cfg && (await buyer(env, cfg, member))) {
        const pin = await pinStatus(env, member.ghl_contact_id, at);
        body2.tab = {
          items: cfg.items.map((i) => ({ key: i.key, label: i.label, amountCents: i.amountCents, price: formatCents(i.amountCents) })),
          hasPin: pin.hasPin,
          locked: pin.locked,
        };
      }
    }
    if (waiverNeeded && !result.body.duplicate && deps.notifyWaiver) {
      const task = deps.notifyWaiver(env, member.ghl_contact_id, at).then(async (r) => {
        if (r.ok) return;
        // Recorded, not just warned: a nudge that did not land is a reminder
        // that will not go out, and console.warn hid exactly this for weeks.
        console.warn(`waiver nudge failed for ${member.ghl_contact_id}: ${r.reason}`);
        await logWaiverFailure(env, member.ghl_contact_id, r.reason, at);
      });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
      else await task;
    }
    return json(body2, result.status);
  }

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method;

      try {
        if (method === 'GET' && PUBLIC_ASSETS.has(path)) {
          return asset(env, request, path === '/' ? '/index.html' : path === '/pin' ? '/pin.html' : path);
        }

        if (method === 'GET' && path === '/health') {
          const body = await health(env, schedule, now(), { tabItems });
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
        if (PUBLIC_API.has(path)) {
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
          return json(matchClasses(schedule, when, env.TZ || tz, windowFromEnv(env)));
        }

        if (method === 'POST' && path === '/api/checkin') {
          const body = await readJson(request);
          if (!body) return json({ error: 'expected JSON body' }, 400);
          return checkin(env, body, 'kiosk', ctx);
        }

        // ---- drink tab, public (§15.3) ----
        if (path.startsWith('/api/tab/')) {
          const cfg = await tabReady(env);
          if (!cfg) return json({ error: 'not found' }, 404);
          const at = now();

          // "Text me a setup link": mint a token, write the link to GHL, and
          // let Johnny's workflow send the text. The write is awaited so the
          // kiosk can say honestly whether it went.
          if (method === 'POST' && path === '/api/tab/pin-link') {
            const body = await readJson(request);
            if (!body) return json({ error: 'expected JSON body' }, 400);
            const member = await resolveMember(env, body.contactId);
            if (!member) return json({ error: 'unknown member' }, 404);
            if (!(await buyer(env, cfg, member))) return json({ error: 'not eligible' }, 403);
            requirePepper(env);
            const t = await createSetupToken(env, member.ghl_contact_id, 'link', at);
            if (!t.ok) return json({ ok: true, sent: false, reason: t.reason, retryAt: t.retryAt });
            const link = setupLink(cfg, url, t.token);
            const r = deps.pinLink ? await deps.pinLink(env, member.ghl_contact_id, link, at) : { ok: false, reason: 'no link writer' };
            if (!r.ok) {
              await logSyncRow(env, 'pin_link', 'failed', { contactId: member.ghl_contact_id, reason: r.reason }, at);
              return json({ error: 'could not send the link' }, 502);
            }
            return json({ ok: true, sent: true });
          }

          // A drink on the tab. Online only: the kiosk never queues this.
          if (method === 'POST' && path === '/api/tab/purchase') {
            const body = await readJson(request);
            if (!body) return json({ error: 'expected JSON body' }, 400);
            const member = await resolveMember(env, body.contactId);
            if (!member) return json({ error: 'unknown member' }, 404);
            if (!(await buyer(env, cfg, member))) return json({ error: 'not eligible', reason: 'not_eligible' }, 403);
            if (!cfg.items.some((i) => i.key === String(body.item || '').toLowerCase())) return json({ error: 'unknown item', reason: 'unknown_item' }, 400);
            requirePepper(env);
            const v = await verifyPin(env, member.ghl_contact_id, body.pin, at);
            if (!v.ok) {
              const status = v.reason === 'locked' ? 423 : v.reason === 'no_pin' ? 409 : v.reason === 'bad_format' ? 400 : 401;
              return json({ ok: false, reason: v.reason, lockedUntil: v.lockedUntil || null }, status);
            }
            const r = await recordPurchase(env, cfg, { buyerId: member.ghl_contact_id, payerId: member.ghl_contact_id, itemKey: body.item, method: 'kiosk', now: at });
            if (!r.ok) return json({ ok: false, reason: r.reason }, 400);
            return json(r);
          }

          if (method === 'GET' && path === '/api/tab/pin-token') {
            const t = await readSetupToken(env, url.searchParams.get('t'), at);
            if (!t.ok) return json({ ok: false, reason: t.reason });
            const m = await env.DB.prepare('SELECT first_name FROM members WHERE ghl_contact_id = ?').bind(t.contactId).first();
            return json({ ok: true, first: m ? m.first_name : '' });
          }

          if (method === 'POST' && path === '/api/tab/pin-set') {
            const body = await readJson(request);
            if (!body) return json({ error: 'expected JSON body' }, 400);
            requirePepper(env);
            const r = await completeSetup(env, body.token, body.pin, at);
            if (!r.ok) return json({ ok: false, reason: r.reason }, 400);
            return json({ ok: true });
          }

          return json({ error: 'not found' }, 404);
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
            return checkin(env, body, 'staff', ctx);
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
            const cfg = await tabReady(env);
            const tab = cfg
              ? { enabled: true, ...(await memberTab(env, cfg, member.ghl_contact_id)), pin: await pinStatus(env, member.ghl_contact_id, now()), eligible: await buyer(env, cfg, member) }
              : { enabled: false };
            if (tab.enabled) {
              for (const r of [...tab.open, ...tab.recent]) { delete r.buyerId; delete r.payerId; r.price = formatCents(r.amountCents); }
            }
            return json({ ...history, promotions: await promotionHistory(env, member.ghl_contact_id), tab });
          }

          // ---- drink tab, staff (§15.3) ----
          if (path.startsWith('/api/staff/tab/')) {
            const cfg = await tabReady(env);
            const at = now();

            // The day's tab plus PIN activity. Answers even when the tab is
            // off, so the page can say why it is empty.
            if (method === 'GET' && path === '/api/staff/tab/today') {
              if (!cfg) {
                const plain = tabConfig(env, tabItems);
                return json({ enabled: false, pendingMigration: plain.enabled && !(await hasTabTables(env)), error: plain.error });
              }
              const salt = requireSalt(env);
              const day = url.searchParams.get('date') || localParts(at, env.TZ || tz).date;
              if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'date must be YYYY-MM-DD' }, 400);
              const { startIso, endIso } = localDayBounds(day, env.TZ || tz);
              const rows = [];
              for (const r of await purchasesBetween(env, cfg, startIso, endIso)) {
                const { buyerId, payerId, ...rest } = r;
                rows.push({ ...rest, id: await opaqueId(buyerId, salt), price: formatCents(r.amountCents) });
              }
              const a = await pinActivity(env, startIso, at);
              const locked = [];
              for (const l of a.locked) {
                const m = await env.DB.prepare('SELECT first_name, last_name FROM members WHERE ghl_contact_id = ?').bind(l.contactId).first();
                locked.push({ id: await opaqueId(l.contactId, salt), first: m ? m.first_name : '', last: m ? m.last_name : '', lockedUntil: l.lockedUntil });
              }
              const open = rows.filter((r) => r.status === 'open');
              return json({
                enabled: true, date: day, timezone: env.TZ || tz,
                purchases: rows, openCents: open.reduce((n, r) => n + r.amountCents, 0), openTotal: formatCents(open.reduce((n, r) => n + r.amountCents, 0)),
                activity: { failedToday: a.failed, locked },
                autoHour: cfg.autoHour,
                lastRun: await lastTabRun(env),
              });
            }
            if (!cfg) return json({ error: 'drink tab is off' }, 404);

            if (method === 'POST' && path === '/api/staff/tab/void') {
              const body = await readJson(request);
              if (!body) return json({ error: 'expected JSON body' }, 400);
              return json(await voidPurchase(env, body.purchaseId));
            }
            if (method === 'POST' && path === '/api/staff/tab/clear-no-card') {
              const body = await readJson(request);
              if (!body) return json({ error: 'expected JSON body' }, 400);
              const member = await resolveMember(env, body.contactId);
              if (!member) return json({ error: 'unknown member' }, 404);
              return json(await clearNoCardFlag(env, member.ghl_contact_id));
            }

            // Open the setup screen for a member at the desk. They type the
            // PIN themselves; staff never do.
            if (method === 'POST' && path === '/api/staff/tab/pin-setup') {
              const body = await readJson(request);
              if (!body) return json({ error: 'expected JSON body' }, 400);
              const member = await resolveMember(env, body.contactId);
              if (!member) return json({ error: 'unknown member' }, 404);
              requirePepper(env);
              const t = await createSetupToken(env, member.ghl_contact_id, 'staff', at);
              return json({ ok: true, url: setupLink(cfg, url, t.token), expiresAt: t.expiresAt });
            }
            if (method === 'POST' && path === '/api/staff/tab/clear-lockout') {
              const body = await readJson(request);
              if (!body) return json({ error: 'expected JSON body' }, 400);
              const member = await resolveMember(env, body.contactId);
              if (!member) return json({ error: 'unknown member' }, 404);
              return json(await clearLockout(env, member.ghl_contact_id));
            }
            // ---- close-out (§15.3 step 6) ----
            // One payer per request, driven from the browser. Rows leave here
            // with an opaque id and without the card ids kept for the resume.
            const salt = requireSalt(env);
            const safeRow = async (r) => {
              const d = r.detail || {};
              return {
                closeoutPayerId: r.closeoutPayerId, closeoutId: r.closeoutId, id: await opaqueId(r.payerId, salt),
                first: r.first, last: r.last, amountCents: r.amountCents, total: r.total, invoiceName: r.invoiceName,
                state: r.state, card: r.card, invoiceId: r.invoiceId, updatedAt: r.updatedAt,
                chargeDay: d.chargeDay || null, invoiceStatus: d.invoiceStatus || null, note: d.attention || d.note || d.error || null,
                missing: d.missing || null, pos: d.pos || null,
              };
            };
            const safeRows = async (rows) => { const out = []; for (const r of rows) out.push(await safeRow(r)); return out; };
            const ghl = deps.ghl;
            const closeoutRoute = path.startsWith('/api/staff/tab/closeout') || path === '/api/staff/tab/review' || path === '/api/staff/tab/card';
            if (closeoutRoute && !ghl) return json({ error: 'close-out is not wired' }, 500);

            if (method === 'GET' && path === '/api/staff/tab/review') {
              const payers = [];
              for (const p of await reviewPayers(env, cfg, at)) {
                const { payerId, ...rest } = p;
                payers.push({ ...rest, id: await opaqueId(payerId, salt) });
              }
              const latest = await latestCloseout(env);
              return json({
                payers, minCents: cfg.minCents, minTotal: formatCents(cfg.minCents), maxRollDays: cfg.maxRollDays, autoHour: cfg.autoHour,
                active: latest && !latest.done ? { closeoutId: latest.closeoutId, createdAt: latest.createdAt, payers: await safeRows(latest.payers) } : null,
              });
            }
            if (method === 'GET' && path === '/api/staff/tab/card') {
              const member = await resolveMember(env, url.searchParams.get('id'));
              if (!member) return json({ error: 'unknown member' }, 404);
              try {
                const r = await payerCardStatus(ghl, env, member.ghl_contact_id);
                return json({ ok: r.ok, reason: r.reason || null, missing: r.missing || null, card: r.card ? { brand: r.card.brand, last4: r.card.last4, source: r.card.source } : null });
              } catch (e) {
                return json({ ok: false, reason: 'error', error: e && e.message ? e.message : String(e) }, 502);
              }
            }
            if (method === 'POST' && path === '/api/staff/tab/closeout') {
              const body = await readJson(request);
              if (!body || !Array.isArray(body.payerIds)) return json({ error: 'expected { payerIds: [] }' }, 400);
              const ids = [];
              for (const oid of body.payerIds) { const m = await resolveMember(env, oid); if (m) ids.push(m.ghl_contact_id); }
              const r = await startCloseout(env, cfg, ids, at);
              if (!r.ok) return json({ ok: false, reason: r.reason }, 409);
              return json({ ok: true, closeoutId: r.closeoutId, payers: await safeRows(r.payers) });
            }
            if (method === 'GET' && path === '/api/staff/tab/closeout') {
              const idParam = url.searchParams.get('id');
              if (idParam) {
                const rows = await closeoutPayers(env, Number(idParam));
                return json({ closeoutId: Number(idParam), payers: await safeRows(rows) });
              }
              const latest = await latestCloseout(env);
              return json(latest ? { closeoutId: latest.closeoutId, createdAt: latest.createdAt, done: latest.done, payers: await safeRows(latest.payers) } : { closeoutId: null, payers: [] });
            }
            if (method === 'POST' && (path === '/api/staff/tab/closeout/run' || path === '/api/staff/tab/closeout/refresh' || path === '/api/staff/tab/closeout/pos')) {
              const body = await readJson(request);
              const cpId = Number(body && body.closeoutPayerId);
              if (!Number.isInteger(cpId) || cpId <= 0) return json({ error: 'closeoutPayerId required' }, 400);
              try {
                const r = path.endsWith('/run') ? await runPayer(env, ghl, cfg, cpId, at)
                  : path.endsWith('/refresh') ? await refreshPayer(env, ghl, cpId, at, env.TZ || tz)
                  : await markPaidAtPos(env, cpId, body.note, at);
                if (!r.row) return json({ ok: false, reason: r.reason || 'unknown' }, 404);
                return json({ ok: r.ok, reason: r.reason || null, row: await safeRow(r.row) });
              } catch (e) {
                // A GHL failure mid-step: the row already holds where it got to. Say so and let the page retry.
                const rows = await env.DB.prepare('SELECT closeout_id FROM closeout_payers WHERE id = ?').bind(cpId).first();
                const row = rows ? (await closeoutPayers(env, rows.closeout_id)).find((x) => x.closeoutPayerId === cpId) : null;
                return json({ ok: false, reason: 'error', error: e && e.message ? e.message : String(e), row: row ? await safeRow(row) : null }, 502);
              }
            }

            if (method === 'GET' && path === '/api/staff/tab/activity') {
              const salt = requireSalt(env);
              const day = localParts(at, env.TZ || tz).date;
              const a = await pinActivity(env, localDayBounds(day, env.TZ || tz).startIso, at);
              const locked = [];
              for (const l of a.locked) {
                const m = await env.DB.prepare('SELECT first_name, last_name FROM members WHERE ghl_contact_id = ?').bind(l.contactId).first();
                locked.push({ id: await opaqueId(l.contactId, salt), first: m ? m.first_name : '', last: m ? m.last_name : '', lockedUntil: l.lockedUntil });
              }
              return json({ date: day, failedToday: a.failed, locked });
            }
            return json({ error: 'not found' }, 404);
          }

          // ---- stripes (§15.2) ----
          if (method === 'GET' && path === '/api/staff/stripes') {
            const salt = requireSalt(env);
            const list = await stripeCandidates(env);
            const rows = [];
            for (const r of list.rows) {
              const { ghl_contact_id: contactId, ...rest } = r;
              rows.push({ id: await opaqueId(contactId, salt), ...rest });
            }
            return json({ ...list, rows });
          }
          if (method === 'POST' && (path === '/api/staff/promote' || path === '/api/staff/promote/undo')) {
            if (!stripesEnabled(env)) return json({ error: 'stripe tracking is off' }, 404);
            const body = await readJson(request);
            if (!body) return json({ error: 'expected JSON body' }, 400);
            const member = await resolveMember(env, body.contactId);
            if (!member) return json({ error: 'unknown member' }, 404);
            if (path === '/api/staff/promote/undo') {
              return json(await undoLastPromotion(env, member.ghl_contact_id));
            }
            return json(await recordPromotion(env, schedule, {
              contactId: member.ghl_contact_id,
              kind: body.kind,
              note: body.note,
              now: now(),
            }));
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
