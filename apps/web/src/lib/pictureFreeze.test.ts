/**
 * The rule behind "it plays for two seconds and then it is black with sound".
 *
 * Tested here rather than on a television because the fault is a decoder giving
 * up mid-stream, which cannot be summoned on demand — and because every branch
 * of it decides whether to throw away a working connection on an account that
 * only has one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshWatch, judgeFrozen } from './pictureFreeze.ts';

const WINDOW = 3;

test('a counter that advances is a picture, whatever the clock says', () => {
  let w = freshWatch();
  for (const [count, at] of [[10, 0], [20, 1], [30, 2], [40, 9]] as const) {
    const r = judgeFrozen(w, count, at, WINDOW);
    assert.equal(r.verdict, 'moving');
    w = r.next;
  }
});

test('a counter that stops is only a verdict once the clock has really moved', () => {
  /* It has to have MOVED first — see the `moved` rule — so this walks it twice. */
  let w = judgeFrozen(freshWatch(), 99, 9, WINDOW).next;
  w = judgeFrozen(w, 100, 10, WINDOW).next;
  assert.equal(judgeFrozen(w, 100, 11, WINDOW).verdict, 'waiting');
  assert.equal(judgeFrozen(w, 100, 12.9, WINDOW).verdict, 'waiting');
  const r = judgeFrozen(w, 100, 13, WINDOW);
  assert.equal(r.verdict, 'frozen');
  /* And the watch is cleared, so the next sample starts a fresh measurement
     rather than condemning the retry as well. */
  assert.deepEqual(r.next, freshWatch());
  w = r.next;
  assert.equal(judgeFrozen(w, 100, 14, WINDOW).verdict, 'moving');
});

test('a stall spends none of the deadline', () => {
  /* The whole point of measuring in MEDIA time: a stream that is buffering is
     not producing frames and is not advancing the clock either, and a watchdog
     on wall clock would kill it. */
  const w = judgeFrozen(judgeFrozen(freshWatch(), 54, 29, WINDOW).next, 55, 30, WINDOW).next;
  for (let i = 0; i < 20; i++) {
    assert.equal(judgeFrozen(w, 55, 30, WINDOW).verdict, 'waiting');
  }
});

test('a seek restarts the measurement rather than counting as elapsed', () => {
  /* Jumping back an hour must not read as an hour of frozen picture — and
     jumping back is also what a live stream does when it is pulled to the edge. */
  const w = judgeFrozen(judgeFrozen(freshWatch(), 899, 3599, WINDOW).next, 900, 3600, WINDOW).next;
  const back = judgeFrozen(w, 900, 12, WINDOW);
  assert.equal(back.verdict, 'waiting');
  assert.equal(back.next.at, 12);
  assert.equal(judgeFrozen(back.next, 900, 14, WINDOW).verdict, 'waiting');
  assert.equal(judgeFrozen(back.next, 900, 15, WINDOW).verdict, 'frozen');
});

test('the first sample is never a verdict', () => {
  /* `-1` is "nothing sampled yet", and a stream that opens at frame zero must
     not be condemned before it has had a chance to produce one. */
  assert.equal(judgeFrozen(freshWatch(), 0, 0, WINDOW).verdict, 'moving');
  assert.equal(judgeFrozen(freshWatch(), 0, 900, WINDOW).verdict, 'moving');
});

test('a counter that has NEVER moved is never a verdict', () => {
  /*
   * The rule that stops this watchdog becoming the bug it looks for.
   *
   * libVLC with MediaCodec rendering straight to the surface can report
   * `displayedPictures` as a constant zero for a stream that is playing
   * perfectly. Condemning that would reload it, condemn it again and leave a
   * black card over working audio at ten to fifteen seconds — which is exactly
   * the fault being chased, caused by the fix for it.
   */
  let w = freshWatch();
  for (let t = 0; t < 600; t += 1) {
    const r = judgeFrozen(w, 0, t, WINDOW);
    assert.notEqual(r.verdict, 'frozen', `condemned at ${t}s with a counter that never moved`);
    w = r.next;
  }
  /* And the moment it DOES move, the rule arms itself. */
  w = judgeFrozen(w, 1, 600, WINDOW).next;
  assert.equal(judgeFrozen(w, 1, 601, WINDOW).verdict, 'waiting');
  assert.equal(judgeFrozen(w, 1, 604, WINDOW).verdict, 'frozen');
});
