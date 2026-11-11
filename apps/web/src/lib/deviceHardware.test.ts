import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeHardware } from './deviceInfo.ts';

/**
 * The line that turns "this brand does not work" into something answerable.
 *
 * A playback report used to say "installed app, Chromium 114", which is true of
 * every Android television ever made — and a decoder refusing a profile it
 * advertises is one maker's firmware, not Android's. Every shape below is one a
 * real box hands over.
 */

test('maker and model are joined', () => {
  assert.equal(
    describeHardware({ manufacturer: 'Hisense', model: 'HE55A6000', android: '11', tv: true }),
    'Hisense HE55A6000 (Android 11, TV)',
  );
});

test('a model that repeats the maker is not said twice', () => {
  /* Several brands ship it this way; "Xiaomi Xiaomi TV A2" is not a name. */
  assert.equal(
    describeHardware({ manufacturer: 'Xiaomi', model: 'Xiaomi TV A2', android: '12', tv: true }),
    'Xiaomi TV A2 (Android 12, TV)',
  );
  assert.equal(
    describeHardware({ manufacturer: 'TCL', model: 'TCL 55P735', android: '11', tv: true }),
    'TCL 55P735 (Android 11, TV)',
  );
});

test('brand stands in when the manufacturer is missing', () => {
  assert.equal(describeHardware({ brand: 'google', model: 'Chromecast', tv: true }), 'google Chromecast (TV)');
});

test('a phone is described without the TV note', () => {
  assert.equal(
    describeHardware({ manufacturer: 'samsung', model: 'SM-A536B', android: '14', tv: false }),
    'samsung SM-A536B (Android 14)',
  );
});

test('a box that says nothing useful produces no row at all', () => {
  /* Better an absent row than one reading "unknown", which looks like an answer. */
  assert.equal(describeHardware({}), null);
  assert.equal(describeHardware(null), null);
  assert.equal(describeHardware({ android: '11' }), null);
});

test('a model with no maker still names itself', () => {
  assert.equal(describeHardware({ model: 'AFTMM', android: '9', tv: true }), 'AFTMM (Android 9, TV)');
});
