/**
 * The search engine, on a fixture small enough to reason about by hand.
 *
 * These are the cases where a search built for a remote control actually goes
 * wrong, rather than a re-test of `indexOf`:
 *
 *   * the words of a query being treated as an ordered phrase, which is the bug
 *     that made "knight dark" and "the office uk" find nothing;
 *   * an edit budget generous enough to turn every three-letter word into every
 *     other three-letter word;
 *   * a bounded distance function whose band leaks a stale value from two rows
 *     ago and reports a near-match as exact;
 *   * a prefilter that rejects a real correction — the transposition case, which
 *     a two-bigrams-per-edit bound gets wrong and which is the single commonest
 *     typing mistake there is;
 *   * a ranking that is a filter with extra steps, so the right row is on the
 *     page but thirty places down;
 *   * an order that is not total, so the results reshuffle under the highlight
 *     between one keystroke and the next.
 *
 * The performance guard at the bottom is a test rather than a comment because
 * the measurements this design rests on were taken against 266,141 rows on a
 * development box, and the thing that has to stay true on a cheap television is
 * the SHAPE of the cost — one blob sweep, not one pass per row — which a fixture
 * can pin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVIDENCE, KIND, boundedDistance, buildColumns, buildWordIndex, buildWordIndexSteps,
  compareHits, correctToken,
  editBudget, knowsWord, matchRows, readText, rowAtOffset, scoreRow, search, searchAll, tokenise,
  type Catalogue, type CategoryRow, type ItemDraft, type SearchHit,
} from '../src/index.ts';
import { compactName, normName } from '@iptv/core-xtream';

const cat = (id: number, kind: number, name: string, path: string[]): CategoryRow => ({
  id, kind, remoteId: String(id), name, cleanName: name, genres: [], region: null, source: null,
  path, itemCount: 0, sortIndex: id,
});

/**
 * A row built the way `build.ts` builds one.
 *
 * The compact and norm keys are DERIVED here rather than written by hand, for
 * the same reason the real builder derives them: a test that hand-writes
 * "thedarkknight" is testing the search against a catalogue nobody has, and the
 * first thing it would stop catching is a change to the normalisation.
 */
const row = (name: string, over: Partial<ItemDraft> = {}): ItemDraft => ({
  kind: KIND.Movie, streamId: 1, categoryId: 1, name, logo: null,
  compactName: compactName(name).toLowerCase(), normName: normName(name),
  ext: 'mp4', tvgId: null, url: null, archive: false, archiveDays: 0,
  adult: false, direct: false, rating: null, year: null, added: 0, sortIndex: 0,
  ...over,
});

function fixture(drafts: ItemDraft[], categories: CategoryRow[] = [cat(1, KIND.Movie, 'films', ['EN'])]): Catalogue {
  return {
    generation: 1,
    builtAt: 0,
    items: buildColumns(drafts.map((d, i) => ({ ...d, streamId: i + 1, sortIndex: i }))),
    categories,
    counts: { live: 0, movies: drafts.length, series: 0 },
  };
}

const names = (hits: SearchHit[]): string[] => hits.map((h) => h.name);

/* ── tokenisation ───────────────────────────────────────────────────────────── */

test('a query is words, not a phrase — and the longest word comes first', () => {
  /* Longest first is load-bearing: it is the token the engine sweeps the blob
     for, and sweeping for the least selective word does the same work in the
     worst possible order. */
  assert.deepEqual(tokenise('dark knight'), ['knight', 'dark']);
  assert.deepEqual(tokenise('The Office UK'), ['office', 'the', 'uk']);
});

test('tokenising folds accents and punctuation the way the columns are folded', () => {
  assert.deepEqual(tokenise("Grey's Anatomy"), ['anatomy', 'grey', 's']);
  assert.deepEqual(tokenise('Amélie'), ['amelie']);
  assert.deepEqual(tokenise('  —  '), []);
});

test('a repeated word is one token, so it is swept and scored once', () => {
  assert.deepEqual(tokenise('the the'), ['the']);
});

