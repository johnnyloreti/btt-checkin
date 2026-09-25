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

const UNKNOWN = null;
let waiverColumn = UNKNOWN;
let promotionsTable = UNKNOWN;
let tabTables = UNKNOWN;

/** The seven tables migration 004 creates (§15.3). All or nothing. */
export const TAB_TABLES = ['purchase_pins', 'pin_setup_tokens', 'pin_failures', 'purchases', 'closeouts', 'closeout_payers', 'tab_flags'];

/** True when members.waiver exists. Cached per isolate; one query at most. */
export async function hasWaiverColumn(env) {
  if (waiverColumn !== UNKNOWN) return waiverColumn;
  try {
    const { results } = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('members') WHERE name = 'waiver'",
    ).all();
    waiverColumn = results.length > 0;
  } catch {
    waiverColumn = false; // can't tell: assume not there, which is the safe side
  }
  return waiverColumn;
}

/** True when the promotions table exists (§15.2). Cached per isolate. */
export async function hasPromotionsTable(env) {
  if (promotionsTable !== UNKNOWN) return promotionsTable;
  try {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'promotions'",
    ).all();
    promotionsTable = results.length > 0;
  } catch {
    promotionsTable = false;
  }
  return promotionsTable;
}

/** True when every drink-tab table exists (§15.3). Cached per isolate. */
export async function hasTabTables(env) {
  if (tabTables !== UNKNOWN) return tabTables;
  try {
    const marks = TAB_TABLES.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${marks})`,
    ).bind(...TAB_TABLES).all();
    tabTables = results.length === TAB_TABLES.length;
  } catch {
    tabTables = false;
  }
  return tabTables;
}

/** Test hook, and a way to re-check after a migration without a redeploy. */
export function resetSchemaCaps() {
  waiverColumn = UNKNOWN;
  promotionsTable = UNKNOWN;
  tabTables = UNKNOWN;
}
