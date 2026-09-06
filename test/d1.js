// In-memory D1 stand-in backed by node:sqlite, loaded with the real schema.
// Mirrors the D1 surface the Worker uses: prepare().bind().first()/all()/run()
// and batch(). Tests run against real SQL, so constraints and ON CONFLICT
// behave exactly as they will in production.

import { DatabaseSync } from 'node:sqlite';
import { readRepoFile } from './helpers.js';

const SCHEMA = readRepoFile('src/db/schema.sql');

export function memoryD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  const isSelect = (sql) => /^\s*(select|with|pragma)\b/i.test(sql);

  function stmt(sql, binds = []) {
    return {
      sql,
      binds,
      bind: (...b) => stmt(sql, b),
      first: async (col) => {
        const row = db.prepare(sql).get(...binds) ?? null;
        return col && row ? row[col] : row;
      },
      all: async () => ({ success: true, results: db.prepare(sql).all(...binds) }),
      run: async () => {
        if (isSelect(sql)) {
          return { success: true, results: db.prepare(sql).all(...binds), meta: {} };
        }
        const info = db.prepare(sql).run(...binds);
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
    };
  }

  return {
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
    // Test-only escape hatch for direct assertions.
    raw: db,
  };
}
