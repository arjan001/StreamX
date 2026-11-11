import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { MAX_AGE_MS, hydrateQueries, snapshotOf, usable } from './warm.ts';

function clientWith(entries: [unknown[], unknown][]): QueryClient {
  const qc = new QueryClient();
  for (const [k, v] of entries) qc.setQueryData(k as never, v as never);
  return qc;
}

test('only catalogue-shaped queries are written down', () => {
  const qc = clientWith([
    [['home', 'rail', 'movies'], { rows: [1, 2] }],
    [['groups', 'live'], { tree: [] }],
    [['source'], { account: { activeCons: 1 } }],
    [['epg', 42], { programmes: [] }],
    [['variants', 7], { variants: [] }],
  ]);
  const keys = snapshotOf(qc).entries.map(([k]) => (k as string[])[0]);
  assert.deepEqual(keys.sort(), ['groups', 'home']);
  // The three exclusions each have a reason: live account state, a guide that
  // goes stale by the minute, and a playback lookup.
  assert.ok(!keys.includes('source'));
  assert.ok(!keys.includes('epg'));
  assert.ok(!keys.includes('variants'));
});

test('a single huge answer is skipped, not allowed to end the snapshot', () => {
  const big = { rows: Array.from({ length: 40_000 }, (_, i) => ({ i, name: 'x'.repeat(40) })) };
  const qc = clientWith([
    [['home', 'huge'], big],
    [['home', 'small'], { rows: [1] }],
  ]);
  const keys = snapshotOf(qc).entries.map(([k]) => (k as string[])[1]);
  assert.deepEqual(keys, ['small'], 'the small entry after the huge one still made it');
});

test('a snapshot expires, and a clock that went backwards is not "fresh"', () => {
  const snap = { at: 1_000_000, entries: [] };
  assert.equal(usable(snap, 1_000_000 + MAX_AGE_MS - 1), true);
  assert.equal(usable(snap, 1_000_000 + MAX_AGE_MS + 1), false);
  assert.equal(usable(snap, 999_000), false);
  assert.equal(usable(null, 1_000_000), false);
});

test('restored data keeps its real age so react-query still revalidates', () => {
  const qc = new QueryClient();
  const at = Date.now() - 60_000;
  const n = hydrateQueries(qc, { at, entries: [[['home', 'rail'], { rows: [1] }]] });
  assert.equal(n, 1);
  assert.deepEqual(qc.getQueryData(['home', 'rail']), { rows: [1] });
  const state = qc.getQueryState(['home', 'rail']);
  assert.equal(state?.dataUpdatedAt, at, 'planted as a minute old, not as brand new');
});

test('a stale snapshot paints nothing at all', () => {
  const qc = new QueryClient();
  const n = hydrateQueries(qc, { at: Date.now() - MAX_AGE_MS - 1, entries: [[['home'], 1]] });
  assert.equal(n, 0);
  assert.equal(qc.getQueryData(['home']), undefined);
});
