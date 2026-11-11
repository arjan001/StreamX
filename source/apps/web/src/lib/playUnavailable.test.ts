import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayUnavailable, playFailureHint, whyNoPlay } from './playUnavailable.ts';

/** The all-good input: every branch below flips exactly one field false. */
const ok = { hasCatalogue: true, rowFound: true, hasCredentials: true, hasStreamId: true };

test('no catalogue on the device at all — the library is still building', () => {
  assert.equal(whyNoPlay({ ...ok, hasCatalogue: false }), 'no-library');
});

test('a catalogue, but no row for this id — a stale link', () => {
  assert.equal(whyNoPlay({ ...ok, rowFound: false }), 'not-found');
});

test('a row, but no active account behind it', () => {
  assert.equal(whyNoPlay({ ...ok, hasCredentials: false }), 'signed-out');
});

test('a row and an account, but the row carries no provider stream id', () => {
  assert.equal(whyNoPlay({ ...ok, hasStreamId: false }), 'not-found');
});

test('no catalogue wins over every other fact — it is the strongest statement', () => {
  // A row can only be "found" once a catalogue exists to find it in, so this
  // combination should never occur in practice — but `no-library` still has to
  // win if it did, because it is the most specific true thing being said.
  assert.equal(whyNoPlay({ hasCatalogue: false, rowFound: false, hasCredentials: false, hasStreamId: false }),
    'no-library');
});

test('PlayUnavailable carries a plain-English sentence per reason', () => {
  assert.equal(new PlayUnavailable('no-library').reason, 'no-library');
  assert.match(new PlayUnavailable('no-library').message, /library/i);
  assert.match(new PlayUnavailable('not-found').message, /reload/i);
  assert.match(new PlayUnavailable('signed-out').message, /source/i);
});

test('playFailureHint prefers the PlayUnavailable sentence', () => {
  const err = new PlayUnavailable('signed-out');
  assert.equal(playFailureHint(err, 'fallback text'), err.message);
});

test('playFailureHint gives the stale-link wording for a 404', () => {
  const err = new Error('HTTP 404 /movie/501495737.mkv');
  assert.match(playFailureHint(err, 'fallback text'), /no longer exists/);
});

test('playFailureHint falls back to the caller\'s own wording otherwise', () => {
  assert.equal(playFailureHint(new Error('500 boom'), 'fallback text'), 'fallback text');
  assert.equal(playFailureHint('not even an Error', 'fallback text'), 'fallback text');
});
