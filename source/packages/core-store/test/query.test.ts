/**
 * The read model, over a fixture small enough to reason about by hand.
 *
 * The cases here are the ones where a client-side reimplementation of a SQL read
 * model actually goes wrong: prefix matching that is a string prefix instead of a
 * path prefix, NULLs sorting to the wrong end, counts that come from a stored
 * total instead of the rows, and an empty include-list meaning "everything"
 * instead of "nothing".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND, buildColumns, buildText, compactQuery, getItem, listCategories, listFacets, listGroups,
  listItems, listMarkets, pathHasPrefix, readText, search, viewItem,
  type Catalogue, type CategoryRow, type ItemDraft,
} from '../src/index.ts';

const cat = (id: number, kind: number, name: string, path: string[], over: Partial<CategoryRow> = {}): CategoryRow => ({
  id, kind, remoteId: String(id), name, cleanName: name, genres: [], region: null, source: null,
  path, itemCount: 0, sortIndex: id, ...over,
});

const draft = (over: Partial<ItemDraft> = {}): ItemDraft => ({
  kind: KIND.Movie, streamId: 1, categoryId: 1, name: 'A film', logo: null,
  compactName: 'afilm', normName: 'a film', ext: 'mp4', tvgId: null, url: null,
  archive: false, archiveDays: 0,
  adult: false, direct: false, rating: 7, year: '2020', added: 1000, sortIndex: 0, ...over,
});

function fixture(drafts: ItemDraft[], categories: CategoryRow[]): Catalogue {
  return {
    generation: 1,
    builtAt: 0,
    items: buildColumns(drafts),
    categories,
    counts: { live: 0, movies: drafts.length, series: 0 },
  };
}

test('a text column round-trips every value, including the first and last', () => {
  const col = buildText(['alpha', '', 'omega']);
  assert.equal(readText(col, 0), 'alpha');
  assert.equal(readText(col, 1), '');
  assert.equal(readText(col, 2), 'omega');
});

test('a newline inside a value cannot shift the column', () => {
  const col = buildText(['one\ntwo', 'after']);
  assert.equal(readText(col, 0), 'one two');
  assert.equal(readText(col, 1), 'after', 'the row after a dirty value must still be readable');
});

test('numbers survive the trip through typed arrays', () => {
  const c = buildColumns([draft({ rating: 7.4, year: '1994', archiveDays: 3, archive: true })]);
  const v = viewItem(c, 0);
  assert.equal(v.rating, 7.4);
  assert.equal(v.year, '1994');
  assert.equal(v.archiveDays, 3);
  assert.equal(v.archive, true);
  assert.equal(v.adult, false);
});

test('a rating above the column can hold does not wrap around', () => {
  const c = buildColumns([draft({ rating: 99999 })]);
  assert.ok((viewItem(c, 0).rating ?? 0) > 100, 'clamped, not overflowed');
});

test('an absent value reads as null rather than as zero', () => {
  const c = buildColumns([draft({ rating: null, year: null, streamId: null, ext: null, logo: null })]);
  const v = viewItem(c, 0);
  assert.equal(v.rating, null);
  assert.equal(v.year, null);
  assert.equal(v.streamId, null);
  assert.equal(v.ext, null);
  assert.equal(v.logo, null);
});

test('the extension dictionary maps back to the right string', () => {
  const c = buildColumns([draft({ ext: 'mkv' }), draft({ ext: 'mp4' }), draft({ ext: 'mkv' })]);
  assert.deepEqual([0, 1, 2].map((i) => viewItem(c, i).ext), ['mkv', 'mp4', 'mkv']);
});

test('a path prefix is a PATH prefix: EN matches EN/NETFLIX and never ENGLISH', () => {
  assert.equal(pathHasPrefix(['EN', 'NETFLIX'], ['EN']), true);
  assert.equal(pathHasPrefix(['ENGLISH'], ['EN']), false);
  assert.equal(pathHasPrefix(['EN'], ['EN', 'NETFLIX']), false);
  assert.equal(pathHasPrefix(['EN'], []), false);
});

test('a market filter cannot leak a similarly named market', () => {
  const c = fixture(
    [draft({ categoryId: 1, name: 'EN one' }), draft({ categoryId: 2, name: 'ENGLISH one' })],
    [cat(1, KIND.Movie, 'EN | A', ['EN', 'A']), cat(2, KIND.Movie, 'ENGLISH | B', ['ENGLISH', 'B'])],
  );
  const page = listItems(c, { kind: KIND.Movie, paths: ['EN'] });
  assert.equal(page.total, 1);
  assert.equal(page.rows[0]!.name, 'EN one');
});

test('hidden paths beat included ones, at any depth', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 })],
    [cat(1, KIND.Movie, 'a', ['EN', 'KIDS']), cat(2, KIND.Movie, 'b', ['EN', 'NEWS'])],
  );
  assert.equal(listItems(c, { kind: KIND.Movie, paths: ['EN'] }).total, 2);
  assert.equal(listItems(c, { kind: KIND.Movie, paths: ['EN'], hidePaths: ['EN/KIDS'] }).total, 1);
  assert.equal(listItems(c, { kind: KIND.Movie, paths: ['EN'], hidePaths: ['EN'] }).total, 0);
});

test('two story genres AND, and a compound category is what satisfies them', () => {
  /* The catalogue this is modelled on names categories in compounds —
     "|EN| HORROR/THRILLER", "|EN| DRAMA/COMEDY" — and `deriveFacets` collects
     every rule that matches, so a category really can be both. 26 of 365 movie
     categories are, covering 11,946 titles. */
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 }), draft({ categoryId: 3 })],
    [
      cat(1, KIND.Movie, 'a', ['EN'], { genres: ['drama'] }),
      cat(2, KIND.Movie, 'b', ['EN'], { genres: ['thriller'] }),
      cat(3, KIND.Movie, 'c', ['EN'], { genres: ['drama', 'thriller'] }),
    ],
  );
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['drama'] }).total, 2);
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['thriller'] }).total, 2);
  /* The report: this was 3 under any-of — adding a second genre grew the grid.
     Measured on the live catalogue as Thriller 4,761 -> 5,093 with Horror. */
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['drama', 'thriller'] }).total, 1);
});

