// ratelimit.js — 60 requests / minute / IP on public routes (§7).
// Uses the Workers rate-limit binding when present. Falls back to a
// per-isolate sliding window so local dev and tests behave the same way.

export const LIMIT = 60;
export const PERIOD_MS = 60_000;

const fallback = new Map(); // ip → [timestamps]

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

/** True when the request is allowed. */
export async function allowRequest(env, request, now = Date.now()) {
  const ip = clientIp(request);
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return Boolean(success);
  }
  const cutoff = now - PERIOD_MS;
  const hits = (fallback.get(ip) || []).filter((t) => t > cutoff);
  if (hits.length >= LIMIT) {
    fallback.set(ip, hits);
    return false;
  }
  hits.push(now);
  fallback.set(ip, hits);
  if (fallback.size > 10_000) fallback.clear();
  return true;
}

/** Test hook. */
export function resetFallback() {
  fallback.clear();
}
