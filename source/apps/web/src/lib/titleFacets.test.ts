/**
 * The chips over the series rail, and the two ways a chip row lies.
 *
 * The first is counting a facet over a PAGE — see `listAll`'s note; these tests
 * only exercise the pure half, so the guard against that is the shape of the
 * API: `facetTitles` takes every name it is going to speak for.
 *
 * The second is combining chips by a rule the viewer cannot see. Two countries
 * must widen (nothing is made in two countries) and a country plus a quality
 * must narrow (everything has both), and that asymmetry is what these assert.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NO_TAGS, anyTag, facetTitles, filterByTags, tagsMatch, toggleTag,
} from './titleFacets.ts';

/* Verbatim rows from `fixtures/catalogue.json`, plus the paired-prefix shape the
   live panel writes today. */
const NAMES = [
  '4K - 1883 (2021)',
  '4K - 1899 (2022) (DE)',
  '4K - Alice in Borderland (2020) (JP)',
  '4K-SC - Fallout (2024) (US)',
  'A+ - Bad Sisters (2022)',
  'D+ - Among the Stars',
  'EN - Breaking Bad (2008) (US)',
  'FR - Anthracite (2024) (FR)',
  'Black Summer (2019)',
];

test('every tag is counted, most-carried first', () => {
  const f = facetTitles(NAMES);
  assert.deepEqual(f.quality, [{ id: '4K', count: 4 }]);
  /* Every source here carries one title, so the tie-break is what is being
     asserted: alphabetical, not insertion order — a chip row that reshuffles
     between two refreshes holding the same titles is a row nobody can learn. */
  assert.deepEqual(f.source.map((s) => s.id), ['A+', 'D+', 'EN', 'FR', 'SC']);
  assert.deepEqual(f.country, [
    { id: 'US', count: 2 }, { id: 'DE', count: 1 }, { id: 'FR', count: 1 }, { id: 'JP', count: 1 },
  ]);
  /* A row with no tag on an axis is simply absent from it — "unknown" is a fact
     about the catalogue, not a value anybody wants to browse by. */
  assert.equal(f.quality.reduce((n, q) => n + q.count, 0), 4);
});

test('two values on one axis widen, two axes narrow', () => {
  const us = toggleTag(NO_TAGS, 'country', 'US');
  assert.equal(filterByTags(NAMES.map(named), us).length, 2);
  const usAndDe = toggleTag(us, 'country', 'DE');
  // Any-of: nothing is made in two countries, so a second one can only widen.
  assert.equal(filterByTags(NAMES.map(named), usAndDe).length, 3);
  // All-of across axes: 4K AND US is one row, not three.
  const fourKandUs = toggleTag(us, 'quality', '4K');
  assert.deepEqual(
    filterByTags(NAMES.map(named), fourKandUs).map((r) => r.name),
    ['4K-SC - Fallout (2024) (US)'],
  );
});

test('an untagged title is only kept while nothing is pressed', () => {
  assert.equal(tagsMatch('Black Summer (2019)', NO_TAGS), true);
  assert.equal(tagsMatch('Black Summer (2019)', toggleTag(NO_TAGS, 'quality', '4K')), false);
  assert.equal(anyTag(NO_TAGS), false);
  assert.equal(anyTag(toggleTag(NO_TAGS, 'source', 'EN')), true);
});

test('pressing a lit chip puts it out', () => {
  const on = toggleTag(NO_TAGS, 'source', 'EN');
  assert.deepEqual(toggleTag(on, 'source', 'EN'), NO_TAGS);
});

test('filtering keeps the order it was given', () => {
  // The rail is alphabetical; a filter must narrow it, never reshuffle it.
  const rows = NAMES.map(named);
  const kept = filterByTags(rows, toggleTag(NO_TAGS, 'quality', '4K')).map((r) => r.name);
  assert.deepEqual(kept, NAMES.filter((n) => n.startsWith('4K')));
});

/** The one field of `Item` any of this reads. */
function named(name: string) {
  return { name } as unknown as import('./api.ts').Item;
}
