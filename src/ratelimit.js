// ratelimit.js — per-IP limits (§7): 60 requests / minute on public routes
// and 5 / minute on staff login so a 4-digit PIN cannot be brute-forced.
// Uses the Workers rate-limit bindings when present. Falls back to a
// per-isolate sliding window so local dev and tests behave the same way.

export const PUBLIC = { binding: 'RATE_LIMITER', limit: 60, periodMs: 60_000, trustProxy: true };
// Login never trusts a forwarded address. Behind the proxy every staff login
// shares Netlify's bucket, which is fine for one gym, and a leaked PROXY_KEY
// cannot be used to forge addresses and brute-force the PIN.
export const LOGIN = { binding: 'LOGIN_LIMITER', limit: 5, periodMs: 60_000, trustProxy: false };

const fallback = new Map(); // "<binding>:<ip>" → [timestamps]

function sameString(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * The visitor's address. When the request arrives through the Netlify
 * proxy on checkin.bttbridgewater.com, Cloudflare sees Netlify as the
 * client, so the real address is in Netlify's header. That header is
 * trusted only when the proxy also sends the shared PROXY_KEY, so a direct
 * caller cannot spoof it.
 */
export function clientIp(request, env = {}, trustProxy = true) {
  const key = request.headers.get('x-proxy-key');
  const forwarded = request.headers.get('x-nf-client-connection-ip');
  if (trustProxy && forwarded && env.PROXY_KEY && sameString(key, env.PROXY_KEY)) return forwarded.trim();
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}

/** True when the request is allowed under the given policy. */
export async function allowRequest(env, request, policy = PUBLIC, now = Date.now()) {
  const ip = clientIp(request, env, policy.trustProxy !== false);
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
