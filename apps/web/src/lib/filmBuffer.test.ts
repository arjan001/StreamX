import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aheadOf, holds, spansOf } from './filmBuffer.ts';

const ranges = (...pairs: [number, number][]) => ({
  length: pairs.length,
  start: (i: number) => pairs[i]![0],
  end: (i: number) => pairs[i]![1],
});

test('TimeRanges become plain data', () => {
  assert.deepEqual(spansOf(ranges([0, 30], [600, 700])), [
    { start: 0, end: 30 }, { start: 600, end: 700 },
  ]);
  assert.deepEqual(spansOf(null), []);
});

test('a jump into a held stretch costs nothing — which is the whole point', () => {
  const held = spansOf(ranges([0, 120], [2400, 2700]));
  assert.equal(holds(held, 2500), true);
  assert.equal(holds(held, 60), true);
});

test('a jump into a gap is a jump that has to be fetched', () => {
  const held = spansOf(ranges([0, 120], [2400, 2700]));
  assert.equal(holds(held, 900), false);
  assert.equal(holds(held, 3000), false);
});

test('landing on the last half second of a hold is not "already downloaded"', () => {
  /* It would move instantly and then stall, which is worse than a clean
     reload — so two seconds of video is the promise. */
  assert.equal(holds(spansOf(ranges([0, 120])), 119.5), false);
  assert.equal(holds(spansOf(ranges([0, 120])), 100), true);
});

test('a few frames short of a boundary is still inside it', () => {
  /* Fragment boundaries are where the encoder put them; a seek that lands
     fractionally before one must not cost a new ffmpeg. */
  assert.equal(holds(spansOf(ranges([600, 900])), 599.7), true);
  assert.equal(holds(spansOf(ranges([600, 900])), 590), false);
});

test('how far ahead the film is already fetched', () => {
  assert.equal(aheadOf(spansOf(ranges([0, 90])), 30), 60);
  assert.equal(aheadOf(spansOf(ranges([0, 90])), 200), 0);
});
