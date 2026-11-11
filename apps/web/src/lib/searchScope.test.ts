import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveScope, facetsApply, hitsInScope, inScope, scopeChips, scopeCounts, scopeLabel, scopeOnArrival, scopeRowWorthShowing, type Scope, type ScopedHit,
} from './searchScope.ts';

const hit = (kind: ScopedHit['kind'], archive = false): ScopedHit => ({ kind, item: { archive } });

/* One channel with an archive, one without, a film and a series — the smallest
   set where Live and Catch-up can disagree. */
const MIXED: ScopedHit[] = [
  hit('live', true), hit('live'), hit('movies'), hit('series'), hit('movies'),
];

/* MIXED plus two programme hits — On TV is never derived from another kind the
   way Catch-up is, so it needs its own hits in the fixture rather than a flag on
   an existing one. */
const WITH_ONTV: ScopedHit[] = [...MIXED, hit('ontv'), hit('ontv')];

/* ── which chip is lit on arrival ─────────────────────────────────────────── */

test('the section you were standing in is the scope you land on', () => {
  assert.equal(scopeOnArrival(null, 'movies'), 'movies');
  assert.equal(scopeOnArrival(null, 'series'), 'series');
  assert.equal(scopeOnArrival(null, 'live'), 'live');
});

/* `from` is a nav TAB, so it still knows what `sectionForPath` folds away: the
   guide is live television, and catch-up is the one place where the tab carries
   the thing the section threw out. */
test('catch-up lands on catch-up, and the guide lands on live', () => {
  assert.equal(scopeOnArrival(null, 'catchup'), 'catchup');
  assert.equal(scopeOnArrival(null, 'guide'), 'live');
});

test('no origin claims nothing, and neither does an origin with no section', () => {
  assert.equal(scopeOnArrival(null, null), 'all');
  assert.equal(scopeOnArrival(null, ''), 'all');
  // The home page and settings rank nothing first — see `sectionForPath`.
  assert.equal(scopeOnArrival(null, 'home'), 'all');
  assert.equal(scopeOnArrival(null, 'more'), 'all');
});

test('a pressed scope outranks where you came from, so BACK and reload return to it', () => {
  assert.equal(scopeOnArrival('all', 'movies'), 'all');
  assert.equal(scopeOnArrival('catchup', 'movies'), 'catchup');
  assert.equal(scopeOnArrival('series', 'live'), 'series');
});

/* No nav tab folds to On TV the way `catchup` and `guide` fold to
   `live` — it is reached only by pressing the chip — but a pressed `?scope=ontv`
   still has to survive a reload exactly like any other pressed scope. */
test('on tv arrives only by being pressed, and a press is still honoured', () => {
  assert.equal(scopeOnArrival('ontv', 'movies'), 'ontv');
  assert.equal(scopeOnArrival(null, 'ontv'), 'all'); // not a real nav tab; rubbish `from` like any other
});

test('rubbish in the address is not a scope', () => {
  assert.equal(scopeOnArrival('sport', 'movies'), 'movies');
  assert.equal(scopeOnArrival('', null), 'all');
});

/* ── how the hits filter ──────────────────────────────────────────────────── */

test('each scope keeps its own kind, and All keeps everything', () => {
  assert.equal(hitsInScope(MIXED, 'all').length, 5);
  assert.equal(hitsInScope(MIXED, 'live').length, 2);
  assert.equal(hitsInScope(MIXED, 'movies').length, 2);
  assert.equal(hitsInScope(MIXED, 'series').length, 1);
});

/* The whole reason catch-up can be a chip at all: it is not a kind, it is the
   archive flag that is already on the row. */
test('catch-up is the channels that kept something, not a fourth kind', () => {
  assert.deepEqual(hitsInScope(MIXED, 'catchup'), [hit('live', true)]);
  assert.equal(inScope(hit('live', true), 'catchup'), true);
  assert.equal(inScope(hit('live'), 'catchup'), false);
  // A film is never catch-up however the flag reads.
  assert.equal(inScope(hit('movies', true), 'catchup'), false);
});

