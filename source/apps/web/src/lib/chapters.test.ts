import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapterAt, chapters, clock, digitSeek, skipTo } from './chapters.ts';

/**
 * The guard that matters most here is the first one: this catalogue supplies no
 * chapters, so the correct output for every title in it is an empty list. The
 * previous version of this module invented one stop every ten minutes and the
 * tests below asserted the invention was well-formed, which is how a fabrication
 * passes review.
 */
test('a title whose engine reported nothing has no chapters', () => {
  assert.deepEqual(chapters(), []);
  assert.deepEqual(chapters([]), []);
});

test('real chapters are kept, sorted, and named', () => {
  const list = chapters([
    { startS: 120, label: 'Titles' },
    { startS: 0, label: '' },
    { startS: 3000, label: 'The heist' },
  ]);
  assert.deepEqual(list.map((c) => c.startS), [0, 120, 3000]);
  assert.deepEqual(list.map((c) => c.label), ['Chapter 1 · 0:00', 'Titles', 'The heist']);
});

test('a chapter with no usable start is dropped rather than guessed at', () => {
  const list = chapters([
    { startS: Number.NaN, label: 'Broken' },
    { startS: -5, label: 'Also broken' },
    { startS: 60, label: 'Fine' },
  ]);
  assert.deepEqual(list.map((c) => c.label), ['Fine']);
});

test('skipping forward goes to the next chapter and stops at the last one', () => {
  const list = chapters([{ startS: 0 }, { startS: 600 }, { startS: 1200 }]);
  assert.equal(skipTo(list, 0, 1), 600);
  assert.equal(skipTo(list, 599, 1), 600);
  assert.equal(skipTo(list, 600, 1), 1200);
  assert.equal(skipTo(list, 1300, 1), null, 'past the last chapter there is nowhere to go');
});

test('skipping back from just inside a chapter goes to the one before it', () => {
  const list = chapters([{ startS: 0 }, { startS: 600 }, { startS: 1200 }]);
  // The behaviour every disc player has: eight seconds in, PREVIOUS means the
  // chapter before this one, not the point you just passed.
  assert.equal(skipTo(list, 608, -1), 600);
  assert.equal(skipTo(list, 602, -1), 0);
  assert.equal(skipTo(list, 30, -1), 0);
  assert.equal(skipTo(list, 0.5, -1), null);
});

test('no chapters means the skip buttons have nothing to say', () => {
  // Which is the signal VideoPlayer uses to fall back to a plain ±60s nudge
  // instead of drawing a chapter control that would land on invented times.
  assert.equal(skipTo([], 100, 1), null);
  assert.equal(skipTo([], 100, -1), null);
});

test('the highlighted chapter is the one the playhead is inside', () => {
  const list = chapters([{ startS: 0 }, { startS: 600 }, { startS: 1200 }]);
  assert.equal(chapterAt(list, 0), 0);
  assert.equal(chapterAt(list, 599), 0);
  assert.equal(chapterAt(list, 600), 1);
  assert.equal(chapterAt(list, 5000), 2);
  assert.equal(chapterAt([], 10), -1);
});

test('digits land on tenths, and never past the end', () => {
  // Not a fabrication: a tenth of a known runtime is a fact about the runtime,
  // not a claim about where a scene begins.
  assert.equal(digitSeek(0, 1000), 0);
  assert.equal(digitSeek(5, 1000), 500);
  assert.equal(digitSeek(9, 1000), 900);
  assert.equal(digitSeek(9, 10), 9);
  assert.equal(digitSeek(3, 0), null, 'live has no tenths');
  assert.equal(digitSeek(3, Number.POSITIVE_INFINITY), null);
  assert.equal(digitSeek(12, 1000), null);
});

test('the clock reads as a time at both lengths', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65), '1:05');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(clock(-5), '0:00');
});
