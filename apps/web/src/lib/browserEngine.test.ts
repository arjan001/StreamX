import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setKVBackend } from './kv.ts';
import {
  chooseEngine, forgetLearnedEngines, forgetWantsBrowser,
  rememberNeedsNative, rememberWantsBrowser, wantsBrowser,
} from './nativePlayer.ts';

/* Node has no localStorage; the same in-memory backend the other kv tests use. */
const store = new Map<string, string>();
setKVBackend({
  get: (k) => store.get(k) ?? null,
  set: (k, v) => { store.set(k, v); },
  remove: (k) => { store.delete(k); },
});

/**
 * "Play this one channel in the browser engine."
 *
 * The request exists for captions: they listen to the `<video>` element, a
 * channel libVLC is playing has nothing in that element, and the only audio this
 * app can reach without a second connection to the panel or a byte of the
 * operator's bandwidth is the audio already in the page.
 *
 * Which makes the ORDER inside `chooseEngine` the whole of it. Every live
 * channel on this line is a raw `.ts`, and the container rule sends every `.ts`
 * to libVLC — so a request read after that rule is a request that never happens.
 */

const CHANNEL = {
  native: true,
  container: 'mpegts',
  url: 'http://panel.example/live/user/pass/812064.ts',
  key: 'live:812064',
};

test('by default a live transport stream goes to the native engine', () => {
  forgetLearnedEngines();
  assert.equal(chooseEngine(CHANNEL), 'native');
});

test('and the viewer can ask for this one channel in the browser engine', () => {
  forgetLearnedEngines();
  rememberWantsBrowser(CHANNEL.key);
  assert.equal(wantsBrowser(CHANNEL.key), true);
  /* Read BEFORE the container rule, or it would be overruled by the very rule
     that creates the problem. */
  assert.equal(chooseEngine(CHANNEL), 'webview');
});

test('it is one channel, not a preference over all of them', () => {
  forgetLearnedEngines();
  rememberWantsBrowser(CHANNEL.key);
  assert.equal(
    chooseEngine({ ...CHANNEL, key: 'live:999', url: 'http://panel.example/live/u/p/999.ts' }),
    'native',
    'asking for one channel moved a different one',
  );
});

test('a stream measured failing in the WebView takes the request back', () => {
  /* Otherwise a channel could be pinned to an engine that has just been watched
     going black, with no way out but Settings. `rememberNeedsNative` is called
     when the WebView failed and libVLC then played it — the stream has answered
     the question, so the request is spent. */
  forgetLearnedEngines();
  rememberWantsBrowser(CHANNEL.key);
  rememberNeedsNative(CHANNEL.key);
  assert.equal(wantsBrowser(CHANNEL.key), false);
  assert.equal(chooseEngine(CHANNEL), 'native');
});

test('and it can be taken back by hand', () => {
  forgetLearnedEngines();
  rememberWantsBrowser(CHANNEL.key);
  forgetWantsBrowser(CHANNEL.key);
  assert.equal(chooseEngine(CHANNEL), 'native');
});

test('forgetting the learned engines forgets these too', () => {
  rememberWantsBrowser(CHANNEL.key);
  forgetLearnedEngines();
  assert.equal(wantsBrowser(CHANNEL.key), false);
});

test('nothing is pinned on a build with no native engine to leave', () => {
  forgetLearnedEngines();
  rememberWantsBrowser(CHANNEL.key);
  assert.equal(chooseEngine({ ...CHANNEL, native: false }), 'webview');
});