/* On TV is not derived from another kind the way Catch-up is — it needs its own
   hits, and it must not leak into, or be leaked into by, any other chip. */
test('on tv keeps only programme hits, and leaves every other chip\'s count alone', () => {
  assert.deepEqual(hitsInScope(WITH_ONTV, 'ontv'), [hit('ontv'), hit('ontv')]);
  assert.equal(hitsInScope(WITH_ONTV, 'all').length, 7);
  assert.equal(hitsInScope(WITH_ONTV, 'live').length, 2);
  assert.equal(hitsInScope(WITH_ONTV, 'movies').length, 2);
  assert.equal(hitsInScope(WITH_ONTV, 'series').length, 1);
  assert.equal(hitsInScope(WITH_ONTV, 'catchup').length, 1);
  assert.equal(inScope(hit('ontv'), 'ontv'), true);
  assert.equal(inScope(hit('ontv'), 'live'), false);
  assert.equal(inScope(hit('ontv'), 'catchup'), false);
});

test('filtering preserves the ranking the page already decided', () => {
  const ranked: ScopedHit[] = [hit('movies'), hit('live'), hit('movies'), hit('live', true)];
  const live = hitsInScope(ranked, 'live');
  assert.deepEqual(live.map((h) => h.item.archive), [false, true]);
  // And the array handed in is never mutated — All returns a copy.
  assert.notEqual(hitsInScope(ranked, 'all'), ranked);
  assert.equal(ranked.length, 4);
});

/* ── how the counts are derived ───────────────────────────────────────────── */

test('a count is the length of the list its chip renders', () => {
  const counts = scopeCounts(MIXED);
  for (const s of ['all', 'live', 'movies', 'series', 'catchup'] as Scope[]) {
    assert.equal(counts[s], hitsInScope(MIXED, s).length, s);
  }
});

/* Catch-up overlaps Live rather than partitioning it, so the chips deliberately
   do not add up to All. A channel with an archive is both. */
test('the parts do not sum to All, because a recorded channel is counted twice', () => {
  const counts = scopeCounts(MIXED);
  assert.equal(counts.all, 5);
  assert.equal(counts.live + counts.movies + counts.series + counts.catchup, 6);
});

test('nothing found is zero everywhere, not a missing key', () => {
  assert.deepEqual(scopeCounts([]), { all: 0, live: 0, ontv: 0, movies: 0, series: 0, catchup: 0 });
});

test('on tv is counted off its own hits, like every other chip', () => {
  assert.equal(scopeCounts(WITH_ONTV).ontv, 2);
  assert.equal(scopeCounts(WITH_ONTV).all, 7);
});

/* ── which chips are on the row ───────────────────────────────────────────── */

test('a scope with nothing behind it is not offered', () => {
  const chips = scopeChips([hit('movies'), hit('series')], 'all');
  assert.deepEqual(chips.map((c) => c.id), ['all', 'movies', 'series']);
});

test('a library of nothing but channels still offers catch-up when it has any', () => {
  const chips = scopeChips([hit('live', true), hit('live')], 'all');
  assert.deepEqual(chips.map((c) => c.id), ['all', 'live', 'catchup']);
  assert.deepEqual(chips.map((c) => c.count), [2, 2, 1]);
});

test('channels with no archive anywhere do not grow a catch-up chip', () => {
  const chips = scopeChips([hit('live'), hit('movies')], 'all');
  assert.deepEqual(chips.map((c) => c.id), ['all', 'live', 'movies']);
});

test('on tv sits between live and movies, right where it is offered from', () => {
  const chips = scopeChips(WITH_ONTV, 'all');
  assert.deepEqual(chips.map((c) => c.id), ['all', 'live', 'ontv', 'movies', 'series', 'catchup']);
  assert.equal(chips.find((c) => c.id === 'ontv')?.label, 'On TV');
  assert.equal(chips.find((c) => c.id === 'ontv')?.count, 2);
});