test('two tokens of equal length always come out in the same order', () => {
  /* Not cosmetic. An unspecified order here decides which token drives the
     sweep, and two different sweeps can rank the same query two ways. */
  assert.deepEqual(tokenise('bad mad'), tokenise('mad bad'));
});

/* ── distance ──────────────────────────────────────────────────────────────── */

test('a transposition is ONE edit, which is why this is Damerau and not Levenshtein', () => {
  assert.equal(boundedDistance('kngiht', 'knight', 2), 1);
  assert.equal(boundedDistance('kngiht', 'knight', 1), 1, 'and it fits inside a six-letter budget');
});

test('the budget is honoured exactly, and anything past it reports max + 1', () => {
  assert.equal(boundedDistance('avengrs', 'avengers', 2), 1);
  assert.equal(boundedDistance('shwshank', 'shawshank', 2), 1);
  assert.equal(boundedDistance('cat', 'dog', 1), 2, 'over budget is max + 1, not the true distance');
  assert.equal(boundedDistance('abc', 'abcdef', 2), 3, 'a length gap wider than the budget exits early');
});

test('identical strings are zero at every budget, including a budget of none', () => {
  assert.equal(boundedDistance('knight', 'knight', 0), 0);
  assert.equal(boundedDistance('knight', 'knights', 0), 1, 'a budget of 0 admits nothing else');
});

test('the band does not leak a value from two rows ago', () => {
  /*
   * The bug this pins: the rolling buffers are reused, so a cell outside the
   * current band still holds a real number from three rows back. Without the
   * walls either side of the band, "aaaaaaaaab" against "baaaaaaaaa" — two edits
   * apart at the ends and identical in the middle — reads as one, because the
   * recurrence picks up a stale in-band value as though it were reachable.
   */
  assert.equal(boundedDistance('aaaaaaaaab', 'baaaaaaaaa', 2), 2);
  assert.equal(boundedDistance('aaaaaaaaab', 'baaaaaaaaa', 1), 2, 'and is over budget at 1');
  // Against a brute-force check on a handful of pairs the band could get wrong.
  for (const [a, b, d] of [
    ['abcdef', 'abcdef', 0], ['abcdef', 'abcdfe', 1], ['abcdef', 'abdcef', 1],
    ['abcdef', 'bacdfe', 2], ['abcdef', 'abcdefg', 1], ['abcdef', 'bcdef', 1],
    ['abcdef', 'xbcdex', 2], ['sunday', 'saturday', 3],
  ] as const) {
    assert.equal(boundedDistance(a, b, 3), Math.min(d, 4), `${a} -> ${b}`);
  }
});

/* ── the budget curve ──────────────────────────────────────────────────────── */

test('short words are exact, because one edit turns every one of them into another', () => {
  assert.equal(editBudget(2), 0, '"uk" means "uk"');
  assert.equal(editBudget(3), 0, '"cat" must not become "car", "cut" and "bat"');
  assert.equal(editBudget(4), 1);
  assert.equal(editBudget(6), 1);
  assert.equal(editBudget(7), 2);
  assert.equal(editBudget(14), 2, 'the budget stops at two however long the word is');
});

/* ── the dictionary ────────────────────────────────────────────────────────── */

test('a typo finds the real word, and the commonest reading comes first', () => {
  const c = fixture([
    row('The Dark Knight'), row('Dark Waters'), row('Dark Phoenix'), row('Darcy'),
    row('Breaking Bad'), row('Brewing Storm'),
  ]);
  const index = buildWordIndex(c);
  /* "dark" occurs three times and "darcy" once, so the tie at distance 1 breaks
     towards the word the catalogue actually contains a lot of. */
  assert.equal(correctToken(index, 'darck', 1)[0]?.word, 'dark');
  assert.equal(correctToken(index, 'breking', 2)[0]?.word, 'breaking');
});

