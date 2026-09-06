import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opaqueId, buildIdMap, requireSalt } from '../src/ids.js';

test('opaque ids are stable, salted, and 20 hex chars', async () => {
  const a = await opaqueId('c_jack', 'salt-number-one');
  const b = await opaqueId('c_jack', 'salt-number-one');
  const c = await opaqueId('c_jack', 'salt-number-two');
  const d = await opaqueId('c_emma', 'salt-number-one');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{20}$/);
  assert.ok(!a.includes('c_jack'));
});

test('buildIdMap resolves back to rows', async () => {
  const rows = [{ ghl_contact_id: 'c_jack' }, { ghl_contact_id: 'c_emma' }];
  const map = await buildIdMap(rows, 'salt-number-one');
  assert.equal(map.get(await opaqueId('c_emma', 'salt-number-one')).ghl_contact_id, 'c_emma');
  assert.equal(map.size, 2);
});

test('requireSalt refuses a missing or short salt', () => {
  assert.throws(() => requireSalt({}), /ID_SALT/);
  assert.throws(() => requireSalt({ ID_SALT: 'short' }), /ID_SALT/);
  assert.equal(requireSalt({ ID_SALT: 'long-enough-salt' }), 'long-enough-salt');
});
