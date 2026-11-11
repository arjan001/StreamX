import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticCacheControl } from './staticCache.ts';

/**
 * A fixed address with changing contents is the one thing a long cache cannot
 * survive, and it cost a shipped fix a whole day of not arriving:
 *
 *     worker.js:1761 Uncaught TypeError: globalThis.crypto.randomUUID is not a
 *     function
 *
 * — reported after the fix for that had gone out. The browser was still
 * running the previous `/libav/worker.js`, because it had one and had been
 * told to keep it for 86,400 seconds.
 */
test('the remuxer’s files are revalidated, never held', () => {
  for (const p of ['/libav/worker.js', '/libav/libav-worker.js', '/libav/libav.wasm', '/libav/libav-jspi.wasm']) {
    assert.equal(staticCacheControl(p), 'no-cache', p);
  }
});

test('and so are the two that could strand a deploy on their own', () => {
  assert.equal(staticCacheControl('/index.html'), 'no-cache');
  assert.equal(staticCacheControl('/sw.js'), 'no-cache');
});

test('a content-hashed asset is still immutable for a year', () => {
  const y = 'public, max-age=31536000, immutable';
  assert.equal(staticCacheControl('/assets/vendor-BoPexQRq.js'), y);
  assert.equal(staticCacheControl('/assets/index-CAVKPGwv.css'), y);
});

test('and everything else keeps its day', () => {
  assert.equal(staticCacheControl('/icon-512.png'), 'public, max-age=86400');
  assert.equal(staticCacheControl('/manifest.webmanifest'), 'public, max-age=86400');
  /* An un-hashed file in /assets/ is NOT immutable — the hash is the version,
     and without one there is nothing to version by. */
  assert.equal(staticCacheControl('/assets/plain.js'), 'public, max-age=86400');
});