test('a combination nothing satisfies is empty, not everything', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 })],
    [
      cat(1, KIND.Movie, 'a', ['EN'], { genres: ['family'] }),
      cat(2, KIND.Movie, 'b', ['EN'], { genres: ['crime'] }),
    ],
  );
  /* "the shown movies don't have both family and crime, but I see them both" —
     they were both shown because this was 2. No film here is both, so nothing
     is the honest answer. */
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['family', 'crime'] }).total, 0);
});

test('a chip that would empty the grid still says so, at zero', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 })],
    [
      cat(1, KIND.Movie, 'a', ['EN'], { genres: ['family'] }),
      cat(2, KIND.Movie, 'b', ['EN'], { genres: ['crime'] }),
    ],
  );
  const chips = listFacets(c, { kind: KIND.Movie, genres: ['family'] }).genres;
  const crime = chips.find((g) => g.id === 'crime');
  /* Present, and zero. A chip that vanishes when you press its neighbour is a
     strip you cannot learn; the zero is what tells you not to press. */
  assert.equal(crime?.count, 0);
  assert.equal(chips.find((g) => g.id === 'family')?.count, 1);
});

test('a refinement ANDs against the kinds, so adding one never widens', () => {
  const c = fixture(
    [
      draft({ categoryId: 1 }), draft({ categoryId: 2 }), draft({ categoryId: 3 }),
    ],
    [
      cat(1, KIND.Movie, 'a', ['EN'], { genres: ['fourk'] }),
      cat(2, KIND.Movie, 'b', ['EN'], { genres: ['documentary'] }),
      cat(3, KIND.Movie, 'c', ['EN'], { genres: ['documentary', 'fourk'] }),
    ],
  );
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['fourk'] }).total, 2);
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['documentary'] }).total, 2);
  /* The whole report: this was 3 — pressing 4K on top of Documentary gave MORE
     films than Documentary alone. It is the ONE that is both. */
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['documentary', 'fourk'] }).total, 1);
});

