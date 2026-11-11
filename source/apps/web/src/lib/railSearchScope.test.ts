import assert from 'node:assert/strict';
import { test } from 'node:test';
import { railSearchScope, WHOLE_LIBRARY, type RailScope } from './railSearchScope.ts';

const FAVOURITES: RailScope = {
  favs: true, markets: [], paths: [], path: null, categoryId: null, cats: [],
};
const A_PACKAGE: RailScope = {
  favs: false, markets: ['BE'], paths: ['BE/TELENET'], path: null, categoryId: null, cats: [],
};

test('the first character asks the whole library, and remembers where we were', () => {
  /* The photographed case: Favourites is empty, so a search inside it finds
     nothing however many channels match. */
  const move = railSearchScope('', 'vtm', FAVOURITES, null);
  assert.equal(move.patch.q, 'vtm');
  assert.equal(move.patch.favs, false);
  assert.deepEqual(move.patch.markets, []);
  assert.deepEqual(move.parked, FAVOURITES);
});

test('typing more moves nothing but the query', () => {
  const move = railSearchScope('vt', 'vtm', WHOLE_LIBRARY, FAVOURITES);
  assert.deepEqual(move.patch, { q: 'vtm' });
  assert.deepEqual(move.parked, FAVOURITES, 'still parked — the search is not over');
});

test('clearing the box puts the viewer back where they were', () => {
  const move = railSearchScope('vtm', '', WHOLE_LIBRARY, FAVOURITES);
  assert.equal(move.patch.q, '');
  assert.equal(move.patch.favs, true);
  assert.equal(move.parked, null, 'and the memory is spent');
});

test('a scope picked DURING the search is the viewer\'s, and survives clearing', () => {
  /* The caller drops the parked scope the moment a row is picked, so this is
     what clearing looks like afterwards: the query goes, the pick stays. */
  const move = railSearchScope('vtm', '', A_PACKAGE, null);
  assert.deepEqual(move.patch, { q: '' });
  assert.equal(move.parked, null);
});

test('clearing a box that was never a detour changes only the query', () => {
  const move = railSearchScope('vtm', '', WHOLE_LIBRARY, null);
  assert.deepEqual(move.patch, { q: '' });
});

test('starting again after a clear parks the new place, not the old one', () => {
  const first = railSearchScope('', 'vtm', FAVOURITES, null);
  const back = railSearchScope('vtm', '', WHOLE_LIBRARY, first.parked);
  assert.equal(back.patch.favs, true);
  const again = railSearchScope('', 'bbc', A_PACKAGE, back.parked);
  assert.deepEqual(again.parked, A_PACKAGE);
});
