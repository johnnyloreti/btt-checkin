// Shared test helpers. Fixtures only, no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function readRepoFile(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * Minimal fake D1. `rows` maps a SQL fragment to the row(s) that statement
 * should return. Set `fail` to make every statement throw.
 */
export function fakeD1({ rows = {}, fail = null } = {}) {
  const calls = [];
  function stmt(sql, binds = []) {
    const lookup = () => {
      if (fail) throw new Error(fail);
      const key = Object.keys(rows).find((k) => sql.includes(k));
      return key ? rows[key] : null;
    };
    return {
      bind: (...b) => stmt(sql, b),
      first: async () => {
        calls.push({ sql, binds });
        const r = lookup();
        return Array.isArray(r) ? r[0] ?? null : r;
      },
      all: async () => {
        calls.push({ sql, binds });
        const r = lookup();
        return { results: Array.isArray(r) ? r : r ? [r] : [] };
      },
      run: async () => {
        calls.push({ sql, binds });
        lookup();
        return { success: true, meta: {} };
      },
    };
  }
  return { prepare: (sql) => stmt(sql), calls };
}
