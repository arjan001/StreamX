import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  learnedAfterReset, needsCompatible, pickTransport, rememberNeedsCompatible, doorIsAnswering, seekBroke, nudgeTarget, nativeBufferedEnd,
  believeNativeTime, type NativeSeek } from './playerCore.ts';
import { setKVBackend } from './kv.ts';

test('an explicit choice is an instruction, not a hint', () => {
  // Even for a channel that has already failed on the raw feed: pinning the
  // transport is how someone diagnoses a stream, so nothing may override it.
  assert.equal(pickTransport('lowLatency', 42, [42]), 'lowLatency');
  assert.equal(pickTransport('compatible', 42, []), 'compatible');
});

test('auto takes the fast path until a channel proves it cannot', () => {
  assert.equal(pickTransport('auto', 42, []), 'lowLatency');
  assert.equal(pickTransport('auto', 42, [42]), 'compatible');
});

test('auto only remembers the channel it learned about', () => {
  assert.equal(pickTransport('auto', 7, [42, 99]), 'lowLatency');
});

test('no channel yet still resolves', () => {
  // The player mounts before anything is playing; this must not throw or
  // accidentally read as "compatible".
  assert.equal(pickTransport('auto', null, [42]), 'lowLatency');
});

/* ── the one-time reset of the learned list ─────────────────────────────────
   Before `checkSound`, a channel whose AUDIO the browser refused was pinned to
   HLS, where hls.js drops that track silently and the new rule never runs. The
   list cannot say why a channel is in it, so a device empties it once. */

test('a device that has not run the reset reads its old pins as gone', () => {
  // 4073 stands for the AC-3 channel the old fallback pinned.
  assert.deepEqual(learnedAfterReset(null, [4073, 12]), { learned: [], reset: true });
  // And under auto that channel is back on the fast path, where the refusal is seen.
  assert.equal(pickTransport('auto', 4073, learnedAfterReset(null, [4073]).learned), 'lowLatency');
});

test('the reset is owed even with nothing to clear, so the flag still gets written', () => {
  assert.deepEqual(learnedAfterReset(null, []), { learned: [], reset: true });
});

test('once done, what was relearned since stands — it is never wiped again', () => {
  const after = learnedAfterReset('1', [99]);
  assert.deepEqual(after, { learned: [99], reset: false });
  assert.equal(pickTransport('auto', 99, after.learned), 'compatible');
});

test('a flag value this build did not write does not count as done', () => {
  assert.equal(learnedAfterReset('true', [5]).reset, true);
  assert.equal(learnedAfterReset('', [5]).reset, true);
});

test('the stored list is emptied on the first read, the flag written, and a new pin kept', () => {
  // The storage half, against a memory backend. The reset is asked once per
  // process, so this is the only test in this file that touches storage.
  const store = new Map<string, string>([['iptv.liveMode.learned', '[4073,12]']]);
  setKVBackend({
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
  });
  assert.equal(needsCompatible(4073), false);
  assert.equal(store.get('iptv.liveMode.learned'), '[]');
  assert.equal(store.get('iptv.liveMode.learnedReset.v1'), '1');
  // A channel that genuinely needs HLS relearns it, and the next read keeps it.
  rememberNeedsCompatible(99);
  assert.equal(needsCompatible(99), true);
  assert.equal(store.get('iptv.liveMode.learned'), '[99]');
});

/*
 * A browser with no Media Source cannot run the low-latency path at all —
 * mpegts.js IS a MediaSource program. Safari on an iPhone is that browser, and
 * it plays HLS natively in the element, which is how every iPhone watches live
 * video. Photographed from one: "This browser has no Media Source support.
 * Neither transport can work without it." The second sentence was false; the
 * request simply went out asking for the one form that could not work.
 */
test('without Media Source the compatible path is the only one, whatever was asked for', () => {
  assert.equal(pickTransport('auto', 1, [], false), 'compatible');
  assert.equal(pickTransport('lowLatency', 1, [], false), 'compatible',
    'a pinned choice that cannot work is a dead end with a setting in front of it');
  assert.equal(pickTransport('compatible', 1, [], false), 'compatible');
});

