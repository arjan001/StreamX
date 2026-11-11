import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossScope, type CrossFilters } from './crossFilter.ts';

const EMPTY: CrossFilters = {
  markets: [], path: null, paths: [], categoryId: null, cats: [],
  genres: [], region: null, source: null,
  yearFrom: null, yearTo: null, minRating: null, q: '',
};
const f = (p: Partial<CrossFilters>): CrossFilters => ({ ...EMPTY, ...p });

test('a genre narrows the country list, the group tree and the package list', () => {
  const s = crossScope({}, f({ genres: ['comedy'] }), 'groups');
  assert.deepEqual(s.genres, ['comedy']);
});

test('a list is never scoped by its own axis', () => {
  const picked = f({ markets: ['EN'], path: 'EN/COMEDY', genres: ['comedy'], region: 'en', source: 'netflix', cats: [7] });

  // The tree must still offer the countries it is not standing in.
  const groups = crossScope({}, picked, 'groups');
  assert.equal(groups.paths, undefined);
  assert.equal(groups.markets, undefined);
  assert.deepEqual(groups.cats, [7]);

  // The language select must not be filtered down to the language already chosen.
  const region = crossScope({}, picked, 'region');
  assert.equal(region.region, undefined);
  assert.equal(region.source, 'netflix');

  const source = crossScope({}, picked, 'source');
  assert.equal(source.source, undefined);
  assert.equal(source.region, 'en');

  const cats = crossScope({}, picked, 'cats');
  assert.equal(cats.cats, undefined);
  assert.deepEqual(cats.paths, ['EN/COMEDY']);
});

/* Genres AND, so a chip's count is measured with the current selection applied
   — which means the selection has to reach the genre column too, not be dropped
   from its own scope the way a single-select axis is. */
test('the genre selection travels even in the genre list\'s own scope', () => {
  const s = crossScope({}, f({ genres: ['comedy', 'drama'] }), 'genres');
  assert.deepEqual(s.genres, ['comedy', 'drama']);
});

/*
 * The routes UNION paths and markets into one prefix list, so a country sent
 * beside a group inside it widens the answer back out to the country. The
 * profile's own countries arrive on the base scope, which is where that would
 * otherwise happen silently.
 */
test('a chosen group replaces the countries rather than joining them', () => {
  const s = crossScope({ markets: ['EN', 'NL'] }, f({ paths: ['EN/COMEDY'] }), 'genres');
  assert.deepEqual(s.paths, ['EN/COMEDY']);
  assert.equal(s.markets, undefined);
});

test('with no group chosen the countries stand, already clipped to the profile', () => {
  const s = crossScope({ markets: ['EN', 'NL'] }, f({ markets: ['EN', 'FR'] }), 'genres', ['EN']);
  assert.deepEqual(s.markets, ['EN']);
});

test('the singular and plural spellings of a selection are one list', () => {
  const s = crossScope({}, f({ path: 'EN', paths: ['EN', 'NL'], categoryId: 3, cats: [3, 4] }), 'genres');
  assert.deepEqual(s.paths, ['EN', 'NL']);
  assert.deepEqual(s.cats, [3, 4]);
});

test('the hidden lists ride through untouched — a scope that loses them shows hidden rows', () => {
  const base = { hidePaths: ['18'], hideCats: [9], hideCatRefs: ['2.9'], hideStreams: [5] };
  const s = crossScope(base, f({ genres: ['comedy'] }), 'groups');
  assert.deepEqual(s.hidePaths, ['18']);
  assert.deepEqual(s.hideCats, [9]);
  assert.deepEqual(s.hideCatRefs, ['2.9']);
  assert.deepEqual(s.hideStreams, [5]);
});

test('year, rating and search narrow every list that is not their own', () => {
  const picked = f({ yearFrom: 1990, yearTo: 1999, minRating: 7, q: 'matrix' });
  const groups = crossScope({}, picked, 'groups');
  assert.equal(groups.yearFrom, 1990);
  assert.equal(groups.yearTo, 1999);
  assert.equal(groups.minRating, 7);
  assert.equal(groups.q, 'matrix');

  const year = crossScope({}, picked, 'year');
  assert.equal(year.yearFrom, undefined);
  assert.equal(year.yearTo, undefined);
  assert.equal(year.minRating, 7);

  const rating = crossScope({}, picked, 'rating');
  assert.equal(rating.minRating, undefined);
  assert.equal(rating.yearFrom, 1990);
});

test('nothing selected is the bare profile scope, so the cache key does not move', () => {
  assert.deepEqual(crossScope({ hidePaths: ['EN/KIDS'] }, EMPTY, 'groups'), { hidePaths: ['EN/KIDS'] });
});
