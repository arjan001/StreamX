/**
 * The permanent adult filter, end to end: raw panel / playlist payloads in,
 * zero adult rows out of every read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND, buildCatalogue, findByStream, getItem, listCategories, listFacets, listGroups,
  listItems, listMarkets, matchRows, search, searchAll, type Catalogue, type RawPayloads,
} from '../src/index.ts';

/* Live categories: a clean one and four adult spellings (panel flag, `18|`
   market, "XXX" word, and an M3U group called "Adult"). */
const payloads: RawPayloads = {
  liveCategories: [
    { category_id: '1', category_name: 'US| NEWS' },
    { category_id: '2', category_name: '18| Night Shows' },
    { category_id: '3', category_name: 'XXX Movies' },
    { category_id: '4', category_name: 'Adult' },
    { category_id: '5', category_name: 'Adult Swim' },
  ],
  vodCategories: [
    { category_id: '11', category_name: 'EN| Drama' },
    { category_id: '12', category_name: '18| Films' },
    { category_id: '13', category_name: 'XXX Movies' },
    { category_id: '14', category_name: 'Adult' },
  ],
  seriesCategories: [
    { category_id: '21', category_name: 'EN| Shows' },
    { category_id: '22', category_name: 'Adult Series 18+' },
  ],
  live: [
    { stream_id: 1, name: 'US| Clean News', category_id: '1' },
    { stream_id: 2, name: 'Flagged Channel Clean News', category_id: '1', is_adult: 1 },
    { stream_id: 3, name: 'Night Clean News', category_id: '2' },
    { stream_id: 4, name: 'Xxx Clean News', category_id: '3' },
    { stream_id: 5, name: 'Group Clean News', category_id: '4' },
    { stream_id: 6, name: 'Cartoon Clean News', category_id: '5' },
    { stream_id: 7, name: '[X] Tagged Clean News', category_id: '1' },
  ],
  vod: [
    { stream_id: 101, name: 'Drama Clean Film', category_id: '11' },
    { stream_id: 102, name: 'Flagged Clean Film', category_id: '11', is_adult: '1' },
    { stream_id: 103, name: 'Market Clean Film', category_id: '12' },
    { stream_id: 104, name: 'Word Clean Film', category_id: '13' },
    { stream_id: 105, name: 'Group Clean Film', category_id: '14' },
    { stream_id: 106, name: 'Adulthood Clean Film', category_id: '11' },
  ],
  series: [
    { series_id: 201, name: 'Clean Show', category_id: '21' },
    { series_id: 202, name: 'Plus Clean Show', category_id: '22' },
  ],
};

const cat: Catalogue = buildCatalogue(payloads, { generation: 1, now: 0 });

const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

test('lists hold no adult rows, whatever the query', () => {
  assert.deepEqual(
    names(listItems(cat, { kind: KIND.Live }).rows),
    ['Cartoon Clean News', 'US| Clean News'],
  );
  assert.deepEqual(
    names(listItems(cat, { kind: KIND.Movie }).rows),
    ['Adulthood Clean Film', 'Drama Clean Film'],
  );
  assert.deepEqual(names(listItems(cat, { kind: KIND.Series }).rows), ['Clean Show']);
  assert.equal(listItems(cat, { kind: KIND.Movie, paths: ['18'] }).total, 0);
  assert.equal(matchRows(cat, { kind: KIND.Movie, cats: [3, 4] }).length, 0);
});

test('search finds no adult rows', () => {
  const all = searchAll(cat, 'clean', { limit: 100 });
  const found = [...all.live, ...all.movies, ...all.series].map((h) => h.row);
  assert.equal(found.length, 5);
  for (const r of found) assert.equal(getItem(cat, r) === null, false);
  assert.equal(search(cat, 'flagged').movies.length, 0);
  assert.equal(search(cat, 'market').movies.length, 0);
});

test('counts, categories, markets, groups and facets leave adult out', () => {
  const live = listCategories(cat, { kind: KIND.Live });
  assert.deepEqual(live.map((c) => c.name).sort(), ['Adult Swim', 'US| NEWS']);
  assert.deepEqual(live.map((c) => c.count).sort(), [1, 1]);
  assert.deepEqual(listCategories(cat, { kind: KIND.Movie }).map((c) => c.name), ['EN| Drama']);
  assert.deepEqual(listCategories(cat, { kind: KIND.Series }).map((c) => c.name), ['EN| Shows']);
  for (const kind of [KIND.Live, KIND.Movie, KIND.Series]) {
    const markets = listMarkets(cat, { kind, includeEmpty: true });
    assert.ok(!markets.some((m) => m.id === '18' || /adult|xxx/i.test(m.label) && m.label !== 'Adult Swim'));
    assert.equal(listGroups(cat, { kind, includeEmpty: true }).tree.some((n) => n.id === '18'), false);
    const f = listFacets(cat, { kind });
    assert.ok(f.genres.every((g) => !/adult|xxx/i.test(g.id)));
  }
});

test('a deep link to an adult row resolves to nothing', () => {
  assert.equal(findByStream(cat, KIND.Movie, 103), null);
  assert.equal(findByStream(cat, KIND.Movie, 102), null);
  assert.equal(findByStream(cat, KIND.Live, 4), null);
  assert.notEqual(findByStream(cat, KIND.Movie, 101), null);
  assert.equal(findByStream(cat, KIND.Live, 6)?.name, 'Cartoon Clean News');
});

test('an M3U group called "Adult" yields no rows', () => {
  const m3u = buildCatalogue({
    liveCategories: [
      { category_id: 'free:Adult', category_name: 'Adult' },
      { category_id: 'free:News', category_name: 'News' },
    ],
    vodCategories: [], seriesCategories: [], vod: [], series: [],
    live: [
      { stream_id: 1, name: 'Some Channel', category_id: 'free:Adult' },
      { stream_id: 2, name: 'News Channel', category_id: 'free:News' },
    ],
  }, { generation: 1, now: 0 });
  assert.deepEqual(names(listItems(m3u, { kind: KIND.Live }).rows), ['News Channel']);
  assert.equal(search(m3u, 'channel').live.length, 1);
  assert.deepEqual(listCategories(m3u, { kind: KIND.Live }).map((c) => c.name), ['News']);
});