test('the prefilters never reject a correction the distance function would accept', () => {
  /*
   * The bigram prefilter bounds how many adjacent pairs an edit can destroy, and
   * a transposition destroys THREE — the two pairs either side plus the pair it
   * swaps. Bounded at two, "kngiht" was rejected before `boundedDistance` was
   * ever called: it shares only `kn` and `ht` with "knight". A one-sided filter
   * that rejects the commonest typo in existence is worse than no filter.
   */
  const c = fixture([row('The Dark Knight'), row('Jennifer Aniston'), row('Shawshank')]);
  const index = buildWordIndex(c);
  assert.deepEqual(correctToken(index, 'kngiht', 1).map((x) => x.word), ['knight']);
  assert.deepEqual(correctToken(index, 'anistn', 1).map((x) => x.word), ['aniston']);
  assert.deepEqual(correctToken(index, 'shwshank', 2).map((x) => x.word), ['shawshank']);
});

test('a word too short to index can never be corrected into something else', () => {
  const c = fixture([row('Cat'), row('Car'), row('Bat')]);
  const index = buildWordIndex(c);
  assert.deepEqual(correctToken(index, 'cat', editBudget(3)), []);
});

test('a word the catalogue contains is not a typo, however few rows it matches', () => {
  /*
   * The bug this pins reached the screen. "sky news" matches three real channels
   * on the live catalogue — under the thin-answer floor — so the correction pass
   * ran, decided "news" could have been "new", and filled the MOVIES block with
   * two dozen films whose titles contain "new" and "sky". A search for a news
   * channel answered with adult films, because the answer it already had was
   * SMALL rather than WRONG.
   */
  const c = fixture([
    row('SKY NEWS ARABIA', { kind: KIND.Live }),
    row('A New Year To Remember'), row('New Profile'), row('Sky High New Day'),
  ], [cat(1, KIND.Live, 'news', ['EN']), cat(1, KIND.Movie, 'films', ['EN'])]);
  const index = buildWordIndex(c);
  assert.equal(knowsWord(index, 'news'), true);
  assert.equal(knowsWord(index, 'avengrs'), false);
  const found = searchAll(c, 'sky news', { index });
  assert.equal(found.corrected, false, 'nothing to correct');
  assert.deepEqual(names(found.live), ['SKY NEWS ARABIA']);
  assert.deepEqual(found.movies, [], 'and no films about a new year');
});

test('a known word IS corrected once nothing at all has matched', () => {
  /*
   * The other half of the rule. "Jenifer" is a real spelling somewhere in a
   * 266,141-row catalogue, so the first round leaves it alone and "jenifer
   * anistn" corrects only the surname — still matching no row. Zero results is
   * the one state where guessing at a word the catalogue does know cannot spoil
   * an answer, because there is no answer to spoil.
   */
  const c = fixture(
    [
      row('EN - Friends (1994)', { kind: KIND.Series, cast: 'Jennifer Aniston, Courteney Cox' }),
      row('EN - Jenifer (2002)', { kind: KIND.Series, cast: 'Nobody' }),
    ],
    [cat(1, KIND.Series, 'series', ['EN'])],
  );
  const index = buildWordIndex(c);
  assert.equal(knowsWord(index, 'jenifer'), true, 'the misspelling is in the data');
  const found = searchAll(c, 'jenifer anistn', { index });
  assert.deepEqual(names(found.series), ['EN - Friends (1994)']);
  assert.equal(found.corrected, true);
});

/* ── ranking ───────────────────────────────────────────────────────────────── */

test('an exact prefix beats a word start beats a substring', () => {
  const cols = fixture([
    row('Knight Rider'),      // the title begins with it
    row('The Dark Knight'),   // a word begins with it
    row('Moonknight Rises'),  // it is inside a word
  ]).items;
  const terms = [[{ word: 'knight', distance: 0 }]];
  const head = scoreRow(cols, 0, terms, 'knight')!;
  const word = scoreRow(cols, 1, terms, 'knight')!;
  const mid = scoreRow(cols, 2, terms, 'knight')!;
  assert.ok(head.score > word.score, 'a title that starts with the word wins');
  assert.ok(word.score > mid.score, 'a word start beats a fragment inside a word');
});

