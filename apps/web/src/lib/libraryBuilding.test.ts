import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPhase } from './useLibraryBuilding.ts';

/**
 * "on free first visit i see an error briefly till channels are loaded"
 *
 * Measured on a cold profile before the fix, sampling every 100ms:
 *
 *     +2.4s  Catalogue Building the catalogue (0/7)   — the bar
 *     +2.7s  skeleton rows                            — the list, correct
 *     +3.0s  nothing here.                            — the list, wrong
 *     +5.3s  channels
 *
 * 2.3 seconds of a list calling the library empty directly underneath the app's
 * own progress bar saying it was still being built.
 */
test('a settled query over a half-built library is not evidence of an empty one', () => {
  /* The case the bug lived in, and the only one worth a named function: the
     query is done, the catalogue is not. */
  assert.equal(listPhase(false, true, 0), 'skeleton');
});

test('once the library is built, empty means empty', () => {
  /* The guard must not swallow the real empty state — a line with no series,
     a favourites list nobody has starred. Those have things to say and a
     permanent skeleton would be a worse bug than the flash. */
  assert.equal(listPhase(false, false, 0), 'empty');
});

test('rows win over both, so a refresh never blanks what is already readable', () => {
  /* A weekly check rebuilds behind an app that is already on screen. Showing
     skeletons over a list the viewer is reading would be a regression of its
     own. */
  assert.equal(listPhase(true, true, 40), 'rows');
  assert.equal(listPhase(false, true, 40), 'rows');
  assert.equal(listPhase(true, false, 40), 'rows');
});

test('the query loading on its own still draws skeletons', () => {
  /* Unchanged behaviour: paging, a filter change, a new category. */
  assert.equal(listPhase(true, false, 0), 'skeleton');
});
