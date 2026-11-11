import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, loudEnough } from './nativeListen.ts';

/**
 * The two pure pieces of the native tap.
 *
 * `loudEnough` is the one that matters: frames arriving is NOT audio arriving.
 * A recorder capturing nothing still delivers perfectly punctual silence at
 * 32,000 bytes a second, and captions fed on silence sit behind a spinner for
 * ever — a worse answer than the honest message this feature replaced. It was
 * measured happening: libVLC on a Google TV image reported `stop(706): called
 * with 0 frames delivered` and the capture returned ten seconds of zeroes.
 */

function pcm(samples: number[]): ArrayBuffer {
  const b = new ArrayBuffer(samples.length * 2);
  const v = new DataView(b);
  samples.forEach((s, i) => v.setInt16(i * 2, s, true));
  return b;
}

test('silence is silence, however long the frame', () => {
  assert.equal(loudEnough(pcm(new Array(1600).fill(0))), false);
});

test('and a whisper is not', () => {
  /* The floor is a floor, not a gate on quiet dialogue: anything above a couple
     of hundred counts, which is far below speech and far above dither. */
  assert.equal(loudEnough(pcm(new Array(1600).fill(50))), false);
  assert.equal(loudEnough(pcm(new Array(1600).fill(600))), true);
  assert.equal(loudEnough(pcm(new Array(1600).fill(-600))), true, 'negative samples are sound too');
});

test('one loud sample in a quiet frame is enough', () => {
  const s = new Array(1600).fill(0);
  s[800] = 9000;
  assert.equal(loudEnough(pcm(s)), true);
});

test('an empty frame cannot be loud', () => {
  assert.equal(loudEnough(new ArrayBuffer(0)), false);
  assert.equal(loudEnough(new ArrayBuffer(1)), false, 'a half sample must not read past the end');
});

test('base64 comes back as the bytes that went in', () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const b64 = Buffer.from(bytes).toString('base64');
  assert.deepEqual(new Uint8Array(decode(b64)), bytes);
});

/**
 * Why a plugin proxy may never be the RESOLVED VALUE of a promise.
 *
 *     page: unhandled rejection:
 *     Error: "StreamixListen.then()" is not implemented on android
 *
 * Sent from a television, and the reason live captions "kept loading" from
 * 1.34.0 until it was found. `plugin()` was an `async` function that returned
 * the Capacitor proxy. Resolving an async function awaits its return value,
 * awaiting asks the value for `.then`, and a Capacitor proxy answers EVERY
 * property access by treating it as a native method call. So the language's
 * own bookkeeping invoked a method named `then`, Android had none, and the
 * promise rejected before any caption code ran.
 *
 * This reproduces the trap against a stand-in with the proxy's defining
 * behaviour, and shows that the one-field box is what defuses it.
 */
test('resolving a promise with a Capacitor-shaped proxy calls then() on it', async () => {
  const touched: string[] = [];
  const proxy = new Proxy({}, {
    get(_t, prop) {
      touched.push(String(prop));
      /* What `registerPlugin` does for a method the platform lacks. */
      return () => { throw new Error(`"StreamixListen.${String(prop)}()" is not implemented on android`); };
    },
  });

  await assert.rejects(
    (async () => proxy)(),
    /"StreamixListen\.then\(\)" is not implemented on android/,
    'returning the proxy from an async function must be what breaks',
  );
  assert.ok(touched.includes('then'), `expected .then to be read, saw ${touched.join(', ')}`);
});

test('a plain box carrying the proxy is resolved without touching it', async () => {
  const touched: string[] = [];
  const proxy = new Proxy({}, {
    get(_t, prop) {
      touched.push(String(prop));
      return () => { throw new Error(`"StreamixListen.${String(prop)}()" is not implemented on android`); };
    },
  }) as Record<string, unknown>;

  const held = await (async () => ({ api: proxy }))();
  assert.equal(held.api, proxy, 'the proxy survives the round trip');
  assert.deepEqual(touched, [], `the box must not be probed, saw ${touched.join(', ')}`);
});