test('a title holding the finished word beats one that merely starts with it', () => {
  /*
   * The correction the conformance diff forced. Ranked the other way, a search
   * for "grey" answered with five Greyhounds and put "The Grey" eighth — every
   * row that begins with the letters typed outranking every row that contains
   * the word. Both readings are real while somebody is mid-word, so both score
   * well; the finished word scores higher.
   */
  const cols = fixture([
    row("Grey's Anatomy"),  // begins with it AND it is a whole word there
    row('The Grey'),        // a whole word, further in
    row('Greyhound'),       // begins with it, part-way into a longer word
    row('In The Greyhound'),// a word starts with it, part-way in
  ]).items;
  const terms = [[{ word: 'grey', distance: 0 }]];
  const score = (r: number) => scoreRow(cols, r, terms, 'grey')!.score;
  assert.ok(score(0) > score(1), 'the head, whole, is the top rung');
  assert.ok(score(1) > score(2), 'a whole word beats a partial prefix at the head');
  assert.ok(score(2) > score(3), 'and the head still beats a word further in');
});

test('an exact match beats a corrected one however good the corrected one looks', () => {
  /*
   * The rule stated as arithmetic. "Knight Rider" begins with the corrected word
   * and would score the maximum on evidence alone; "The Dark Knight" only
   * carries the typed word mid-title. Typed correctly still has to win, because
   * a viewer who spelled it right has told us more than one who did not.
   */
  const cols = fixture([row('Knight Rider'), row('The Dark Knight')]).items;
  const corrected = scoreRow(cols, 0, [[{ word: 'knigt', distance: 0 }, { word: 'knight', distance: 1 }]], '');
  const exact = scoreRow(cols, 1, [[{ word: 'knight', distance: 0 }]], '');
  assert.equal(corrected!.exact, false);
  assert.equal(exact!.exact, true);
  assert.ok(exact!.score > corrected!.score);
});

test('every token has to match — a row missing one is not a weak answer', () => {
  const cols = fixture([row('The Dark Knight'), row('Dark Waters')]).items;
  const terms = [[{ word: 'knight', distance: 0 }], [{ word: 'dark', distance: 0 }]];
  assert.notEqual(scoreRow(cols, 0, terms, 'darkknight'), null);
  assert.equal(scoreRow(cols, 1, terms, 'darkknight'), null, 'has "dark", has no "knight"');
});

test('the words together outrank the same words scattered', () => {
  const cols = fixture([
    row('The Dark Knight'),
    row('Dark Water and the Knight of Cups'),
  ]).items;
  const terms = [[{ word: 'knight', distance: 0 }], [{ word: 'dark', distance: 0 }]];
  const together = scoreRow(cols, 0, terms, 'darkknight')!;
  const scattered = scoreRow(cols, 1, terms, 'darkknight')!;
  assert.ok(together.score > scattered.score);
});

test('the order is TOTAL, so one query has exactly one answer', () => {
  /*
   * The rule the whole screen depends on: results must not reshuffle under the
   * highlight while somebody is still typing. Two rows with the same score and
   * the same name are separated by the row index and nothing else, and the row
   * index is unique by construction.
   */
  const a: SearchHit = { row: 7, score: 1005, exact: true, name: 'Dark' };
  const b: SearchHit = { row: 3, score: 1005, exact: true, name: 'Dark' };
  assert.ok(compareHits(a, b) > 0);
  assert.ok(compareHits(b, a) < 0);
  assert.equal(compareHits(a, a), 0);
  assert.equal(EVIDENCE.titleHead > EVIDENCE.castWord, true, 'a title outranks a credit');
  assert.equal(EVIDENCE.castWord > EVIDENCE.titleMid, true, 'a named actor outranks a fragment');
});

/* ── the engine, end to end ────────────────────────────────────────────────── */

test('"each space": the words may arrive in any order', () => {
  const c = fixture([row('The Dark Knight Rises'), row('Knight and Day'), row('Dark Waters')]);
  assert.deepEqual(names(searchAll(c, 'dark knight').movies), ['The Dark Knight Rises']);
  assert.deepEqual(
    names(searchAll(c, 'knight dark').movies),
    ['The Dark Knight Rises'],
    'the old compacted-substring search found nothing for this',
  );
});

