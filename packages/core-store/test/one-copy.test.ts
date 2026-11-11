/**
 * `oneCopy`: the same title filed in several country packages is one row.
 *
 * "Youth" four times on one screen of Trending, "4 Blocks Zero" twice in Top
 * rated — every copy a different package's, all the same poster.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactName, normName } from '@iptv/core-xtream';
import { KIND, buildColumns, listAll, listAllSorted, listItems, type Catalogue, type ItemDraft } from '../src/index.ts';

const draft = (name: string, i: number, rating: number, year: string | null, added = 100 + i): ItemDraft => ({
  kind: KIND.Series, streamId: i + 1, categoryId: 1, name, logo: null,
  compactName: compactName(name), normName: normName(name),
  ext: null, tvgId: null, url: null, archive: false, archiveDays: 0, adult: false, direct: false,
  rating, year, added, sortIndex: i,
});

const cat = (rows: [string, number, string | null, number?][]): Catalogue => ({
  generation: 1,
  builtAt: 1000,
  items: buildColumns(rows.map(([n, r, y, a], i) => draft(n, i, r, y, a))),
  categories: [{
    id: 1, kind: KIND.Series, remoteId: 'r1', name: 'EN | A', cleanName: 'A',
    genres: [], region: 'EN', source: null, path: ['EN', 'A'], itemCount: rows.length, sortIndex: 0,
  }],
  counts: { live: 0, movies: 0, series: rows.length },
});

test('copies across packages fold into one, in rating order, highest first', () => {
  const c = cat([
    ['ES| 4 Blocks Zero', 8.0, '2026'],
    ['Arafta', 10.0, '2025'],
    ['NL| 4 Blocks Zero (2026)', 8.0, null],
    ['ES| Youth', 8.0, '2026'],
    ['NL| Youth', 8.0, '2026'],
    ['EN - Youth 4K', 7.9, '2026'],
  ]);
  const all = listItems(c, { kind: KIND.Series, sort: 'rating', dir: 'desc' });
  assert.equal(all.total, 6);
  const one = listItems(c, { kind: KIND.Series, sort: 'rating', dir: 'desc', oneCopy: true });
  assert.deepEqual(one.rows.map((r) => r.name), ['Arafta', 'ES| 4 Blocks Zero', 'ES| Youth']);
  assert.equal(one.total, 3);
});

test('the same name in different years is two titles, not one', () => {
  const c = cat([
    ['EN - Dune (1984)', 6.5, '1984'],
    ['EN - Dune (2021)', 7.8, '2021'],
  ]);
  const one = listItems(c, { kind: KIND.Series, sort: 'rating', dir: 'desc', oneCopy: true });
  assert.equal(one.total, 2);
});

test('a copy with no year is the same title as a dated one', () => {
  const c = cat([
    ['EN - Toy Story 5', 8.2, '2026'],
    ['NL - Toy Story 5', 7.4, null],
    ['Mutiny', 6.4, null],
    ['ES| Mutiny (2026)', 7.8, '2026'],
  ]);
  const one = listItems(c, { kind: KIND.Series, sort: 'rating', dir: 'desc', oneCopy: true });
  assert.deepEqual(one.rows.map((r) => r.name), ['EN - Toy Story 5', 'ES| Mutiny (2026)']);
});

test('equal ratings list the newest first', () => {
  const c = cat([
    ['Alpha', 9.0, '2019'],
    ['Beta', 9.0, '2025'],
    ['Gamma', 9.5, '2001'],
  ]);
  const page = listItems(c, { kind: KIND.Series, sort: 'rating', dir: 'desc' });
  assert.deepEqual(page.rows.map((r) => r.name), ['Gamma', 'Beta', 'Alpha']);
});

test('what an uploader adds after the year does not make it another title', () => {
  const c = cat([
    ['EN - Mutiny (2026) JASON STATHAM', 7.8, '2026'],
    ['NL - MUTINY (2026)', 6.6, '2026'],
    ['FR - Mutiny (2026)', 6.4, '2026'],
    ['EN - Toy Story 5 (2026) TOM HANKS', 7.4, '2026'],
    ['ES - Toy Story 5 (HQ) (2026)', 8.2, '2026'],
    ['EN - Toy Story 5 4K (2026)', 7.9, '2026'],
  ]);
  const one = listItems(c, { kind: KIND.Series, sort: 'rating', dir: 'desc', oneCopy: true });
  assert.deepEqual(one.rows.map((r) => r.name), ['ES - Toy Story 5 (HQ) (2026)', 'EN - Mutiny (2026) JASON STATHAM']);
});

test('the whole list, newest first, when asked by name — listAll stays match order', () => {
  /* A sorted listAll: the old adult default asked listAll for newest first and showed
     the provider's order, a film from 2023 above the week's arrivals. */
  const c = cat([
    ['EN - Appassionata (1974)', 5.6, '1974', 1_687_219_200],
    ['[X][A] Week One', 0, null, 1_790_812_800],
    ['[X][B] Week Two', 0, null, 1_790_899_200],
    ['[X][C] August', 0, null, 1_787_356_800],
  ]);
  const q = { kind: KIND.Series, sort: 'added', dir: 'desc' } as const;
  assert.deepEqual(listAll(c, q).map((r) => r.name)[0], 'EN - Appassionata (1974)');
  assert.deepEqual(listAllSorted(c, q).map((r) => r.name),
    ['[X][B] Week Two', '[X][A] Week One', '[X][C] August', 'EN - Appassionata (1974)']);
});

test('the sorted whole list folds copies when asked', () => {
  const c = cat([
    ['ES| Youth', 8.0, '2026'],
    ['NL| Youth', 8.0, '2026'],
    ['Arafta', 10.0, '2025'],
  ]);
  const rows = listAllSorted(c, { kind: KIND.Series, sort: 'rating', dir: 'desc', oneCopy: true });
  assert.deepEqual(rows.map((r) => r.name), ['Arafta', 'ES| Youth']);
});
