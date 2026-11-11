import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeBindings, addLayer, dispatch, fallback, isBound, isFieldSubmit, labelOf, stillTyping,
} from './keys.ts';
import { pushBackHandler } from './nativeBack.ts';

test('the topmost layer wins', () => {
  const calls: string[] = [];
  const bottom = addLayer([{ intent: 'red', label: 'Favourite', act: () => calls.push('bottom') }]);
  const top = addLayer([{ intent: 'red', label: 'Record', act: () => calls.push('top') }]);
  assert.equal(dispatch('red'), true);
  assert.deepEqual(calls, ['top']);
  // …and the one underneath takes over again when it closes.
  top();
  assert.equal(dispatch('red'), true);
  assert.deepEqual(calls, ['top', 'bottom']);
  bottom();
});

test('an unbound intent is nobody’s, so the caller can fall back', () => {
  const off = addLayer([{ intent: 'red', label: 'Favourite', act: () => {} }]);
  assert.equal(dispatch('down'), false, 'arrows fall through to focus movement');
  off();
});

test('a raw handler answers before the table', () => {
  const seen: string[] = [];
  const off = addLayer(
    [{ intent: 'up', label: 'Louder', act: () => seen.push('act') }],
    (intent) => { seen.push(`handle:${intent}`); return intent === 'up'; },
  );
  assert.equal(dispatch('up'), true);
  assert.deepEqual(seen, ['handle:up'], 'the handler claimed it, the act never ran');
  off();
});

test('a handler that declines lets the layer below have it', () => {
  const calls: string[] = [];
  const bottom = addLayer([{ intent: 'guide', label: 'Guide', act: () => calls.push('bottom') }]);
  const top = addLayer([], () => false);
  assert.equal(dispatch('guide'), true);
  assert.deepEqual(calls, ['bottom']);
  top(); bottom();
});

test('a binding with no act is a legend entry, not a handler', () => {
  // The player publishes its own keys for display while handling them itself.
  const off = addLayer([{ intent: 'subtitles', label: 'Subtitles' }]);
  assert.equal(isBound('subtitles'), true);
  assert.equal(labelOf('subtitles'), 'Subtitles');
  assert.equal(dispatch('subtitles'), false, 'nothing to run');
  off();
});

/**
 * A held Escape on a USB keyboard has to reach `nativeBack` as a repeat, not
 * as N fresh presses.
 *
 * `fallback` used to call `handleBack()` bare — always a fresh press, whatever
 * the real key event said — so a held Escape raced the three-press exit
 * gesture and would dismiss `ExitDialog` under the very hold that opened it;
 * both of those are guarded in `nativeBack.ts` by reading `repeat`, and a
 * `pushBackHandler` stand-in here is the same probe `nativeBack.test.ts` uses
 * to pin that `handleBack` is told the truth.
 */
test('a held Escape reaches nativeBack as a repeat, not a fresh press', () => {
  const seen: boolean[] = [];
  const off = pushBackHandler((repeat) => { seen.push(repeat); return true; });
  try {
    assert.equal(fallback('exit', false), true, 'the fresh press is claimed');
    assert.equal(fallback('exit', true), true, 'so is the repeat');
    assert.deepEqual(seen, [false, true], 'nativeBack sees exactly what the key event said');
  } finally {
    off();
  }
});

test('fallback defaults to a fresh press, for the one path with no repeat to give', () => {
  /* `streamix:remotekey` (installKeys) carries no repeat flag at all — the
     Android forwarder's CustomEvent detail is just a keyCode. Absent means
     fresh, same as `handleBack`'s own default. */
  const seen: boolean[] = [];
  const off = pushBackHandler((repeat) => { seen.push(repeat); return true; });
  try {
    assert.equal(fallback('exit'), true);
    assert.deepEqual(seen, [false]);
  } finally {
    off();
  }
});

test('the legend merges layers, topmost label winning', () => {
  const bottom = addLayer([
    { intent: 'red', label: 'Favourite', act: () => {} },
    { intent: 'green', label: 'Search', act: () => {} },
  ]);
  const top = addLayer([{ intent: 'red', label: 'Record', act: () => {} }]);
  const shown = activeBindings();
  assert.equal(shown.find((b) => b.intent === 'red')?.label, 'Record');
  assert.equal(shown.find((b) => b.intent === 'green')?.label, 'Search', 'lower layers still show');
  top(); bottom();
  assert.deepEqual(activeBindings(), [], 'nothing bound once the screens are gone');
});

/*
 * `isFieldSubmit` decides what a focused field's own `onKeyDown` treats as
 * "go" — reported as "when the keyboard opens and you press OK... instead of
 * pressing enter it presses a number or a character". The platform's own
 * on-screen keyboard is a grid a D-pad drives; when the highlighted key
 * really is a letter or digit, `key` is that character and this rightly says
 * no — there is nothing to submit, the field's own `onChange` already has
 * it. This is only for telling a genuine Enter apart from an IME still
 * composing one.
 */
test('a plain Enter is a submit', () => {
  assert.equal(isFieldSubmit('Enter', false, 13), true);
});