test('the country the panel writes after the year is still findable', () => {
  /* "The Office (US)" — the token order in the title is office, then the year,
     then the country, so a phrase search for "the office us" matches nothing.
     Three tokens in any order match it. */
  const c = fixture([row('EN - The Office (2005) (US)'), row('EN - The Office (2001) (UK)')]);
  assert.deepEqual(names(searchAll(c, 'the office uk').movies), ['EN - The Office (2001) (UK)']);
});

test('a mistyped title is found, and only when an index has been built', () => {
  const c = fixture([row('The Shawshank Redemption'), row('The Dark Knight')]);
  assert.deepEqual(searchAll(c, 'shwshank').movies, [], 'no dictionary, no correction');
  const found = searchAll(c, 'shwshank', { index: buildWordIndex(c) });
  assert.deepEqual(names(found.movies), ['The Shawshank Redemption']);
  assert.equal(found.corrected, true, 'and the caller can tell it was corrected');
});

test('a correction never replaces the exact answer it was meant to widen', () => {
  const c = fixture([row('Dark'), row('Darcy Lane')]);
  const found = searchAll(c, 'dark', { index: buildWordIndex(c) });
  assert.equal(found.movies[0]?.name, 'Dark', 'the typed word still wins the top slot');
  assert.equal(found.movies[0]?.exact, true);
});

test('one letter is not a search', () => {
  const c = fixture([row('Dark')]);
  assert.deepEqual(searchAll(c, 'd').movies, []);
  assert.deepEqual(searchAll(c, '!!').movies, [], 'and punctuation is not a query');
});

/* ── cast ──────────────────────────────────────────────────────────────────── */

test('a series is found by an actor who is nowhere in its title', () => {
  /*
   * The measured shape of the data, and the reason this feature exists at all:
   * `get_series` carries a `cast` field on all 45,140 of this panel's series and
   * `get_vod_streams` carries none on any of its 211,168 films. So cast search
   * is real for series and is whatever the title says for films.
   */
  const c = fixture(
    [
      row('EN - Friends (1994)', { kind: KIND.Series, cast: 'Jennifer Aniston, Courteney Cox, Matt LeBlanc' }),
      row('EN - Breaking Bad (2008)', { kind: KIND.Series, cast: 'Bryan Cranston, Aaron Paul' }),
    ],
    [cat(1, KIND.Series, 'series', ['EN'])],
  );
  assert.deepEqual(names(searchAll(c, 'aniston').series), ['EN - Friends (1994)']);
  assert.deepEqual(names(searchAll(c, 'bryan cranston').series), ['EN - Breaking Bad (2008)']);
  assert.deepEqual(names(searchAll(c, 'cranston aniston').series), [], 'both, or neither');
});

test('a title match outranks a cast credit for the same word', () => {
  const c = fixture(
    [
      row('EN - Cranston (2019)', { kind: KIND.Series, cast: 'Nobody At All' }),
      row('EN - Breaking Bad (2008)', { kind: KIND.Series, cast: 'Bryan Cranston' }),
    ],
    [cat(1, KIND.Series, 'series', ['EN'])],
  );
  assert.deepEqual(
    names(searchAll(c, 'cranston').series),
    ['EN - Cranston (2019)', 'EN - Breaking Bad (2008)'],
  );
});

test('a mistyped actor is corrected too — the dictionary holds cast words', () => {
  const c = fixture(
    [row('EN - Friends (1994)', { kind: KIND.Series, cast: 'Jennifer Aniston, Courteney Cox' })],
    [cat(1, KIND.Series, 'series', ['EN'])],
  );
  assert.deepEqual(names(searchAll(c, 'anistn', { index: buildWordIndex(c) }).series), ['EN - Friends (1994)']);
});

