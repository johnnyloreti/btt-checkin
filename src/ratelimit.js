// ratelimit.js — per-IP limits (§7): 60 requests / minute on public routes
// and 5 / minute on staff login so a 4-digit PIN cannot be brute-forced.
// Uses the Workers rate-limit bindings when present. Falls back to a
// per-isolate sliding window so local dev and tests behave the same way.

export const PUBLIC = { binding: 'RATE_LIMITER', limit: 60, periodMs: 60_000 };
export const LOGIN = { binding: 'LOGIN_LIMITER', limit: 5, periodMs: 60_000 };

const fallback = new Map(); // "<binding>:<ip>" → [timestamps]

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

/** True when the request is allowed under the given policy. */
export async function allowRequest(env, request, policy = PUBLIC, now = Date.now()) {
  const ip = clientIp(request);
  const binding = env[policy.binding];
  if (binding && typeof binding.limit === 'function') {
    const { success } = await binding.limit({ key: ip });
    return Boolean(success);
  }
  const key = `${policy.binding}:${ip}`;
  const cutoff = now - policy.periodMs;
  const hits = (fallback.get(key) || []).filter((t) => t > cutoff);
  if (hits.length >= policy.limit) {
    fallback.set(key, hits);
    return false;
  }
  hits.push(now);
  fallback.set(key, hits);
  if (fallback.size > 10_000) fallback.clear();
  return true;
}

/** Test hook. */
export function resetFallback() {
  fallback.clear();
}
