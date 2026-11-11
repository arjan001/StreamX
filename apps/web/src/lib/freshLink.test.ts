import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FreshLink } from './freshLink.ts';

test('a stream gets one fresh link per open, and again once something has played', () => {
  const f = new FreshLink();
  const ask = async () => 'link';
  assert.equal(f.take('1.101', undefined), null, 'no way to ask, no ask');
  assert.equal(f.take('1.101', ask), ask);
  assert.equal(f.take('1.101', ask), null, 'a dead channel is asked about once, not for ever');
  assert.equal(f.take('1.102', ask), ask, 'another stream has its own');
  f.reset();
  assert.equal(f.take('1.102', ask), ask, 'after a stream played, the next failure earns a new link');
});