test('a catalogue with no cast column at all still searches', () => {
  /*
   * Every device already holding a generation has one: `cast` was added after
   * those were written and `loadCatalogue` fills it in as empty rather than
   * failing the read and forcing a 58MB re-download. Nothing may assume it is
   * there.
   */
  const c = fixture([row('The Dark Knight')]);
  assert.equal(c.items.cast.rows.length, 0);
  assert.deepEqual(names(searchAll(c, 'dark knight').movies), ['The Dark Knight']);
});

/* ── the drift gate ────────────────────────────────────────────────────────── */

test('a plain one-word search still returns everything matchRows returns', () => {
  /*
   * `sectionFilter` restates the section and adult rules that `matchRows`
   * applies, because calling `matchRows` would rescan all 266,141 rows once per
   * section and undo the point of the candidate sweep. A restatement drifts
   * unless something forbids it, so this is the something.
   *
   * A superset, not an equality: the engine also reaches rows through the cast
   * column, which `matchRows` cannot see.
   */
  const c = fixture(
    [
      row('EN - Dark Waters'), row('EN - The Dark Knight'), row('EN - Darkest Hour'),
      row('XXX - Dark Desires', { categoryId: 2, adult: true }),
      row('EN - Uncategorised Dark', { categoryId: null }),
    ],
    [cat(1, KIND.Movie, 'films', ['EN']), cat(2, KIND.Movie, 'adult', ['18'])],
  );
  {
    const expected = new Set(matchRows(c, { kind: KIND.Movie, q: 'dark' }));
    const got = new Set(searchAll(c, 'dark', { limit: 100 }).movies.map((h) => h.row));
    for (const r of expected) {
      assert.ok(got.has(r), `matchRows kept ${readText(c.items.names, r)} and the engine dropped it`);
    }
    assert.equal(got.has(3), false, 'the adult row is excluded exactly as matchRows excludes it');
    assert.ok(got.has(4), 'a row with no category survives an exclude, as the SQL does');
  }
});

test('the paged wrapper is the ranked engine, materialised', () => {
  const c = fixture([row('Dark'), row('The Dark Knight')]);
  assert.deepEqual(search(c, 'dark', { limit: 1 }).movies.map((i) => i.name), ['Dark']);
});

/* ── plumbing ──────────────────────────────────────────────────────────────── */

test('a blob position resolves to its row, hint or no hint', () => {
  const cols = fixture([row('alpha'), row('beta'), row('gamma')]).items;
  const { offsets } = cols.names;
  for (let r = 0; r < 3; r++) {
    assert.equal(rowAtOffset(offsets, offsets[r]!, -1), r, 'cold');
    assert.equal(rowAtOffset(offsets, offsets[r]!, r), r, 'hinted at itself');
    assert.equal(rowAtOffset(offsets, offsets[r]!, 0), r, 'hinted at the wrong row');
  }
});

/* ── the performance guard ─────────────────────────────────────────────────── */

test('cost follows the CANDIDATES, not the catalogue', () => {
  /*
   * The measurement this design rests on, reduced to something a fixture can
   * hold. On the real catalogue (266,141 rows, a 5.76MB compact blob) the old
   * per-row `readText` + `includes` loop cost 14-18ms for one section and this
   * engine answers all three in 4-8ms, because the sweep is one native `indexOf`
   * pass and only the rows it lands on are ever read.
   *
   * What a fixture can pin is the SHAPE: adding 20,000 rows that cannot match
   * must not multiply the work. A regression to per-row scanning would show up
   * here as a ratio that climbs with the catalogue instead of staying flat, and
   * that regression is exactly what "never make typing laggy" is about — a
   * television is roughly four times slower than the box these numbers came from.
   */
  const needle = Array.from({ length: 30 }, (_, i) => row(`Zephyrine Quixotic ${i}`));
  const small = fixture([...needle, ...Array.from({ length: 1_000 }, (_, i) => row(`Filler ${i}`))]);
  const large = fixture([...needle, ...Array.from({ length: 40_000 }, (_, i) => row(`Filler ${i}`))]);

  const time = (c: Catalogue): number => {
    // Warm first: the first call pays for the JIT, not for the catalogue.
    searchAll(c, 'zephyrine quixotic');
    const runs: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      searchAll(c, 'zephyrine quixotic');
      runs.push(performance.now() - t0);
    }
    return runs.sort((a, b) => a - b)[4]!;
  };

  assert.equal(searchAll(large, 'zephyrine quixotic').movies.length, 24);
  const ratio = time(large) / Math.max(time(small), 0.02);
  assert.ok(
    ratio < 12,
    `40x the rows must not cost anywhere near 40x the time — measured ${ratio.toFixed(1)}x`,
  );
});

