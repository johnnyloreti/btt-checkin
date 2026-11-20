// schema-caps.js — what the live database actually has.
//
// The waiver column (§15.1) arrives via a migration Johnny runs by hand. On
// 2026-09-17 the waiver code was deployed before that migration ran, so every
// check-in threw "no such column: waiver" and returned 500. The kiosk, which
// by design never shows a student an error, queued them silently and showed
// the checkmark anyway. Nothing surfaced the fault.
//
// So no optional column may ever be named unconditionally in a query on the
// check-in path. Ask here first; a missing column degrades the feature
// instead of breaking attendance.

//
// "It is there" is remembered for the life of the isolate: a migration does
// not un-run. "It is not there" is remembered for RECHECK_MS only. It used to
// be remembered for good, so when a deploy went out ahead of its migration,
// an isolate that had already looked kept the feature hidden, and /health
// kept naming the file, after Johnny had run it, until Cloudflare happened
// to recycle the isolate. Now the next look after a minute finds it.

export const RECHECK_MS = 60_000;

/** One remembered answer: yes for good, no for a minute. */
function remembered(probe) {
  let value = null;
  let at = 0;
  return {
    async get(env) {
      if (value === true) return true;
      if (value === false && Date.now() - at < RECHECK_MS) return false;
      try {
        value = Boolean(await probe(env));
      } catch {
        value = false; // can't tell: assume not there, which is the safe side
      }
      at = Date.now();
      return value;
    },
    reset() {
      value = null;
      at = 0;
    },
    /** Test hook: make a remembered "no" old enough to be asked again. */
    age(ms) {
      at -= ms;
    },
  };
}

/** The seven tables migration 004 creates (§15.3). All or nothing. */
export const TAB_TABLES = ['purchase_pins', 'pin_setup_tokens', 'pin_failures', 'purchases', 'closeouts', 'closeout_payers', 'tab_flags'];

/** The three columns migration 006 adds to promotions (§15.4). All or nothing. */
export const BELT_COLUMNS = ['belt', 'stripes', 'starting'];

/** The two tables migration 007 creates (§15.8). All or nothing. */
export const LESSON_TABLES = ['lesson_plans', 'class_notes'];

/** The table migration 008 creates (§15.11). */
export const MEMBER_NOTES_TABLES = ['member_notes'];

// Table and column names here are this file's own constants, never request
// input, so they are written into the SQL as they are.
async function tablesPresent(env, names) {
  const list = names.map((n) => `'${n}'`).join(', ');
  const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${list})`).all();
  return results.length === names.length;
}

async function columnsPresent(env, table, names) {
  const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all();
  const have = new Set(results.map((r) => r.name));
  return names.every((c) => have.has(c));
}

const caps = {
  waiver: remembered((env) => columnsPresent(env, 'members', ['waiver'])),
  promotions: remembered((env) => tablesPresent(env, ['promotions'])),
  tab: remembered((env) => tablesPresent(env, TAB_TABLES)),
  payer: remembered((env) => columnsPresent(env, 'members', ['payer_contact_id'])),
  belt: remembered((env) => columnsPresent(env, 'promotions', BELT_COLUMNS)),
  lessons: remembered((env) => tablesPresent(env, LESSON_TABLES)),
  memberNotes: remembered((env) => tablesPresent(env, MEMBER_NOTES_TABLES)),
  board: remembered((env) => columnsPresent(env, 'members', ['board_hidden'])),
};

/** True when members.waiver exists (migration 002). */
export const hasWaiverColumn = (env) => caps.waiver.get(env);

/** True when the promotions table exists (migration 003, §15.2). */
export const hasPromotionsTable = (env) => caps.promotions.get(env);

/** True when every drink-tab table exists (migration 004, §15.3). */
export const hasTabTables = (env) => caps.tab.get(env);

/** True when members.payer_contact_id exists (migration 005). */
export const hasPayerColumn = (env) => caps.payer.get(env);

/** True when promotions has the belt columns (migration 006, §15.4). */
export const hasBeltColumns = (env) => caps.belt.get(env);

/** True when both lesson tables exist (migration 007, §15.8). */
export const hasLessonTables = (env) => caps.lessons.get(env);

/** True when the member_notes table exists (migration 008, §15.11). */
export const hasMemberNotesTable = (env) => caps.memberNotes.get(env);

/** True when members.board_hidden exists (migration 009, §15.13). */
export const hasBoardColumn = (env) => caps.board.get(env);

/** Test hook: forget every answer. */
export function resetSchemaCaps() {
  for (const c of Object.values(caps)) c.reset();
}

/** Test hook: let every remembered "no" go stale, as if RECHECK_MS had passed. */
export function ageSchemaCaps(ms = RECHECK_MS + 1) {
  for (const c of Object.values(caps)) c.age(ms);
}