test('no programme hits, no On TV chip', () => {
  const chips = scopeChips(MIXED, 'all');
  assert.equal(chips.some((c) => c.id === 'ontv'), false);
});

/*
 * Picking a face empties the live block — the page's own long-standing rule,
 * because a cast list is a statement about titles. The row agrees with it
 * instead of contradicting it: Live and Catch-up leave, rather than sitting
 * there promising channels and opening an empty page.
 */
test('with an actor lit, the channel and programme chips leave the row rather than lying', () => {
  const chips = scopeChips([hit('movies'), hit('series')], 'all');
  assert.equal(chips.some((c) => c.id === 'live' || c.id === 'catchup' || c.id === 'ontv'), false);
});

test('the lit chip stays on the row even when its count falls to zero', () => {
  const chips = scopeChips([hit('movies')], 'series');
  assert.deepEqual(chips.map((c) => c.id), ['all', 'movies', 'series']);
  assert.equal(chips.find((c) => c.id === 'series')?.count, 0);
});

test('one destination named twice is not a row worth a press', () => {
  assert.equal(scopeRowWorthShowing(scopeChips([hit('movies')], 'all')), false);
  assert.equal(scopeRowWorthShowing(scopeChips([], 'all')), false);
  assert.equal(scopeRowWorthShowing(scopeChips(MIXED, 'all')), true);
});

/* ── the facet rows and this row are one decision ─────────────────────────── */

test('cast and category chips belong to the scopes that have titles in them', () => {
  assert.equal(facetsApply('all'), true);
  assert.equal(facetsApply('movies'), true);
  assert.equal(facetsApply('series'), true);
  assert.equal(facetsApply('live'), false);
  assert.equal(facetsApply('catchup'), false);
  assert.equal(facetsApply('ontv'), false); // a guide of titles has no cast or category either
});

test('every chip has a label, including the hyphenated one and the two-word one', () => {
  assert.deepEqual(
    (['all', 'live', 'ontv', 'movies', 'series', 'catchup'] as Scope[]).map(scopeLabel),
    ['All', 'Live', 'On TV', 'Movies', 'Series', 'Catch-up'],
  );
});

test('an arrival scope with nothing in it stands aside', () => {
  /* Measured by search-probe: arrive `?from=movies`, type "sky news", and the
     screen was Movies 0 with three live channels one press away. Nobody chose
     Movies — the app did, from where they were standing. */
  const hits = [
    { kind: 'live' as const, item: { id: 1, archive: true } },
    { kind: 'live' as const, item: { id: 2, archive: false } },
  ];
  assert.equal(effectiveScope(hits, 'movies', false), 'all');
  assert.equal(hitsInScope(hits, effectiveScope(hits, 'movies', false)).length, 2);
});

test('a scope somebody pressed is never overruled, empty or not', () => {
  const hits = [{ kind: 'live' as const, item: { id: 1, archive: false } }];
  assert.equal(effectiveScope(hits, 'movies', true), 'movies');
  assert.equal(hitsInScope(hits, 'movies').length, 0);
});

test('an arrival scope that does hold something is kept', () => {
  const hits = [
    { kind: 'movies' as const, item: { id: 1, archive: false } },
    { kind: 'live' as const, item: { id: 2, archive: false } },
  ];
  assert.equal(effectiveScope(hits, 'movies', false), 'movies');
});

test('on tv, once pressed, is never overruled either — it is just never an arrival guess', () => {
  const hits = [{ kind: 'live' as const, item: { id: 1, archive: false } }];
  assert.equal(effectiveScope(hits, 'ontv', true), 'ontv');
  assert.equal(hitsInScope(hits, 'ontv').length, 0);
});

test('no results at all leaves the arrival scope alone', () => {
  /* Nothing to defer TO, and flipping the row to All while the viewer is still
     typing would make the lit chip jump about on every keystroke. */
  assert.equal(effectiveScope([], 'series', false), 'series');
});