test('with Media Source nothing changes — the guard is the only new rule', () => {
  assert.equal(pickTransport('auto', 1, [], true), 'lowLatency');
  assert.equal(pickTransport('auto', 1, [1], true), 'compatible');
  assert.equal(pickTransport('lowLatency', 1, [1], true), 'lowLatency');
  /* And the parameter defaults to "yes", so every existing caller is unchanged. */
  assert.equal(pickTransport('auto', 1, []), 'lowLatency');
});

/*
 * When a door counts as answering — the rule that decides whether to hop.
 *
 * Every "no" here is a hop to another door, and on an account that allows one
 * connection a hop is a fresh session against it. Reported with a network
 * trace: one film fetched from four doors in turn, transfers abandoned
 * mid-download at 3MB and 4MB, nothing ever playing.
 */
test('a door that has handed over metadata or buffer is answering', () => {
  assert.equal(doorIsAnswering(2, 0, 0, 1_000), true, 'readyState 2 is metadata');
  assert.equal(doorIsAnswering(4, 1, 0, 1_000), true);
  assert.equal(doorIsAnswering(0, 1, 0, 1_000), true, 'buffered data with no readyState still counts');
});

test('bytes arriving count, even when none of them can be played yet', () => {
  /* The case both older tests missed: a progressive MP4 whose index sits at the
     end downloads megabytes with readyState and buffered both at zero. */
  assert.equal(doorIsAnswering(0, 0, 10_000, 10_500), true, 'half a second ago');
  assert.equal(doorIsAnswering(0, 0, 10_000, 13_900), true, 'still within the window');
});

test('a door that has gone quiet is not answering, and may be left', () => {
  assert.equal(doorIsAnswering(0, 0, 10_000, 20_000), false, 'ten seconds of silence');
});

test('nothing has arrived yet is not the same as arrived long ago', () => {
  /* 0 is the reset a new stream starts from. Treating it as a timestamp would
     make every fresh load look like a door that answered in 1970. */
  assert.equal(doorIsAnswering(0, 0, 0, 0), false);
  assert.equal(doorIsAnswering(0, 0, 0, 5_000), false);
});

/*
 * A seek that kills a film it was playing.
 *
 * "when the quality is high or something, and i try to change position it
 * suddenly goes away and shows failed." The recovery paths around it are all
 * guarded on `!everPlayed` — right, because a film that has been playing should
 * not go hunting for another door on a one-connection account — which left the
 * commonest failure with nothing between it and an error message.
 */
test('a film that was playing and broke just after a seek is the seek’s fault', () => {
  assert.equal(seekBroke(true, 10_000, 10_500, false), true, 'half a second later');
  assert.equal(seekBroke(true, 10_000, 21_000, false), true, 'a slow ranged request still counts');
});

test('a failure long after the last seek is not blamed on it', () => {
  assert.equal(seekBroke(true, 10_000, 30_000, false), false, 'twenty seconds later');
});

test('a film that never played is left to the door-hopping paths', () => {
  /* Those run first and know how to find another door; this must not take the
     failure away from them. */
  assert.equal(seekBroke(false, 10_000, 10_500, false), false);
});

test('no seek, no blame', () => {
  assert.equal(seekBroke(true, 0, 10_000, false), false, '0 means the viewer never sought');
});

test('it reopens once, so a seek that cannot work is not a loop', () => {
  assert.equal(seekBroke(true, 10_000, 10_500, true), false, 'already spent on this stream');
});

/*
 * A burst of forward/back presses — "it still crashes once I move forward or
 * backwards like a few times". Every press was its own seek and each read the
 * playhead, which the previous press had not reached yet.
 */
test('presses in a burst add up rather than each starting from the playhead', () => {
  let pending: number | null = null;
  for (let i = 0; i < 4; i++) pending = nudgeTarget(pending, 100, 10, 3600);
  assert.equal(pending, 140, 'four presses of +10s from 100s land at 140s, not 110s');
});

