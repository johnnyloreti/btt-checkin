import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowRequest, resetFallback, LIMIT } from '../src/ratelimit.js';

const req = (ip) => new Request('https://x.test/api/roster', { headers: { 'cf-connecting-ip': ip } });

test('uses the rate-limit binding when present', async () => {
  const keys = [];
  const env = { RATE_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: key !== '9.9.9.9' }) } };
  assert.equal(await allowRequest(env, req('1.1.1.1')), true);
  assert.equal(await allowRequest(env, req('9.9.9.9')), false);
  assert.deepEqual(keys, ['1.1.1.1', '9.9.9.9']);
});

test('fallback window allows 60 per minute per IP, then blocks, then recovers', async () => {
  resetFallback();
  const t0 = 1_000_000;
  for (let i = 0; i < LIMIT; i += 1) assert.equal(await allowRequest({}, req('2.2.2.2'), t0 + i), true);
  assert.equal(await allowRequest({}, req('2.2.2.2'), t0 + LIMIT), false);
  assert.equal(await allowRequest({}, req('3.3.3.3'), t0 + LIMIT), true, 'other IPs unaffected');
  assert.equal(await allowRequest({}, req('2.2.2.2'), t0 + 60_001), true, 'window slid');
  resetFallback();
});
