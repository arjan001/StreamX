import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPreparing, startPreparing, stopPreparing, subscribePreparing } from './firstCatalogue.ts';

test('the first-build flag is a moment, told once', () => {
  stopPreparing();
  const seen: boolean[] = [];
  const off = subscribePreparing((v) => seen.push(v));
  startPreparing();
  /* Told once, not once per caller of `startPreparing` — the sign-in path and
     the attach path both run, and two loading screens is worse than none. */
  startPreparing();
  assert.equal(isPreparing(), true);
  stopPreparing();
  stopPreparing();
  assert.equal(isPreparing(), false);
  assert.deepEqual(seen, [true, false]);
  off();
});

test('unsubscribing stops delivery', () => {
  stopPreparing();
  let n = 0;
  const off = subscribePreparing(() => { n += 1; });
  off();
  startPreparing();
  assert.equal(n, 0);
  stopPreparing();
});