test('a burst stops at the ends of the film', () => {
  assert.equal(nudgeTarget(3595, 3590, 10, 3600), 3600, 'not past the end');
  assert.equal(nudgeTarget(null, 4, -10, 3600), 0, 'not before the start');
  assert.equal(nudgeTarget(null, 50, 10, 0), 60, 'unknown length is not clamped to zero');
});

/*
 * The bar for a film libVLC is playing. It drew the whole length as downloaded —
 * "it shows like the whole movie is downloaded" — because the engine exposes no
 * downloaded range. It only ever holds its cache.
 */
test('a film on libVLC draws only what the engine actually holds', () => {
  assert.equal(nativeBufferedEnd(600, 3600), 601);
  assert.ok(nativeBufferedEnd(600, 3600) < 3600, 'never the whole film');
});

test('and never draws past the end', () => {
  assert.equal(nativeBufferedEnd(3599.5, 3600), 3600);
  assert.equal(nativeBufferedEnd(10, 0), 11, 'unknown length still draws only the cache');
});

/**
 * The bar on a television, while a seek is in the air.
 *
 *     the progressbar doesnt move on tv it gets back where it is
 *     movies series "forward not working"
 *
 * libVLC owns the surface, so its `time` events are the only clock the bar
 * has — and it goes on reporting the OLD position for as long as the seek
 * takes to land, roughly four times a second. Written straight through, those
 * reports sprang the bar back within a quarter of a second, and the next press
 * was then measured from the position that had snapped back, so presses could
 * not accumulate at all.
 */
test('a native time report is believed once it is travelling to the target', () => {
  const t0 = 100_000;
  /* Nothing in flight: the engine is the only authority there is. */
  assert.equal(believeNativeTime(41, null, t0), true, 'no seek in flight');

  /* Asked to go from 40s to 300s. */
  const jump: NativeSeek = { to: 300, from: 40, at: t0 };
  assert.equal(believeNativeTime(40.3, jump, t0 + 100), false, 'still where it was');
  assert.equal(believeNativeTime(41.0, jump, t0 + 350), false, 'still playing on, pre-seek');
  assert.equal(believeNativeTime(298, jump, t0 + 900), true, 'landed a little short');
  assert.equal(believeNativeTime(300, jump, t0 + 900), true, 'landed exactly');
  assert.equal(believeNativeTime(306, jump, t0 + 900), true, 'overshot to a keyframe');

  /* Backwards, which is the same rule and the direction a tolerance constant
     would have got wrong. */
  const back: NativeSeek = { to: 50, from: 300, at: t0 };
  assert.equal(believeNativeTime(299, back, t0 + 200), false, 'still at the old position');
  assert.equal(believeNativeTime(48, back, t0 + 800), true, 'arrived');
});

test('a seek the engine never performs gives the bar back', () => {
  const t0 = 100_000;
  const jump: NativeSeek = { to: 300, from: 40, at: t0 };
  /* Six seconds of the engine insisting it is still at 40. The bar has to stop
     claiming 300 eventually: a number that is never going to become true is a
     worse lie than the one the latch exists to prevent. */
  assert.equal(believeNativeTime(40.2, jump, t0 + 5_900), false, 'still waiting');
  assert.equal(believeNativeTime(40.2, jump, t0 + 6_000), true, 'gave up and told the truth');
});

test('a drag measures from where the drag began, not from the last frame of it', () => {
  /* Every frame of a drag updates `to`; `from` is kept. If `from` were re-read
     from the optimistic `nativeTime` each frame it would equal the previous
     target, and "nearer to `to` than to `from`" would then be satisfied by a
     stale report sitting at the original position — which is the whole bug. */
  const t0 = 100_000;
  const frame40: NativeSeek = { to: 900, from: 40, at: t0 };
  assert.equal(believeNativeTime(40.5, frame40, t0 + 300), false, 'the stale report stays refused');
});