test('one rule for every chip: drama AND thriller AND 4K', () => {
  const c = fixture(
    [
      draft({ categoryId: 1 }), draft({ categoryId: 2 }),
      draft({ categoryId: 3 }), draft({ categoryId: 4 }),
    ],
    [
      cat(1, KIND.Movie, 'a', ['EN'], { genres: ['drama', 'thriller', 'fourk'] }),
      cat(2, KIND.Movie, 'b', ['EN'], { genres: ['drama', 'thriller'] }),
      cat(3, KIND.Movie, 'c', ['EN'], { genres: ['drama', 'fourk'] }),
      cat(4, KIND.Movie, 'd', ['EN'], { genres: ['comedy', 'fourk'] }),
    ],
  );
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['drama'] }).total, 3);
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['drama', 'thriller'] }).total, 2);
  /* Story chips and refinements no longer combine by different rules, so each
     press can only ever narrow. 3 -> 2 -> 1, never up. */
  assert.equal(
    listItems(c, { kind: KIND.Movie, genres: ['drama', 'thriller', 'fourk'] }).total,
    1,
  );
});

test('two refinements both have to hold', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 }), draft({ categoryId: 3 })],
    [
      cat(1, KIND.Movie, 'a', ['EN'], { genres: ['classic', 'fourk'] }),
      cat(2, KIND.Movie, 'b', ['EN'], { genres: ['classic'] }),
      cat(3, KIND.Movie, 'c', ['EN'], { genres: ['fourk'] }),
    ],
  );
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['classic', 'fourk'] }).total, 1);
});

test('a refinement on its own is a whole selection, not an empty one', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 })],
    [
      cat(1, KIND.Movie, 'a', ['EN'], { genres: ['fourk'] }),
      cat(2, KIND.Movie, 'b', ['EN'], { genres: ['drama'] }),
    ],
  );
  assert.equal(listItems(c, { kind: KIND.Movie, genres: ['fourk'] }).total, 1);
});

test('an empty streamIds list means nothing, not everything', () => {
  const c = fixture([draft({ streamId: 5 })], [cat(1, KIND.Movie, 'a', ['EN'])]);
  assert.equal(listItems(c, { kind: KIND.Movie, streamIds: [] }).total, 0);
  assert.equal(listItems(c, { kind: KIND.Movie, streamIds: [5] }).total, 1);
  assert.equal(listItems(c, { kind: KIND.Movie }).total, 1);
});

test('excludeStreams leaves those channels out of the list AND the package counts', () => {
  const c = fixture(
    [draft({ streamId: 5, categoryId: 1 }), draft({ streamId: 6, categoryId: 1 }), draft({ streamId: 7, categoryId: 2 })],
    [cat(1, KIND.Movie, 'a', ['EN']), cat(2, KIND.Movie, 'b', ['EN'])],
  );
  const sport = new Set([6, 7]);
  assert.deepEqual(listItems(c, { kind: KIND.Movie, excludeStreams: sport }).rows.map((r) => r.streamId), [5]);
  /* A package whose every row is left out disappears, like any empty package. */
  assert.deepEqual(
    listCategories(c, { kind: KIND.Movie, excludeStreams: sport }).map((x) => [x.id, x.count]),
    [[1, 1]],
  );
  /* And it composes with the other scope: ANDed, never widening. */
  assert.equal(listItems(c, { kind: KIND.Movie, excludeStreams: sport, streamIds: [5, 6] }).total, 1);
});

