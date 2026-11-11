import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slowPressLine } from './slowPress.ts';

test('a slow press says how slow, where, and what the page was doing', () => {
  assert.equal(
    slowPressLine({
      ms: 3240, route: '/sports', busyMs: 7120, worstMs: 2800, guide: 'loading', library: 'ready',
      pictures: { active: 3, waiting: 12 }, nativeVideo: true, heapMB: 180, deviceGB: 2, cores: 4,
    }),
    'a press took 3.2 s on /sports — page busy 7.1 s of the last 10 s (longest 2.8 s); guide loading; '
      + 'library ready; pictures 3 + 12 waiting; picture on the TV player; heap 180 MB; box 2 GB, 4 cores',
  );
});

test('a WebView that reports no long tasks and no heap says only what it knows', () => {
  assert.equal(
    slowPressLine({
      ms: 1600, route: '/live', busyMs: 0, worstMs: 0, guide: 'ready', library: 'loading live',
      pictures: { active: 0, waiting: 0 }, nativeVideo: false, heapMB: null, deviceGB: null, cores: null,
    }),
    'a press took 1.6 s on /live — page busy 0.0 s of the last 10 s; guide ready; library loading live; '
      + 'pictures 0 + 0 waiting; picture in the page',
  );
});
