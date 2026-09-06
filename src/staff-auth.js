// staff-auth.js — PIN check shared by staff routes.
// Step 5 adds the login route and cookie. Until then a request may carry the
// PIN in an x-staff-pin header, which is what the manual sync trigger uses.

function sameString(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function pinMatches(env, candidate) {
  if (!env.STAFF_PIN) return false;
  return sameString(env.STAFF_PIN, candidate);
}

/** True when the request is authorized as staff. */
export function isStaff(request, env) {
  const header = request.headers.get('x-staff-pin');
  if (header && pinMatches(env, header)) return true;
  return false;
}