test('rows with no year or rating sort LAST in a descending list', () => {
  const c = fixture(
    [
      draft({ name: 'has year', year: '2001', rating: 5 }),
      draft({ name: 'no year', year: null, rating: null }),
      draft({ name: 'newer', year: '2011', rating: 9 }),
    ],
    [cat(1, KIND.Movie, 'a', ['EN'])],
  );
  assert.deepEqual(
    listItems(c, { kind: KIND.Movie, sort: 'year', dir: 'desc' }).rows.map((r) => r.name),
    ['newer', 'has year', 'no year'],
  );
  assert.deepEqual(
    listItems(c, { kind: KIND.Movie, sort: 'rating', dir: 'desc' }).rows.map((r) => r.name),
    ['newer', 'has year', 'no year'],
  );
});

test('the epg sort puts channels with a tvg id first', () => {
  const c = fixture(
    [
      draft({ kind: KIND.Live, name: 'placeholder', tvgId: null, sortIndex: 0 }),
      draft({ kind: KIND.Live, name: 'TF1', tvgId: 'TF1.fr', sortIndex: 9 }),
    ],
    [cat(1, KIND.Live, 'a', ['FR'])],
  );
  assert.deepEqual(
    listItems(c, { kind: KIND.Live, sort: 'epg' }).rows.map((r) => r.name),
    ['TF1', 'placeholder'],
  );
});

test('every section defaults to the provider\u2019s own order, series included', () => {
  /*
   * "they all come in the selected order from the provider itself, I mean from
   * the panel." Films and channels always did; series were re-alphabetised on
   * the way out, for server parity with a server that no longer exists. The
   * panel's order is the one the operator arranged, so it is the default, and
   * A\u2013Z is still there as a choice.
   */
  const rows = [
    draft({ kind: KIND.Series, name: 'Zulu Dawn', sortIndex: 0, categoryId: 1 }),
    draft({ kind: KIND.Series, name: 'Adolescence', sortIndex: 1, categoryId: 1 }),
    draft({ kind: KIND.Series, name: 'Mad Men', sortIndex: 2, categoryId: 1 }),
  ];
  const c = fixture(rows, [cat(1, KIND.Series, 'a', ['EN'])]);
  assert.deepEqual(
    listItems(c, { kind: KIND.Series }).rows.map((r) => r.name),
    ['Zulu Dawn', 'Adolescence', 'Mad Men'],
    'the panel put the new arrival at the top; it stays at the top',
  );
  assert.deepEqual(
    listItems(c, { kind: KIND.Series, sort: 'name' }).rows.map((r) => r.name),
    ['Adolescence', 'Mad Men', 'Zulu Dawn'],
    'A\u2013Z is still a choice, it is just no longer the one nobody asked for',
  );
});

test('search needs two characters of substance and finds substrings', () => {
  const c = fixture(
    [draft({ name: "Grey's Anatomy", compactName: 'greysanatomy' })],
    [cat(1, KIND.Movie, 'a', ['EN'])],
  );
  assert.equal(compactQuery('!!'), '');
  assert.equal(search(c, '!!').movies.length, 0, 'punctuation is not a query');
  assert.equal(search(c, 'greys').movies.length, 1);
  assert.equal(search(c, "grey's an").movies.length, 1);
});

test('category counts come from the rows in scope, not from a stored total', () => {
  const c = fixture(
    [draft({ categoryId: 1, adult: false }), draft({ categoryId: 1, adult: true })],
    [cat(1, KIND.Movie, 'mixed', ['EN'], { itemCount: 999 })],
  );
  assert.equal(listCategories(c, { kind: KIND.Movie })[0]!.count, 1, 'the adult row is never counted');
});

