import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestions } from './suggest.ts';

const n = (...names: string[]) => names.map((name) => ({ name }));

test('a prefix completes, and the prefix matches come first', () => {
  assert.deepEqual(
    suggestions('tol', [n('Scientology Network', 'TOLOnews', 'Tolo TV')]),
    ['TOLOnews', 'Tolo TV'],
  );
});

/* Typing a later word is how people actually search for a channel: nobody types
   "sky" to find Sky News, they type "news". */
test('a later word counts, and ranks under the true prefixes', () => {
  assert.deepEqual(
    suggestions('news', [n('Sky News', 'NewsX', 'Hum News')]),
    ['NewsX', 'Sky News', 'Hum News'],
  );
});

/* Mid-word is a search result, not a completion — and the results are already
   on the page underneath. Offering one reads as the app not having understood. */
test('a match in the middle of a word is not a completion', () => {
  assert.deepEqual(suggestions('ews', [n('Sky News')]), []);
  assert.deepEqual(suggestions('olo', [n('TOLOnews')]), []);
});

test('the routing metadata is stripped, so accepting one does not narrow the search', () => {
  // Putting "|EN| Sky News FHD" in the field would find less than "news" did.
  assert.deepEqual(suggestions('sky', [n('|EN| Sky News FHD')]), ['Sky News']);
});

test('punctuation and case do not stop a completion', () => {
  // A hyphen typed where the title has a space still completes.
  assert.deepEqual(suggestions('sky-n', [n('Sky News')]), ['Sky News']);
  assert.deepEqual(suggestions('SKY', [n('sky news')]), ['sky news']);
  // The suggestion is the CLEANED title: the quality token goes, as it does
  // everywhere else the name is shown.
  assert.deepEqual(suggestions('bbc', [n('BBC  One   HD')]), ['BBC One']);
});

test('the same title twice is one suggestion', () => {
  assert.deepEqual(suggestions('sky', [n('Sky News', 'SKY  NEWS', 'sky-news')]), ['Sky News']);
});

/* What is already typed is not a suggestion: a chip that does nothing is worse
   than no chip, because it costs a press to find that out. */
test('what is already in the field is never offered back', () => {
  assert.deepEqual(suggestions('sky news', [n('Sky News')]), []);
});

/*
 * Round-robin, not concatenation.
 *
 * Live comes back first and can fill six slots on its own, which would hide the
 * film whose title is the better completion — and the page already ranks the
 * section you came from, so this list has a different job.
 */
test('every section gets a turn before any section gets a second', () => {
  assert.deepEqual(
    suggestions('star', [
      n('Star Channel 1', 'Star Channel 2', 'Star Channel 3'),
      n('Star Wars'),
      n('Star Trek'),
    ], 4),
    ['Star Channel 1', 'Star Wars', 'Star Trek', 'Star Channel 2'],
  );
});

test('under two letters suggests nothing — everything matches one letter', () => {
  assert.deepEqual(suggestions('s', [n('Sky News')]), []);
  assert.deepEqual(suggestions('', [n('Sky News')]), []);
});

test('empty and ragged input is answered with an empty list, not a throw', () => {
  assert.deepEqual(suggestions('news', []), []);
  assert.deepEqual(suggestions('news', [[], n('  ', 'Sky News')]), ['Sky News']);
});

test('the limit is honoured', () => {
  assert.equal(suggestions('star', [n('Star A', 'Star B', 'Star C', 'Star D')], 2).length, 2);
});
