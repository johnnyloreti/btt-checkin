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

/** Test hook, and a way to re-check after a migration without a redeploy. */
export function resetSchemaCaps() {
  waiverColumn = UNKNOWN;
}
