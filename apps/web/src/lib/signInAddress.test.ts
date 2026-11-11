import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn } from './session.ts';

test('signing in without any server address asks for one; there is no built-in pool', async () => {
  const res = await signIn('alice', 'secret');
  assert.equal(res.ok, false);
  assert.match(res.message ?? '', /server address/i);
});
