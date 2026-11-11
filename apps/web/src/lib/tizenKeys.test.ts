import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forgetTizenInstallForTest, handleTizenKeyDown, installTizenKeys, isTizen, registerTizenKeys, exitTizenApp } from './tizenKeys.ts';
import { addLayer, dispatch } from './keys.ts';
import { forgetExitPresses, onExitPrompt } from './nativeBack.ts';

/** A `KeyboardEvent` stand-in with just the fields `tizenKeys.ts` reads. No DOM
 *  is involved anywhere in this file — that is the point of exporting
 *  `handleTizenKeyDown` rather than only an anonymous listener. */
function fakeKeyDown(keyCode: number, opts: { key?: string; repeat?: boolean } = {}): KeyboardEvent {
  let prevented = false;
  return {
    keyCode,
    key: opts.key ?? 'Unidentified',
    repeat: opts.repeat ?? false,
    get defaultPrevented() { return prevented; },
    preventDefault() { prevented = true; },
  } as unknown as KeyboardEvent;
}

/** Undo whatever the previous test left on the global, so tests do not order-couple. */
function clearTizenGlobal(): void {
  // @ts-expect-error test-only teardown of a global this file itself declares
  globalThis.tizen = undefined;
  forgetTizenInstallForTest();
}

test('off Tizen: isTizen is false, and nothing here throws', () => {
  clearTizenGlobal();
  assert.equal(isTizen(), false);
  // The whole point of the guard: a browser tab and the Android APK both run
  // this file's module-level code, and neither has a `tizen` global.
  assert.doesNotThrow(() => registerTizenKeys());
  assert.doesNotThrow(() => installTizenKeys());
  clearTizenGlobal();
});

test('isTizen asks for the real API, not just a namespace that happens to exist', () => {
  clearTizenGlobal();
  // @ts-expect-error simulating a half-present global — some emulators or a
  // stray polyfill could plausibly define `tizen` without the TV APIs on it.
  globalThis.tizen = {};
  assert.equal(isTizen(), false, 'no tvinputdevice.registerKey means this is not really Tizen');

  // @ts-expect-error simulated Tizen device API surface for the test
  globalThis.tizen = { tvinputdevice: { registerKey: () => {} } };
  assert.equal(isTizen(), true);
  clearTizenGlobal();
});

test('registerTizenKeys prefers registerKeyBatch, and sends every bound name', () => {
  clearTizenGlobal();
  const batches: string[][] = [];
  // @ts-expect-error simulated Tizen device API surface for the test
  globalThis.tizen = { tvinputdevice: { registerKey: () => {}, registerKeyBatch: (names: string[]) => batches.push(names) } };
  registerTizenKeys();
  assert.equal(batches.length, 1);
  const sent = new Set(batches[0]);
  for (const name of [
    'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
    'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'MediaPlayPause',
    'ChannelUp', 'ChannelDown', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'Info',
  ]) {
    assert.ok(sent.has(name), `${name} was never registered`);
  }
  // Never the Return/Exit long-press — Samsung's docs say not to.
  assert.ok(!sent.has('Exit'));
  assert.ok(!sent.has('Return'));
  clearTizenGlobal();
});

test('registerTizenKeys falls back to one key at a time, and one bad name does not cost the rest', () => {
  clearTizenGlobal();
  const registered: string[] = [];
  // @ts-expect-error simulated older-model Tizen device API (no registerKeyBatch)
  globalThis.tizen = {
    tvinputdevice: {
      registerKey: (name: string) => {
        if (name === 'ColorF3Blue') throw new Error('unsupported on this model');
        registered.push(name);
      },
    },
  };
  assert.doesNotThrow(() => registerTizenKeys());
  assert.ok(registered.includes('ColorF0Red'));
  assert.ok(registered.includes('Info'));
  assert.ok(!registered.includes('ColorF3Blue'), 'the one that threw');
  clearTizenGlobal();
});

test('the Return key reaches the exact same exit gesture Android BACK drives', () => {
  forgetExitPresses();
  const prompts: number[] = [];
  const off = onExitPrompt((left) => prompts.push(left));

  const e = fakeKeyDown(10009); // Return — Samsung's own docs call it "Back"
  handleTizenKeyDown(e);

  assert.equal(e.defaultPrevented, true, 'nativeBack consumed the press');
  assert.deepEqual(prompts, [2], 'one of the three presses `nativeBack.ts` already counts — not a second gesture');

  off();
  forgetExitPresses();
});