test('a parent group counts everything beneath it', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 }), draft({ categoryId: 3 })],
    [
      cat(1, KIND.Movie, 'a', ['EN', 'KIDS']),
      cat(2, KIND.Movie, 'b', ['EN', 'NEWS']),
      cat(3, KIND.Movie, 'c', ['FR']),
    ],
  );
  const { tree, total, ungrouped } = listGroups(c, { kind: KIND.Movie });
  assert.equal(total, 3);
  assert.equal(ungrouped, 0);
  const en = tree.find((n) => n.id === 'EN')!;
  assert.equal(en.count, 2);
  assert.deepEqual(en.children.map((n) => n.id).sort(), ['EN/KIDS', 'EN/NEWS']);
  assert.equal(tree.find((n) => n.id === 'FR')!.count, 1);
});

test('markets are depth-1 of the tree', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 })],
    [cat(1, KIND.Movie, 'a', ['EN', 'KIDS']), cat(2, KIND.Movie, 'b', ['FR'])],
  );
  const markets = listMarkets(c, { kind: KIND.Movie });
  assert.deepEqual(markets.map((m) => m.id), ['EN', 'FR']);
  assert.deepEqual(markets.find((m) => m.id === 'EN')!.categories, [1]);
});

test('the genre facet ignores the genre selection; region narrows with it', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 })],
    [
      cat(1, KIND.Movie, 'a', ['EN'], { genres: ['drama'], region: 'EN' }),
      cat(2, KIND.Movie, 'b', ['FR'], { genres: ['comedy'], region: 'FR' }),
    ],
  );
  const f = listFacets(c, { kind: KIND.Movie, genres: ['drama'] });
  assert.deepEqual(f.genres.map((g) => g.id).sort(), ['comedy', 'drama'], 'both chips stay offerable');
  assert.deepEqual(f.regions.map((r) => r.id), ['EN'], 'region narrows to the selection');
});

test('the 18 market is always excluded, with no query able to opt back in', () => {
  const c = fixture(
    [draft({ categoryId: 1 }), draft({ categoryId: 2 })],
    [cat(1, KIND.Movie, 'clean', ['EN']), cat(2, KIND.Movie, 'adult', ['18'])],
  );
  assert.equal(listItems(c, { kind: KIND.Movie }).total, 1);
  assert.equal(listItems(c, { kind: KIND.Movie, paths: ['18'] }).total, 0);
});

test('paging is stable and total counts the whole match, not the page', () => {
  const c = fixture(
    Array.from({ length: 25 }, (_, i) => draft({ name: `Film ${String(i).padStart(2, '0')}`, sortIndex: i })),
    [cat(1, KIND.Movie, 'a', ['EN'])],
  );
  const first = listItems(c, { kind: KIND.Movie, limit: 10 });
  const second = listItems(c, { kind: KIND.Movie, limit: 10, offset: 10 });
  assert.equal(first.total, 25);
  assert.equal(second.total, 25);
  assert.equal(first.rows.length, 10);
  assert.equal(new Set([...first.rows, ...second.rows].map((r) => r.id)).size, 20);
});

test('getItem is bounds-checked, because the row index IS the id', () => {
  const c = fixture([draft({ name: 'only' })], [cat(1, KIND.Movie, 'a', ['EN'])]);
  assert.equal(getItem(c, 0)?.name, 'only');
  assert.equal(getItem(c, 1), null);
  assert.equal(getItem(c, -1), null);
  assert.equal(getItem(c, 1.5), null);
});

test('"Just added" keeps only what the panel added since the instant asked for', () => {
  const c = fixture([
    draft({ streamId: 1, name: 'Old', added: 1_000 }),
    draft({ streamId: 2, name: 'Last week', added: 5_000 }),
    draft({ streamId: 3, name: 'Today', added: 9_000 }),
    draft({ streamId: 4, name: 'Unknown', added: 0 }),
  ], [cat(1, KIND.Movie, 'EN| FILMS', ['EN', 'FILMS'])]);
  const got = listItems(c, { kind: KIND.Movie, addedSince: 5_000, sort: 'added', dir: 'desc' });
  assert.deepEqual(got.rows.map((r) => r.name), ['Today', 'Last week']);
});
