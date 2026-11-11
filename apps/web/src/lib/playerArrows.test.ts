import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrowAction, seekBarNudge, SEEK_STEP, VOLUME_STEP } from './playerArrows.ts';

test('on a channel, up and down are the channel and the volume moves sideways', () => {
  assert.deepEqual(arrowAction('up', true, true), { do: 'channel', by: 1 });
  assert.deepEqual(arrowAction('down', true, true), { do: 'channel', by: -1 });
  assert.deepEqual(arrowAction('right', true, true), { do: 'volume', by: VOLUME_STEP });
  assert.deepEqual(arrowAction('left', true, true), { do: 'volume', by: -VOLUME_STEP });
});

test('on a film it is the other way round: up and down are volume, sideways seeks', () => {
  assert.deepEqual(arrowAction('up', false, true), { do: 'volume', by: VOLUME_STEP });
  assert.deepEqual(arrowAction('down', false, true), { do: 'volume', by: -VOLUME_STEP });
  assert.deepEqual(arrowAction('right', false, true), { do: 'seek', by: SEEK_STEP });
  assert.deepEqual(arrowAction('left', false, true), { do: 'seek', by: -SEEK_STEP });
});

/*
 * A film does not stop being a film because the page it is on has no zapping —
 * every VOD player in the app passes neither handler, and the seek is the whole
 * reason the arrows are worth having there.
 */
test('a film seeks whether or not the page can zap', () => {
  assert.deepEqual(arrowAction('right', false, false), { do: 'seek', by: SEEK_STEP });
  assert.deepEqual(arrowAction('up', false, false), { do: 'volume', by: VOLUME_STEP });
});

/*
 * Catch-up and a channel opened from the guide are live with nowhere to step to.
 * Up/down have to stay volume there rather than becoming a key that eats the
 * press — the dead end the player's doorway exists to prevent.
 */
test('live with nowhere to zap keeps the old mapping, and never invents a seek', () => {
  assert.deepEqual(arrowAction('up', true, false), { do: 'volume', by: VOLUME_STEP });
  assert.deepEqual(arrowAction('down', true, false), { do: 'volume', by: -VOLUME_STEP });
  assert.deepEqual(arrowAction('left', true, false), { do: 'nothing' });
  assert.deepEqual(arrowAction('right', true, false), { do: 'nothing' });
});

/* The volume never moves by a whole notch in one direction only: a viewer who
   turns it down and back up has to arrive where they started. */
test('the two volume directions are the same size', () => {
  const up = arrowAction('up', false, false);
  const down = arrowAction('down', false, false);
  assert.equal(up.do === 'volume' && down.do === 'volume' && up.by + down.by, 0);
});

/* The bar a remote could select and not move. Left and right scrub it; up and
   down have to keep leaving it, or the focus ring is stuck on a slider. */
test('sideways moves the playhead on the seek bar, vertical still walks off it', () => {
  assert.equal(seekBarNudge('right', true), SEEK_STEP);
  assert.equal(seekBarNudge('left', true), -SEEK_STEP);
  assert.equal(seekBarNudge('up', true), null, 'up is how you get back to the picture');
  assert.equal(seekBarNudge('down', true), null, 'down is how you reach the buttons');
});

test('nothing happens anywhere else — the bar has to be the selected control', () => {
  for (const i of ['left', 'right', 'up', 'down'] as const) {
    assert.equal(seekBarNudge(i, false), null);
  }
});

/* Both directions the same size: a viewer who overshoots and comes back has to
   arrive where they started, the same rule the volume keeps. */
test('the two seek directions are the same size', () => {
  assert.equal((seekBarNudge('right', true) ?? 0) + (seekBarNudge('left', true) ?? 0), 0);
});
