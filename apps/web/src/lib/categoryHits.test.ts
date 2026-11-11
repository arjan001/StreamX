/**
 * "the search should search both tv categores as well as channals".
 *
 * The ranking is the whole feature: a row of twelve chips is only useful if the
 * one somebody meant is among the first two or three, and on a provider with 829
 * packages a plain substring match puts it anywhere.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryHits } from './categoryHits.ts';

const LIVE = [
  { id: 1, name: 'UK| SKY SPORTS', count: 73 },
  { id: 2, name: 'UK| FREESKY MUSIC', count: 12 },
  { id: 3, name: 'NL| ALGEMEEN', count: 120 },
  { id: 4, name: 'UK| SKY CINEMA', count: 40 },
  { id: 5, name: 'EMPTY | SKY NOTHING', count: 0 },
];
const MOVIES = [{ id: 11, name: '|ES| SKY PELICULAS', count: 300 }];

const ALL = [
  { section: 'live' as const, categories: LIVE },
  { section: 'movies' as const, categories: MOVIES },
];

test('a name that starts with the query beats one that merely contains it', () => {
  const hits = categoryHits([{ section: 'live' as const, categories: LIVE }], 'sky');
  /* `UK| SKY …` folds to a word starting with "sky"; FREESKY buries it. */
  assert.deepEqual(hits.map((h) => h.id), [1, 4, 2]);
});

test('every library is asked, not only Live', () => {
  const hits = categoryHits(ALL, 'sky');
  assert.ok(hits.some((h) => h.section === 'movies' && h.id === 11));
});

test('the bigger package wins a tie, and an empty one is not a destination', () => {
  const hits = categoryHits(ALL, 'sky');
  const top = hits.filter((h) => h.label.includes('SKY'));
  /* Same rank (a word starting with "sky"), so the 300-title package leads. */
  assert.equal(top[0]?.id, 11);
  assert.equal(hits.some((h) => h.id === 5), false, 'a category with nothing in it');
});

test('a link is a real address for that section', () => {
  const [hit] = categoryHits([{ section: 'series' as const, categories: [{ id: 9, name: 'NL| NPO', count: 5 }] }], 'npo');
  assert.equal(hit?.href, '/series?category=9');
});

test('one letter is not a search, and nothing matching is nothing', () => {
  assert.deepEqual(categoryHits(ALL, 's'), []);
  assert.deepEqual(categoryHits(ALL, ''), []);
  assert.deepEqual(categoryHits(ALL, 'zzzz'), []);
});

test('the row is bounded however many match', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: `UK| SKY ${i}`, count: 10 }));
  assert.equal(categoryHits([{ section: 'live' as const, categories: many }], 'sky').length, 12);
});
