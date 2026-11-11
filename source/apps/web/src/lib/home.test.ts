import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  categoryHeading, collectionRails, continueRows, dayNumber, dedupeTitles, idsFor, railRevealPlan,
  rotate, spotlight, tileRem, titleKey, tileCapPx,
} from './home.ts';
import type { Item } from './api.ts';
import type { WatchRecord } from './prefs.ts';

const item = (id: number, name: string, streamId = id, logo: string | null = 'x.jpg'): Item => ({
  id, ref: `2.${streamId}`, kind: 2, categoryId: null, streamId, name, logo, ext: null, tvgId: null,
  archive: false, archiveDays: 0, rating: null, year: null, direct: false,
});
const rec = (streamId: number, updatedAt: number, section: 'movies' | 'series' = 'movies'): WatchRecord => ({
  section, streamId, positionS: 60, durationS: 6000,
  episodeId: null, season: null, episode: null, updatedAt,
});

test('dayNumber advances at local midnight, not UTC midnight', () => {
  // 22:30 UTC on 1 Jan is already 2 Jan in Amsterdam (UTC+2 => offset -120).
  const t = Date.UTC(2026, 0, 1, 22, 30);
  assert.equal(dayNumber(t, -120) - dayNumber(t, 0), 1);
  // And the same instant is still 1 Jan in New York (UTC-5 => offset 300).
  assert.equal(dayNumber(t, 300), dayNumber(t, 0));
});

test('rotate returns the whole pool when it is not bigger than the window', () => {
  assert.deepEqual(rotate([1, 2, 3], 6, 99), [1, 2, 3]);
  assert.deepEqual(rotate([], 6, 0), []);
  assert.deepEqual(rotate([1, 2], 0, 0), []);
});

test('rotate wraps, and moves on the next day', () => {
  const pool = [0, 1, 2, 3, 4, 5, 6];
  assert.deepEqual(rotate(pool, 3, 0), [0, 1, 2]);
  assert.deepEqual(rotate(pool, 3, 1), [3, 4, 5]);
  // Wrapping rather than clamping: day 2 starts at 6 and comes round to 0.
  assert.deepEqual(rotate(pool, 3, 2), [6, 0, 1]);
  // A negative day (clock skew, or a device set to 1969) must not throw or empty.
  assert.equal(rotate(pool, 3, -1).length, 3);
});

test('rotate is stable within a day — the whole reason it exists', () => {
  const pool = Array.from({ length: 40 }, (_, i) => i);
  assert.deepEqual(rotate(pool, 6, 20_300), rotate(pool, 6, 20_300));
});

test('titleKey folds market prefix, year and punctuation', () => {
  assert.equal(titleKey('EN - On My Block (2018) (US)'), titleKey('NF - On My Block (2018) (US)'));
  assert.equal(titleKey("Grey's Anatomy"), 'greysanatomy');
});

test('dedupeTitles keeps the first spelling of a repeated title', () => {
  const rows = [item(1, 'EN - Dune (2021)'), item(2, 'FR - Dune (2021)'), item(3, 'EN - Arrival')];
  assert.deepEqual(dedupeTitles(rows).map((r) => r.id), [1, 3]);
});

test('spotlight interleaves films and series and drops artless rows', () => {
  const movies = [item(1, 'M one'), item(2, 'M two', 2, null), item(3, 'M three')];
  const series = [item(10, 'S one'), item(11, 'S two')];
  const out = spotlight(movies, series, { count: 4, day: 0 });
  assert.deepEqual(out.map((s) => [s.section, s.item.id]), [
    ['movies', 1], ['series', 10], ['movies', 3], ['series', 11],
  ]);
});

test('spotlight is empty when nothing has artwork, rather than showing blanks', () => {
  assert.deepEqual(spotlight([item(1, 'a', 1, null)], [], { count: 6, day: 3 }), []);
});

