import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioRoute } from './captionAudio.ts';

/**
 * Where the captions get their audio from.
 *
 * Three lines, and the value of pinning them is that the previous version of
 * this decision routed live video through the operator's own server to answer
 * the same question. What is asserted here is that the answer is now always one
 * of: use the element, ask the viewer, or say plainly that it cannot be done.
 * Never: do something expensive without being asked.
 */

test('sound in the element is tapped, as it always was', () => {
  assert.equal(audioRoute({ silent: false, pinned: false, nativeAudio: false }), 'element');
  assert.equal(audioRoute({ silent: false, pinned: true, nativeAudio: true }), 'element');
});

test('a silent element offers the viewer the other engine', () => {
  assert.equal(audioRoute({ silent: true, pinned: false, nativeAudio: false }), 'offer');
});

test('nothing reloads on its own — the offer is the whole action', () => {
  /* The route is a description, not a command: `start()` emits it and stops.
     Every earlier design that reloaded the picture from inside `start()` had to
     defend against restarting itself, because the reload restarts the caption
     engine. There is nothing to defend against here. */
  assert.notEqual(audioRoute({ silent: true, pinned: false, nativeAudio: false }), 'element');
});

test('already switched and still silent says so instead of offering again', () => {
  /* A Samsung or LG set: the browser engine cannot demux a transport stream
     either, and there is no libVLC to swap in. Offering the same switch a second
     time would be offering something already watched to fail. */
  assert.equal(audioRoute({ silent: true, pinned: true, nativeAudio: false }), 'refuse');
});

test('a device that can record its own output does that instead of asking', () => {
  /* Strictly better where it exists: libVLC keeps the picture, and the audio is
     already decoded, so AC-3 and HEVC channels work too — those are exactly the
     ones the browser engine could never have played. */
  assert.equal(audioRoute({ silent: true, pinned: false, nativeAudio: true }), 'native');
  /* Even on a channel already pinned to the browser engine: the pin was a
     compromise and this is not. */
  assert.equal(audioRoute({ silent: true, pinned: true, nativeAudio: true }), 'native');
});

test('and a build without it is never assumed to have it', () => {
  /* The website, an Android 9 box, and an APK built before the plugin existed
     all answer no — and all of them still get the offer rather than an error. */
  assert.equal(audioRoute({ silent: true, pinned: false, nativeAudio: false }), 'offer');
});
