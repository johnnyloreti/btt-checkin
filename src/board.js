// board.js — the monthly podium on the member progress page (§15.13).
//
// Who has trained the most this month: the top three, kids and adults on
// separate boards, shown under a member's own numbers on /me. It resets on
// the 1st, so a newer member is always in the race.
//
// It is the one place a member sees anything about another member, so it
// shows as little as it can: a first name and a last initial, and a class
// count. Never a contact id, a full last name, or which classes.
//
// A family that would rather not be on it is kept off with a tag in GHL
// (LEADERBOARD_HIDE_TAG) on the member's contact or on their linked
// parent's. The roster sync turns that into members.board_hidden, which
// arrives with migration 009; until that has run the podium is hidden, since
// without the column nobody could be kept off it.

import { hasBoardColumn } from './schema-caps.js';
import { localParts } from './time.js';

export const DEFAULT_BOARD_SIZE = 3;
export const MAX_BOARD_SIZE = 10;
export const DEFAULT_HIDE_TAG = 'leaderboard-hide';
export const BOARD_MIGRATION = 'src/db/migrations/009_leaderboard.sql';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const GROUPS = [
  { key: 'kids', title: 'Kids' },
  { key: 'adults', title: 'Adults' },
];

/** LEADERBOARD = "off" (or "0") turns the podium off. Anything else is on. */
export function boardEnabled(env = {}) {
  const v = String(env.LEADERBOARD ?? 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** How many places: LEADERBOARD_SIZE, three unless set. */
export function boardSize(env = {}) {
  const n = Number.parseInt(String(env.LEADERBOARD_SIZE ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BOARD_SIZE;
  return Math.min(n, MAX_BOARD_SIZE);
}

/** The GHL tag that keeps a member off the podium, lowercased. Blank: nobody is kept off by tag. */
export function boardHideTag(env = {}) {
  const raw = env.LEADERBOARD_HIDE_TAG;
  return String(raw === undefined || raw === null ? DEFAULT_HIDE_TAG : raw).trim().toLowerCase();
}

/** On, and migration 009 has run. */
export async function boardReady(env) {
  return boardEnabled(env) && (await hasBoardColumn(env));
}

/** Kids are members in any kids program; everyone else is on the adult board. */
export function boardGroup(programs) {
  return (Array.isArray(programs) ? programs : []).some((p) => String(p).toLowerCase().startsWith('kids-')) ? 'kids' : 'adults';
}

/** "Jack S.": a first name and a last initial, and nothing more. */
export function boardName(first, last) {
  const f = String(first || '').trim();
  const initial = String(last || '').trim().charAt(0).toUpperCase();
  return initial ? `${f} ${initial}.` : f;
}

/** The month holding `date` ("YYYY-MM-DD"), and the one before it. */
export function monthOf(date, back = 0) {
  let y = Number(date.slice(0, 4));
  let m = Number(date.slice(5, 7)) - back;
  while (m < 1) { m += 12; y -= 1; }
  const pad = (n) => String(n).padStart(2, '0');
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  return { key: `${y}-${pad(m)}`, name: MONTHS[m - 1], from: `${y}-${pad(m)}-01T00:00`, to: `${next}-01T00:00` };
}

function parsePrograms(raw) {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

// Everyone with a class in the month, most classes first. A tie goes to
// whoever got there first (the earlier latest class), then by name, so the
// order never shuffles between two looks at the page.
async function standings(env, month) {
  const { results } = await env.DB.prepare(
    `SELECT m.ghl_contact_id, m.first_name, m.last_name, m.programs,
            COUNT(a.id) AS classes, MAX(a.class_start_local) AS latest
       FROM members m
       JOIN attendance a
         ON a.ghl_contact_id = m.ghl_contact_id AND a.status = 'attended'
        AND a.class_start_local >= ? AND a.class_start_local < ?
      WHERE m.active = 1 AND m.board_hidden = 0
      GROUP BY m.ghl_contact_id`,
  ).bind(month.from, month.to).all();
  const rows = results.map((r) => ({ ...r, classes: Number(r.classes) || 0, group: boardGroup(parsePrograms(r.programs)) }));
  rows.sort((a, b) => b.classes - a.classes
    || String(a.latest).localeCompare(String(b.latest))
    || String(a.first_name).localeCompare(String(b.first_name))
    || String(a.last_name).localeCompare(String(b.last_name)));
  return rows;
}

/**
 * The podiums for a progress page: one board for each group that has
 * someone on the page (a parent's page with kids on it gets the kids board).
 *
 * people: the members on the page, [{ ghl_contact_id, programs: [key] }]
 * Returns [{ group, title, month, monthName, final, podium: [{ place, name, classes, you }] }].
 * `final` is true when the board shown is last month's, because nobody in
 * that group has trained yet this month. `you` marks someone on this page.
 * An empty list when the podium is off, migration 009 is pending, or there
 * is nothing to show.
 */
export async function podiums(env, schedule, people, now = new Date()) {
  if (!(await boardReady(env))) return [];
  const wanted = GROUPS.filter((g) => people.some((p) => boardGroup(p.programs) === g.key));
  if (wanted.length === 0) return [];
  const size = boardSize(env);
  const today = localParts(now, env.TZ || schedule.timezone).date;
  const mine = new Set(people.map((p) => p.ghl_contact_id));
  const thisMonth = monthOf(today);
  const current = await standings(env, thisMonth);
  let previous = null;
  const out = [];
  for (const g of wanted) {
    let month = thisMonth;
    let rows = current.filter((r) => r.group === g.key);
    let final = false;
    if (rows.length === 0) {
      // Nobody in this group yet this month: last month's podium stands
      // until the first class of the new one.
      month = monthOf(today, 1);
      if (!previous) previous = await standings(env, month);
      rows = previous.filter((r) => r.group === g.key);
      final = true;
    }
    if (rows.length === 0) continue;
    out.push({
      group: g.key,
      title: g.title,
      month: month.key,
      monthName: month.name,
      final,
      podium: rows.slice(0, size).map((r, i) => ({
        place: i + 1,
        name: boardName(r.first_name, r.last_name),
        classes: r.classes,
        you: mine.has(r.ghl_contact_id),
      })),
    });
  }
  return out;
}
