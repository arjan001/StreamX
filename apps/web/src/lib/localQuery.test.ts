/**
 * The wire query -> store query mapping, clause by clause.
 *
 * `toQuery` is a run of conditional spreads, and a missing one is silent: no
 * throw, no log, no error result — just a query that means something wider than
 * what was asked for. The dangerous direction is a dropped INCLUDE, which shows
 * too much instead of too little.
 *
 * The adult exclusion is not one of those clauses: core-store applies it on every
 * read, and nothing here can turn it off or forget it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toQuery } from './localRead.ts';

test('adultOnly clause is passed through to filter only adult content', () => {
  // Without adultOnly, the query should not have it
  const q = toQuery('movies', { hideStreams: [1] } as never) as Record<string, unknown>;
  assert.equal('adultOnly' in q, false);
  assert.equal('hideAdult' in q, false);
  // With adultOnly: true, the query should pass it through to core-store
  const wide = toQuery('movies', { adultOnly: true, hideAdult: false } as never) as Record<string, unknown>;
  assert.equal('adultOnly' in wide, true, 'adultOnly clause is now honoured for /adult route');
  assert.equal(wide.adultOnly, true, 'adultOnly should be true');
});

test('every filtering clause the wire carries survives the mapping', () => {
  /*
   * Named individually rather than by looping over `Object.keys`, because the
   * mapping is not an identity: `path`/`paths`/`markets` collapse into `paths`,
   * `genre` folds into `genres`, and `hideCatRefs` resolves against a catalogue
   * this test has not loaded. A structural check that only proved "some key
   * survived" would have passed while a clause was missing.
   */
  const q = toQuery('movies', {
    offset: 20, limit: 40, categoryId: 7, q: 'dune',
    yearFrom: 1990, yearTo: 2020, minRating: 6, addedSince: 1_790_000_000,
    archiveOnly: true,
    genre: 'action', region: 'EN', source: 'Netflix',
    cats: [1, 2], hidePaths: ['EN/KIDS'], hideStreams: [9],
    streamIds: [4, 5], sort: 'added', dir: 'desc',
  });
  assert.equal(q.offset, 20);
  assert.equal(q.limit, 40);
  assert.equal(q.categoryId, 7);
  assert.equal(q.q, 'dune');
  assert.equal(q.yearFrom, 1990);
  assert.equal(q.yearTo, 2020);
  assert.equal(q.minRating, 6);
  assert.equal(q.addedSince, 1_790_000_000);
  assert.equal(q.archiveOnly, true);
  assert.deepEqual(q.genres, ['action']);
  assert.equal(q.region, 'EN');
  assert.equal(q.source, 'Netflix');
  assert.deepEqual(q.cats, [1, 2]);
  assert.deepEqual(q.hidePaths, ['EN/KIDS']);
  assert.deepEqual(q.hideStreams, [9]);
  assert.deepEqual(q.streamIds, [4, 5]);
  assert.equal(q.sort, 'added');
  assert.equal(q.dir, 'desc');
});

test('path, paths and markets all become one paths list', () => {
  const q = toQuery('live', { path: 'EN', paths: ['NL'], markets: ['FR'] });
  assert.deepEqual(q.paths, ['EN', 'NL', 'FR']);
});

test('an empty streamIds list survives as empty, meaning nothing', () => {
  /* The favourites case: `[]` must not be dropped, or "no favourites" becomes
     "every row". `streamIds !== undefined` is the guard that gets this right. */
  assert.deepEqual(toQuery('movies', { streamIds: [] }).streamIds, []);
});