test('a character the on-screen keyboard typed is never a submit', () => {
  // The exact shape of the report: OK landed on a digit or a letter, and the
  // field is left with a character in it rather than an action having run.
  assert.equal(isFieldSubmit('5', false, 53), false);
  assert.equal(isFieldSubmit('q', false, 81), false);
});

test('an Enter still mid-composition is not a submit', () => {
  // A CJK IME confirms its own candidate with Enter; that keydown has to
  // reach the field, not be read as "go".
  assert.equal(isFieldSubmit('Enter', true, 13), false);
});

test('keyCode 229 says the same thing an older WebView cannot say any other way', () => {
  // Chrome 83-90 — the range this app still supports on an Android TV box —
  // reports 229 for every key while composing, Enter included, regardless of
  // whether `isComposing` itself came through.
  assert.equal(isFieldSubmit('Enter', false, 229), false);
});

test('Tab, Escape and a plain character are not a submit either', () => {
  assert.equal(isFieldSubmit('Tab', false, 9), false);
  assert.equal(isFieldSubmit('Escape', false, 27), false);
});

/*
 * A field's BACK handler must not answer for a field the viewer has left.
 *
 * The regression this guards: the handler's only way off the stack was a
 * `{ once: true }` blur listener, and Chromium fires no blur for a focused
 * element that is removed from the document. Every stranded registration then
 * consumed BACK forever, because it reported `true` whatever had happened to
 * the field — which is how driving the app fast made BACK stop working.
 */
test('a field that left the page no longer answers BACK', () => {
  const live = { isConnected: true } as unknown as Element;
  const removed = { isConnected: false } as unknown as Element;

  assert.equal(stillTyping(live, live), true, 'the focused field answers');
  assert.equal(stillTyping(removed, null), false, 'a removed field does not');
  assert.equal(
    stillTyping(live, null),
    false,
    'still in the page but no longer focused: not ours either',
  );
  assert.equal(
    stillTyping(live, { isConnected: true } as unknown as Element),
    false,
    'focus moved to a different field: that field has its own registration',
  );
});

/*
 * A held button: the difference between "do it again" and "you meant it once".
 *
 * Android repeats a held key every 30-50ms and `act` takes no arguments, so
 * before this every tick was a full action — a destination button held for a
 * second pushed twenty-five history entries, and BACK then could not get out of
 * them. The arrows, volume, channel and seek must keep repeating, because that
 * is what every television does.
 */
const held = { repeat: true } as unknown as KeyboardEvent;
const tapped = { repeat: false } as unknown as KeyboardEvent;

test('holding a destination button acts once, not once per repeat', () => {
  const calls: string[] = [];
  const off = addLayer([{ intent: 'guide', label: 'Guide', act: () => calls.push('guide') }]);

  assert.equal(dispatch('guide', tapped), true);
  assert.deepEqual(calls, ['guide'], 'the press itself acts');

  assert.equal(dispatch('guide', held), true, 'and the repeats are still consumed…');
  assert.equal(dispatch('guide', held), true);
  assert.deepEqual(calls, ['guide'], '…without acting again');
  off();
});

test('the arrows, volume, channel and seek keep repeating', () => {
  const calls: string[] = [];
  const off = addLayer([
    { intent: 'up', label: 'Up', act: () => calls.push('up') },
    { intent: 'volumeUp', label: 'Louder', act: () => calls.push('vol') },
    { intent: 'channelDown', label: 'Channel', act: () => calls.push('ch') },
    { intent: 'forward', label: 'Seek', act: () => calls.push('seek') },
  ]);
  for (const intent of ['up', 'volumeUp', 'channelDown', 'forward'] as const) {
    dispatch(intent, held);
    dispatch(intent, held);
  }
  assert.deepEqual(calls, ['up', 'up', 'vol', 'vol', 'ch', 'ch', 'seek', 'seek']);
  off();
});

test('a digit repeats, the way a channel number typed on a remote does', () => {
  const calls: string[] = [];
  const off = addLayer([{ intent: 'digit1', label: '1', act: () => calls.push('1') }]);
  dispatch('digit1', held);
  dispatch('digit1', held);
  assert.deepEqual(calls, ['1', '1']);
  off();
});

test('a repeat nobody has bound is left for the fallback to move focus with', () => {
  /* `dispatch` reporting "handled" here would take the press away from the
     focus engine, which is the thing that makes a held arrow scroll at all. */
  assert.equal(dispatch('menu', held), false);
});

test('BACK carries its own repeat through to the exit question', () => {
  /* Not decided in `dispatch`: `handleBack` needs to know a held BACK from a
     fresh one, so the same hold cannot open the exit prompt and confirm it. */
  const calls: string[] = [];
  const off = addLayer([{ intent: 'exit', label: 'Back', act: () => calls.push('exit') }]);
  dispatch('exit', held);
  dispatch('exit', held);
  assert.deepEqual(calls, ['exit', 'exit'], 'exit is passed on, not swallowed here');
  off();
});
