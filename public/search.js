// search.js — name search shared by the kiosk, the staff page, and tests.
// Plain ES module, no dependencies. Loaded by the pages with
// <script type="module"> and by node tests directly.

export const MIN_CHARS = 2;
export const MAX_RESULTS = 6;

/** Lowercase, strip diacritics, collapse whitespace. */
export function normalize(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match roster entries by first-name prefix, last-name prefix, or
 * "first last" prefix. Entries carry `first` and `lastKey` (the normalized
 * start of the last name; the roster never ships full last names).
 * Returns at most `max` entries, in roster order, or [] under `min` chars.
 */
export function search(roster, query, { min = MIN_CHARS, max = MAX_RESULTS } = {}) {
  const q = normalize(query);
  if (q.length < min) return [];
  const parts = q.split(' ');
  const out = [];
  for (const m of roster) {
    const first = normalize(m.first);
    const lastKey = normalize(m.lastKey || '');
    let hit = false;
    if (parts.length === 1) {
      hit = first.startsWith(q) || (lastKey.length > 0 && startsWithKey(lastKey, q));
    } else {
      // Whole phrase as a first-name prefix ("mary ann"), or split at any
      // word boundary into first-name prefix + last-name prefix.
      hit = first.startsWith(q);
      for (let k = 1; k < parts.length && !hit; k += 1) {
        const qFirst = parts.slice(0, k).join(' ');
        const qLast = parts.slice(k).join(' ');
        hit = first.startsWith(qFirst) && startsWithKey(lastKey, qLast);
      }
    }
    if (hit) {
      out.push(m);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** lastKey is a truncated prefix, so compare on the shorter of the two. */
function startsWithKey(lastKey, q) {
  if (q.length <= lastKey.length) return lastKey.startsWith(q);
  return q.startsWith(lastKey);
}

/** "16:30" → "4:30 PM". */
export function formatTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return String(hhmm);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}
