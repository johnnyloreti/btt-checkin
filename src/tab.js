// tab.js — drink tab (§15.3): items, config, and who may buy.
// Pure functions. The PIN lives in pin.js, purchases in purchases.js, and
// the close-out in closeout.js (step 6, gated).

import { parseList } from './roster.js';

export class TabItemsError extends Error {
  constructor(message) {
    super(`tab-items.json: ${message}`);
    this.name = 'TabItemsError';
  }
}

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const GHL_ID_RE = /^[A-Za-z0-9]{6,64}$/;

/**
 * Parse tab-items.json text. Tolerates a UTF-8 BOM and CRLF, since the file
 * is edited on Windows. Then validates.
 */
export function loadTabItems(text) {
  if (typeof text !== 'string') throw new TabItemsError('expected text');
  let obj;
  try {
    obj = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new TabItemsError(`invalid JSON (${e.message})`);
  }
  return validateTabItems(obj);
}

/**
 * Validate a parsed items map: key → { label, product_id, price_id, amount_cents }.
 * Every id must look like a GHL id, every amount a positive whole number of
 * cents. Returns the same object. Throws TabItemsError on the first problem.
 */
export function validateTabItems(items) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) throw new TabItemsError('expected an object of items');
  for (const [key, it] of Object.entries(items)) {
    if (!KEY_RE.test(key)) throw new TabItemsError(`bad item key "${key}" (lowercase letters, digits, hyphens)`);
    if (!it || typeof it !== 'object') throw new TabItemsError(`item "${key}" must be an object`);
    if (typeof it.label !== 'string' || !it.label.trim()) throw new TabItemsError(`item "${key}" needs a label`);
    for (const f of ['product_id', 'price_id']) {
      if (typeof it[f] !== 'string' || !GHL_ID_RE.test(it[f])) throw new TabItemsError(`item "${key}" ${f} does not look like a GHL id`);
    }
    if (!Number.isInteger(it.amount_cents) || it.amount_cents <= 0) throw new TabItemsError(`item "${key}" amount_cents must be a positive whole number`);
  }
  return items;
}

export const DEFAULT_MIN_CENTS = 500;

/** "20" → 20; blank, "off" or anything outside 0..23 → null. */
export function autoHourFrom(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'off') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}
export const DEFAULT_MAX_ROLL_DAYS = 28;

/**
 * The tab as configured for this deploy.
 *
 * enabled is false when TAB_ITEMS is empty (the feature is off), or when it
 * names something not in tab-items.json (misconfigured; `error` says so and
 * /health shows it). Nothing about the tab runs while enabled is false.
 */
export function tabConfig(env = {}, allItems = {}) {
  const keys = parseList(env.TAB_ITEMS);
  const programs = parseList(env.TAB_PROGRAMS);
  const whole = (value, fallback) => {
    const raw = String(value ?? '').trim();
    if (raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  const cfg = {
    enabled: false,
    error: null,
    items: [],
    programs,
    minCents: whole(env.TAB_MIN_CENTS, DEFAULT_MIN_CENTS),
    maxRollDays: whole(env.TAB_MAX_ROLL_DAYS, DEFAULT_MAX_ROLL_DAYS),
    publicOrigin: String(env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, ''),
    // ET hour at which the cron closes out everyone who is due; null means
    // the staff button only. Johnny, 2026-09-26: the PIN is the authorization,
    // so nobody has to press anything for a member who crossed the line.
    autoHour: autoHourFrom(env.TAB_AUTO_HOUR),
  };
  if (keys.length === 0) return cfg;
  const unknown = keys.filter((k) => !allItems[k]);
  if (unknown.length) {
    cfg.error = `TAB_ITEMS names item(s) not in tab-items.json: ${unknown.join(', ')}`;
    return cfg;
  }
  if (programs.length === 0) {
    cfg.error = 'TAB_PROGRAMS is empty, so nobody could buy';
    return cfg;
  }
  cfg.items = keys.map((k) => ({
    key: k,
    label: allItems[k].label,
    productId: allItems[k].product_id,
    priceId: allItems[k].price_id,
    amountCents: allItems[k].amount_cents,
  }));
  cfg.enabled = true;
  return cfg;
}

/** "$1", "$3", "$2.50". */
export function formatCents(cents) {
  const n = Number(cents) || 0;
  const dollars = Math.floor(n / 100);
  const rest = n % 100;
  return rest === 0 ? `$${dollars}` : `$${dollars}.${String(rest).padStart(2, '0')}`;
}

/**
 * Who may buy (Phase 1): a member every one of whose programs is in
 * TAB_PROGRAMS, and who has at least one. Subset, not overlap: the
 * 14-year-old in the adult class carries kids-10-14 too, so they are out
 * until Phase 1b bills them to a parent. `noCard` is the tab_flags row set
 * when their last close-out found nothing to charge; staff clear it.
 */
export function canBuy(programs, cfg, { noCard = false } = {}) {
  if (!cfg || !cfg.enabled || noCard) return false;
  const list = Array.isArray(programs) ? programs : [];
  if (list.length === 0) return false;
  return list.every((p) => cfg.programs.includes(String(p).toLowerCase()));
}