test('continueRows re-sorts into recency order, not the order the API replied in', () => {
  const history = [rec(5, 1000), rec(9, 3000), rec(7, 2000)];
  // The API answers in its own (sort_index) order — 5, 7, 9.
  const found = { movies: [item(50, 'five', 5), item(70, 'seven', 7), item(90, 'nine', 9)], series: [] };
  const rows = continueRows(history, found, () => true);
  assert.deepEqual(rows.map((r) => r.item.id), [90, 70, 50]);
  // Built from the stable ref, not the row id — that is the point of `linkId`.
  assert.equal(rows[0]!.to, '/movie/2.9');
});

test('continueRows drops records whose title is gone from the catalogue', () => {
  const rows = continueRows([rec(5, 1), rec(6, 2)], { movies: [item(50, 'five', 5)], series: [] }, () => true);
  assert.deepEqual(rows.map((r) => r.item.id), [50]);
});

test('continueRows honours the injected resumable rule and links series to /series', () => {
  const history = [rec(1, 10), rec(2, 20, 'series')];
  const found = { movies: [item(11, 'm', 1)], series: [item(22, 's', 2)] };
  assert.deepEqual(
    continueRows(history, found, (r) => r.section === 'series').map((r) => r.to),
    ['/series/2.2'],
  );
});

test('idsFor takes the newest ids for one section, deduped', () => {
  const history = [rec(3, 100), rec(4, 300, 'series'), rec(3, 200), rec(5, 50)];
  assert.deepEqual(idsFor(history, 'movies'), [3, 5]);
  assert.deepEqual(idsFor(history, 'series'), [4]);
  assert.deepEqual(idsFor(history, 'movies', 1), [3]);
});

test('tile width grows for a remote and shrinks for a phone', () => {
  assert.ok(tileRem('phone') < tileRem('desktop'));
  assert.ok(tileRem('tv') > tileRem('desktop'));
});

/* ── the endless rails ────────────────────────────────────────────────────── */

const cat = (ref: string, name: string, count: number, id = Number(ref.split('.')[1])) => ({
  id, ref, name, cleanName: name, count, genres: [], region: null, source: null,
});

test('films and series alternate rather than running in two blocks', () => {
  const rails = collectionRails(
    [cat('2.1', 'Netflix', 900), cat('2.2', 'Kids', 400)],
    [cat('3.1', 'HBO', 300), cat('3.2', 'Anime', 100)],
  );
  assert.deepEqual(rails.map((r) => r.title), ['Netflix', 'HBO', 'Kids', 'Anime']);
  assert.deepEqual(rails.map((r) => r.section), ['movies', 'series', 'movies', 'series']);
});

test('an empty package makes no rail', () => {
  /* A rail that has already reserved its height and then finds nothing is the
     one state a lazily-mounted rail cannot recover from. */
  const rails = collectionRails([cat('2.1', 'Netflix', 900), cat('2.9', 'EMPTY', 0)], []);
  assert.deepEqual(rails.map((r) => r.title), ['Netflix']);
});

test('an uneven pair still empties both sides', () => {
  const rails = collectionRails([cat('2.1', 'A', 5)], [cat('3.1', 'B', 5), cat('3.2', 'C', 5)]);
  assert.deepEqual(rails.map((r) => r.title), ['A', 'B', 'C']);
});

test('a rail carries the query and the link for its own section', () => {
  const [film] = collectionRails([cat('2.7', 'Netflix', 900, 42)], []);
  assert.equal(film?.to, '/movies?category=42');
  assert.deepEqual(film?.params, { categoryId: 42, sort: 'added', dir: 'desc' });
  assert.equal(film?.note, '900 films');
  assert.equal(film?.key, 'movies:2.7');
});