test('a two-letter query is bounded by the sweep, not by the cast column', () => {
  /*
   * "da" occurs in 20,636 titles and in about half of the 33,636 cast lines on
   * the live catalogue, and sweeping the cast for it added ~10,000 candidates
   * and 25ms to a query that cannot use them. The floor is three characters, and
   * this pins it: a two-letter token must not reach a row through its cast alone.
   */
  const c = fixture(
    [row('EN - Friends (1994)', { kind: KIND.Series, cast: 'Dakota Fanning' })],
    [cat(1, KIND.Series, 'series', ['EN'])],
  );
  assert.deepEqual(searchAll(c, 'da').series, [], 'two letters of a name is not a search for a person');
  assert.deepEqual(names(searchAll(c, 'dak').series), ['EN - Friends (1994)']);
});

/* ── building the dictionary without holding the thread ────────────────────── */

/**
 * The build used to be one call with nowhere to stop, and `searchIndex.ts` asks
 * for it with a two-second idle deadline — which expires while somebody who
 * pressed SEARCH is still typing. `search-probe` measured a single keystroke at
 * 4302ms against a 20ms median. These pin the two things that make the sliced
 * version safe to swap in: it produces the SAME dictionary, and a slice boundary
 * never lands inside a word.
 */
test('a sliced build produces exactly the dictionary the whole-blob build does', () => {
  const c = fixture([
    row('The Dark Knight'), row('Dark Waters'), row('Breaking Bad'),
    row('Jennifer Aniston'), row('Shawshank Redemption'), row('Brewing Storm'),
  ]);
  const whole = buildWordIndex(c);
  /* Four characters at a time: small enough that nearly every word in the
     fixture straddles a boundary, which is the case that matters. */
  const steps = buildWordIndexSteps(c, 4);
  let r = steps.next();
  let yields = 0;
  while (r.done !== true) { yields += 1; r = steps.next(); }
  const sliced = r.value;

  assert.ok(yields > 1, 'it actually sliced rather than doing it all in one go');
  assert.equal(sliced.size, whole.size);
  assert.deepEqual([...sliced.byLength.keys()].sort(), [...whole.byLength.keys()].sort());
  for (const [len, bucket] of whole.byLength) {
    const got = sliced.byLength.get(len);
    assert.ok(got !== undefined, `bucket ${len}`);
    assert.deepEqual(got.words, bucket.words, `words of length ${len}`);
    assert.deepEqual([...got.counts], [...bucket.counts], `counts of length ${len}`);
    assert.deepEqual([...got.letters], [...bucket.letters], `letters of length ${len}`);
    assert.deepEqual([...got.bigrams], [...bucket.bigrams], `bigrams of length ${len}`);
  }
});

test('a word straddling a slice boundary is one word, not two', () => {
  /* The corruption this guards against is silent and survives every other test:
     cut "knight" in the middle and the dictionary gains "kni" and "ght" and
     loses the word somebody is going to type. */
  const c = fixture([row('Knight'), row('Knight'), row('Aniston')]);
  const steps = buildWordIndexSteps(c, 3);
  let r = steps.next();
  while (r.done !== true) r = steps.next();
  const words = [...r.value.byLength.values()].flatMap((b) => b.words);
  assert.ok(words.includes('knight'), 'knight survived the cut');
  assert.ok(words.includes('aniston'), 'aniston survived the cut');
  assert.ok(!words.some((w) => 'knight'.startsWith(w) && w !== 'knight'), `no fragment of knight: ${words.join(',')}`);
  assert.equal(correctToken(r.value, 'kngiht', 1)[0]?.word, 'knight');
});
