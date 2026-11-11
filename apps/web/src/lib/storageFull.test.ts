import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStorageFull } from './localCatalogue.ts';

/**
 * "The device will not keep this" versus "the panel will not give me this".
 *
 * They need opposite answers. A panel failure is retried, and a host that keeps
 * failing is dropped. A STORAGE failure is not the panel's fault and retrying
 * it forever is what a catalogue that never appears looks like — so it falls
 * back to on-demand mode, which holds the structure and only the packages
 * somebody opens.
 *
 * Measured on the website: plain HTTP on an IP, so not a secure context,
 * `navigator.storage` absent, IndexedDB on a best-effort quota, and ~159MB of
 * raw payloads that will not fit. The abort arrives in more than one shape
 * depending on the engine, which is the whole reason this is a function.
 */
test('a quota refusal is recognised however the browser words it', () => {
  const named = Object.assign(new Error('nope'), { name: 'QuotaExceededError' });
  assert.equal(isStorageFull(named), true, 'the DOM name');
  assert.equal(isStorageFull(new Error('the browser would not store this (no space for it here)')), true,
    'the message this store raises when the transaction aborts with no name');
  assert.equal(isStorageFull(new Error('Quota exceeded for this origin')), true);
  assert.equal(isStorageFull(new Error('no space left')), true);
});

test('a panel failure is never mistaken for a full disk', () => {
  /* The cost of getting this backwards: a 456 would silently shrink the
     viewer's library instead of being reported as flood protection. */
  for (const m of [
    'auth: HTTP 456 from /player_api.php',
    'live_streams: HTTP 521 from /player_api.php',
    'Failed to fetch',
    'expected JSON, got <html>',
  ]) {
    assert.equal(isStorageFull(new Error(m)), false, m);
  }
  assert.equal(isStorageFull(null), false);
  assert.equal(isStorageFull(undefined), false);
});