test('a coloured button reaches the same dispatch table every other input source uses', () => {
  const calls: string[] = [];
  const off = addLayer([{ intent: 'red', label: 'Record', act: () => calls.push('red') }]);

  const e = fakeKeyDown(403); // ColorF0Red
  handleTizenKeyDown(e);

  assert.deepEqual(calls, ['red']);
  assert.equal(e.defaultPrevented, true);
  off();
});

test('an unbound Tizen button is a no-op, not a swallowed press', () => {
  // No layer bound to 'info' here, and 'info' has no fallback behaviour either.
  const e = fakeKeyDown(457); // Info
  handleTizenKeyDown(e);
  assert.equal(e.defaultPrevented, false);
});

test('digits already reach BY_KEY by name, so the keyCode path leaves them alone', () => {
  const calls: string[] = [];
  const off = addLayer([{ intent: 'digit7', label: '7', act: () => calls.push('digit7') }]);

  // A real Tizen (or any Chromium) keydown for the '7' key sets BOTH keyCode
  // (55, in the same numeric table this file's digit range reads) and key
  // ('7'). If this handler processed the keyCode blind to that, the digit
  // would be entered twice for one press.
  const e = fakeKeyDown(55, { key: '7' });
  handleTizenKeyDown(e);

  assert.deepEqual(calls, [], 'the ordinary keydown listener in keys.ts owns this key, not this file');
  assert.equal(e.defaultPrevented, false, 'this handler did nothing at all — it deferred, it did not consume');
  off();
});

test('an event another handler already claimed is left alone', () => {
  const calls: string[] = [];
  const off = addLayer([{ intent: 'red', label: 'Record', act: () => calls.push('red') }]);

  const e = fakeKeyDown(403);
  e.preventDefault(); // simulate: something upstream already answered this press
  handleTizenKeyDown(e);

  assert.deepEqual(calls, [], 'defaultPrevented is checked before anything else');
  off();
});

test('a keyCode with no meaning here, and no useful key name either, is simply ignored', () => {
  const e = fakeKeyDown(123456);
  assert.doesNotThrow(() => handleTizenKeyDown(e));
  assert.equal(e.defaultPrevented, false);
});

test('installTizenKeys is idempotent: registering twice does not ask the TV twice', () => {
  clearTizenGlobal();
  let calls = 0;
  // @ts-expect-error simulated Tizen device API surface for the test
  globalThis.tizen = { tvinputdevice: { registerKey: () => { calls++; } } };
  installTizenKeys();
  installTizenKeys();
  assert.equal(calls, REGISTER_NAME_COUNT, 'one registration pass, not two');
  clearTizenGlobal();
});

/** Kept in step with `REGISTER_NAMES` in tizenKeys.ts by the batch test above,
 *  which lists every name by hand; this is just the count for the idempotency
 *  check, so a change to the list does not silently need editing in two files. */
const REGISTER_NAME_COUNT = 18;

/*
 * Closing the app on a television that has no Capacitor plugin to ask.
 *
 * `ExitDialog` ends the app through `StreamixDevice.exitApp`, which a Tizen
 * build does not have — so answering "yes, leave" reached the "this build
 * cannot end itself" fallback and the app stayed open. These pin the contract
 * ExitDialog depends on: it reports whether it REALLY exited, so a false answer
 * still leaves the Android path to try.
 */
test('exitTizenApp does nothing, and says so, when this is not a Tizen device', () => {
  delete (globalThis as { tizen?: unknown }).tizen;
  assert.equal(exitTizenApp(), false, 'a browser and the APK must fall through');
});

test('exitTizenApp calls the platform and reports that it did', () => {
  let called = 0;
  (globalThis as { tizen?: unknown }).tizen = {
    application: { getCurrentApplication: () => ({ exit: () => { called += 1; } }) },
  };
  assert.equal(exitTizenApp(), true);
  assert.equal(called, 1, 'exactly once — a second call would race the shutdown');
  delete (globalThis as { tizen?: unknown }).tizen;
});

test('a Tizen too old for the application API falls through rather than throwing', () => {
  (globalThis as { tizen?: unknown }).tizen = { tvinputdevice: { registerKey: () => {} } };
  assert.equal(exitTizenApp(), false);
  delete (globalThis as { tizen?: unknown }).tizen;
});

test('a platform that refuses to exit is reported as not exited', () => {
  /* The viewer must not be left looking at a dialog that claims to have worked. */
  (globalThis as { tizen?: unknown }).tizen = {
    application: { getCurrentApplication: () => ({ exit: () => { throw new Error('denied'); } }) },
  };
  assert.equal(exitTizenApp(), false);
  delete (globalThis as { tizen?: unknown }).tizen;
});
