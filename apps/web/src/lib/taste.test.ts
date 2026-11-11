import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEIGHTS, buildTaste, filterRecommended, recommend, watchWeight,
  type CategoryFacts, type Signal,
} from './taste.ts';
import type { Item } from './api.ts';
import type { WatchRecord } from './prefs.ts';

const NOW = Date.UTC(2026, 7, 20);
const DAY = 86_400_000;

const item = (id: number, categoryId: number, kind = 2, streamId = id): Item => ({
  id, kind, streamId, categoryId, name: `Title ${id}`, logo: 'x.jpg', ext: null,
  tvgId: null, archive: false, archiveDays: 0, rating: 7, year: '2024', direct: false,
});
const cat = (id: number, genres: string[], source: string | null = null, region: string | null = null): CategoryFacts =>
  ({ id, cleanName: `Cat ${id}`, genres, region, source });
const rec = (streamId: number, positionS: number, durationS: number, updatedAt = NOW): WatchRecord =>
  ({ section: 'movies', streamId, positionS, durationS, episodeId: null, season: null, episode: null, updatedAt });

test('a watch counts for how far it got, and a bounce counts against', () => {
  assert.equal(watchWeight(rec(1, 6000, 6600)), WEIGHTS.finished);
  assert.equal(watchWeight(rec(1, 2000, 6600)), WEIGHTS.engaged);
  assert.equal(watchWeight(rec(1, 120, 6600)), WEIGHTS.bounced);
  // No duration known: assume something rather than nothing, but not the most.
  assert.equal(watchWeight(rec(1, 500, 0)), WEIGHTS.engaged);
});

test('a profile needs more than one signal before it claims to know anything', () => {
  const one: Signal[] = [{ item: item(1, 10), weight: WEIGHTS.finished }];
  assert.equal(buildTaste(one, [cat(10, ['drama'])], { now: NOW, history: [] }).cold, true);
  const two: Signal[] = [...one, { item: item(2, 10), weight: WEIGHTS.favourite }];
  assert.equal(buildTaste(two, [cat(10, ['drama'])], { now: NOW, history: [] }).cold, false);
});

test('genres, providers and regions all come off the category', () => {
  const t = buildTaste(
    [
      { item: item(1, 10), weight: WEIGHTS.finished },
      { item: item(2, 11), weight: WEIGHTS.favourite },
    ],
    [cat(10, ['drama', 'crime'], 'Netflix', 'EN'), cat(11, ['drama'], 'Netflix', 'FR')],
    { now: NOW, history: [] },
  );
  assert.equal(t.genres[0]!.id, 'drama');
  assert.equal(t.providers[0]!.id, 'Netflix');
  assert.deepEqual(t.regions.map((r) => r.id).sort(), ['EN', 'FR']);
});

test('a bounced title pushes its genre DOWN, not up', () => {
  const t = buildTaste(
    [
      { item: item(1, 10), weight: WEIGHTS.finished },
      { item: item(2, 11), weight: WEIGHTS.bounced },
      { item: item(3, 10), weight: WEIGHTS.engaged },
    ],
    [cat(10, ['drama']), cat(11, ['horror'])],
    { now: NOW, history: [] },
  );
  assert.equal(t.genres[0]!.id, 'drama');
  // Negative scores are dropped entirely rather than ranked last.
  assert.equal(t.genres.some((g) => g.id === 'horror'), false);
});

test('recent signals outweigh old ones', () => {
  const history = [rec(1, 6000, 6600, NOW - 90 * DAY), rec(2, 6000, 6600, NOW - 1 * DAY)];
  const t = buildTaste(
    [
      { item: item(1, 10), weight: WEIGHTS.finished },
      { item: item(2, 11), weight: WEIGHTS.finished },
    ],
    [cat(10, ['western']), cat(11, ['scifi'])],
    { now: NOW, history },
  );
  assert.equal(t.genres[0]!.id, 'scifi', 'the thing watched yesterday should lead');
});

test('a dislike does not fade with time, because the taste has not changed', () => {
  const old = buildTaste(
    [
      { item: item(1, 10), weight: WEIGHTS.bounced },
      { item: item(2, 10), weight: WEIGHTS.engaged },
      { item: item(3, 11), weight: WEIGHTS.favourite },
    ],
    [cat(10, ['horror']), cat(11, ['comedy'])],
    { now: NOW, history: [rec(1, 10, 6600, NOW - 200 * DAY), rec(2, 3000, 6600, NOW - 200 * DAY)] },
  );
  // The faded positive cannot outrun the undimmed negative.
  assert.equal(old.genres.some((g) => g.id === 'horror'), false);
});

test('a cold profile recommends nothing at all', () => {
  const t = buildTaste([{ item: item(1, 10), weight: WEIGHTS.finished }], [cat(10, ['drama'])],
    { now: NOW, history: [] });
  assert.deepEqual(recommend(t, { section: 'movies', limit: 4 }), []);
});

test('rails are diverse by construction and every header says why', () => {
  const t = buildTaste(
    [
      { item: item(1, 10), weight: WEIGHTS.favourite },
      { item: item(2, 10), weight: WEIGHTS.finished },
      { item: item(3, 11), weight: WEIGHTS.finished },
    ],
    [cat(10, ['drama', 'crime'], 'Netflix'), cat(11, ['comedy'], 'Cinema')],
    { now: NOW, history: [] },
  );
  const picks = recommend(t, { section: 'movies', limit: 4 });
  assert.ok(picks.length >= 3);
  // Not five provider rails in a row.
  assert.deepEqual(picks.slice(0, 3).map((p) => p.kind), ['genre', 'provider', 'category']);
  for (const p of picks) assert.ok(p.title.length > 4, p.title);
  assert.equal(new Set(picks.map((p) => p.key)).size, picks.length, 'no duplicate rails');
});

test('a recommendation never suggests something already watched or starred', () => {
  const t = buildTaste(
    [
      { item: item(1, 10), weight: WEIGHTS.favourite },
      { item: item(2, 10), weight: WEIGHTS.finished },
    ],
    [cat(10, ['drama'])],
    { now: NOW, history: [] },
  );
  const rows = [item(1, 10), item(2, 10), item(9, 10)];
  assert.deepEqual(filterRecommended(rows, t, 'movies').map((r) => r.id), [9]);
});

test('series and films keep separate seen-lists, because the ids overlap', () => {
  const t = buildTaste(
    [
      { item: item(5, 10, 2, 5), weight: WEIGHTS.favourite },
      { item: item(7, 10, 3, 5), weight: WEIGHTS.favourite },
    ],
    [cat(10, ['drama'])],
    { now: NOW, history: [] },
  );
  assert.equal(t.seen.movies.has(5), true);
  assert.equal(t.seen.series.has(5), true);
  // A film with stream_id 5 and a series with series_id 5 are different things.
  assert.deepEqual(filterRecommended([item(9, 10, 2, 5)], t, 'movies').length, 0);
  assert.deepEqual(filterRecommended([item(9, 10, 2, 6)], t, 'movies').length, 1);
});

test('a title with no category contributes nothing rather than throwing', () => {
  const t = buildTaste(
    [{ item: { ...item(1, 0), categoryId: null }, weight: WEIGHTS.favourite },
     { item: item(2, 999), weight: WEIGHTS.favourite }],
    [cat(10, ['drama'])],
    { now: NOW, history: [] },
  );
  assert.deepEqual(t.genres, []);
  assert.equal(t.cold, false, 'the signals still count as signals');
});