/**
 * A rail link may only name parameters the filter bar actually parses.
 *
 * The bug this replaces: every "See all" on the endless rails pointed at
 * `?cat=<id>`, and `filtersFromParams` has never read a parameter called `cat`.
 * So the link opened the right page with the right heading and no filter at all
 * — the whole of Movies where somebody had asked for one package. Nothing about
 * that is visible in a type, a diff or a green suite: both halves are valid on
 * their own, and they are written in two files that never mention each other.
 *
 * The parser's own source is the reference rather than a list copied into this
 * test, because a copied list is the same two-halves problem one file further
 * along. `FilterBar.tsx` cannot be imported here — it is JSX, and these tests run
 * under `--experimental-strip-types` — so the names are read out of it. Reading
 * only `filtersFromParams` and not the whole file matters: `paramsFromFilters`
 * sits directly underneath it and would happily vouch for a parameter that is
 * only ever written.
 */
function filterParamsRead(): Set<string> {
  const src = readFileSync(
    fileURLToPath(new URL('../components/FilterBar.tsx', import.meta.url)),
    'utf8',
  );
  const from = src.indexOf('export function filtersFromParams');
  assert.notEqual(from, -1, 'filtersFromParams has moved or been renamed');
  const to = src.indexOf('export function', from + 1);
  const body = src.slice(from, to === -1 ? undefined : to);
  const names = [...body.matchAll(/p\.get\('([^']+)'\)/g)].map((m) => m[1]!);
  assert.ok(names.length > 3, 'no parameters found — the parser was read wrong');
  return new Set(names);
}

test('every "see all" link names a filter the grid actually reads', () => {
  const parsed = filterParamsRead();
  const rails = collectionRails(
    [cat('2.7', 'Netflix', 900, 42)],
    [cat('3.4', 'HBO', 300, 77)],
  );
  assert.equal(rails.length, 2);
  for (const rail of rails) {
    const url = new URL(rail.to, 'http://tv.local');
    assert.equal(url.pathname, `/${rail.section}`);
    const keys = [...url.searchParams.keys()];
    assert.ok(keys.length > 0, `${rail.to} carries no filter at all`);
    for (const key of keys) {
      assert.ok(parsed.has(key), `${rail.to} names "${key}", which FilterBar never reads`);
    }
  }
});

/* The half of it a name check cannot see: the value has to arrive as the same
   category the rail fetched, or "see all" opens a different package. */
test('the link and the rail\'s own query point at one package', () => {
  const [film] = collectionRails([cat('2.7', 'Netflix', 900, 42)], []);
  const url = new URL(film!.to, 'http://tv.local');
  assert.equal(url.searchParams.get('category'), String(film!.params.categoryId));
});

test('keys are unique across sections, so a shared ref cannot collide', () => {
  const rails = collectionRails([cat('2.1', 'A', 5)], [cat('2.1', 'A', 5)]);
  assert.equal(new Set(rails.map((r) => r.key)).size, 2);
});

test('a package with no clean name falls back to a readable one', () => {
  const raw = { ...cat('2.1', 'VOD | NETFLIX 4K', 5), cleanName: '' };
  const [rail] = collectionRails([raw], []);
  assert.ok(rail !== undefined && rail.title !== '');
  assert.ok(!rail.title.startsWith('VOD |'), rail.title);
});

test('a rail on a television is capped by the screen, not only by its width', () => {
  /* The boxes report 960x540. Five posters across gives a 174px tile and a 261px
     picture, which is most of a 487px canvas for one rail — and `RelatedRail`,
     which never measured at all, drew 256px tiles four across. The cap is a
     share of the height so it means the same thing on a bigger report. */
  assert.equal(tileCapPx('tv', 540), 136);
  assert.equal(tileCapPx('tv', 1080), 273);
  /* Proportional: the same picture from the same distance. */
  assert.equal(Math.round(tileCapPx('tv', 1080) / tileCapPx('tv', 540)), 2);
});

test('the cap is a television rule and nothing else', () => {
  assert.equal(tileCapPx('phone', 800), Infinity);
  assert.equal(tileCapPx('tablet', 800), Infinity);
  assert.equal(tileCapPx('desktop', 800), Infinity);
});

test('the cap never collapses a tile to nothing', () => {
  assert.equal(tileCapPx('tv', 10), 96);
});

/* ── returning to a package rail deep enough that it needed scrolling ────── */

test('railRevealPlan does nothing with no target remembered', () => {
  const rails = collectionRails([cat('2.1', 'A', 5)], []);
  assert.equal(railRevealPlan(rails, null, 5), null);
});

test('railRevealPlan ignores a target these rails do not have', () => {
  const rails = collectionRails([cat('2.1', 'A', 5)], []);
  // A fixed rail's own "See all" (never part of the endless list) reads the
  // same as a package the catalogue no longer has — neither is this
  // function's problem, and both are simply not found.
  assert.equal(railRevealPlan(rails, '/movies?favs=1', 5), null);
  assert.equal(railRevealPlan(rails, '/movies?category=999', 5), null);
});

test('railRevealPlan leaves shown alone when the target is already within it', () => {
  const rails = collectionRails(
    [cat('2.1', 'A', 5), cat('2.2', 'B', 5), cat('2.3', 'C', 5)],
    [],
  );
  // "B" is index 1, well inside a shown count of 5.
  assert.deepEqual(railRevealPlan(rails, '/movies?category=2', 5), { index: 1, shown: 5 });
});

test('railRevealPlan raises shown to include a rail deeper than the current count', () => {
  const packages = Array.from({ length: 12 }, (_, i) => cat(`2.${i + 1}`, `P${i + 1}`, 5, i + 1));
  const rails = collectionRails(packages, []);
  // "P12" is index 11 — one past a shown count of 5 wide of the mark.
  assert.deepEqual(railRevealPlan(rails, '/movies?category=12', 5), { index: 11, shown: 12 });
});

/* ── the category page's own heading ─────────────────────────────────────── */

const NETFLIX = { id: 42, name: 'NL | NETFLIX SERIES 4K' };
const HBO = { id: 7, name: 'UK| HBO' };

test('categoryHeading reads the raw provider name off a categoryId, not a cleaned one', () => {
  // Same string `lib/liveRows.ts`'s `listRows` would put on the sidebar row —
  // no `groupLabel` transcode-stripping here, unlike the rail title above it.
  assert.equal(
    categoryHeading([NETFLIX, HBO], { categoryId: 42, path: null, paths: [] }),
    'NL | NETFLIX SERIES 4K',
  );
});

test('categoryHeading is null when nothing narrows the view to one thing', () => {
  assert.equal(categoryHeading([NETFLIX], { categoryId: null, path: null, paths: [] }), null);
});

test('categoryHeading is null for a categoryId the list no longer has', () => {
  // Loading, or a stale link — either way there is nothing honest to head the
  // page with, so both callers draw nothing rather than "this package".
  assert.equal(categoryHeading([], { categoryId: 42, path: null, paths: [] }), null);
});

test('categoryHeading falls back to a titled leaf for a group-tree path', () => {
  // Same split as `FilterBar`'s own `scopeLabel`: a trailing `+` is a separator
  // with nothing after it, not a character to keep.
  assert.equal(
    categoryHeading([], { categoryId: null, path: 'UK/SKY_SPORT+', paths: [] }),
    'Sky Sport',
  );
  // `paths` (any-of) stands in for `path` when only that is set — the first one,
  // the same rule `FilterBar`'s own `scopeLabel` uses.
  assert.equal(
    categoryHeading([], { categoryId: null, path: null, paths: ['EN/NETFLIX', 'EN/HBO'] }),
    'Netflix',
  );
});

test('categoryHeading prefers categoryId over a path when somehow both are set', () => {
  assert.equal(
    categoryHeading([NETFLIX], { categoryId: 42, path: 'EN/OTHER', paths: [] }),
    'NL | NETFLIX SERIES 4K',
  );
});
