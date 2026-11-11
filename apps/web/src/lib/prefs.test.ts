/**
 * The defaults revision, which exists so a reversal can reach a device that
 * already saved the old default.
 *
 * `openStyle` shipped as `fullscreen` in 1.9.0 on the owner's own argument and
 * came back the other way once other people had used it. Changing the fallback
 * alone would have reached nobody who had reported it: `persist()` runs from
 * every setter, so any box that has favourited anything has the old default
 * written into its record, and a stored `fullscreen` is indistinguishable from a
 * chosen one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_OPEN_MS, adoptedBrowseStyle, adoptedOpenStyle, getPrefs, moveFav, readAutoOpen, setPrefs, toggleFav,
} from './prefs.ts';

test('an absent setting takes the current default', () => {
  assert.equal(adoptedOpenStyle(undefined, undefined), 'page');
  assert.equal(adoptedOpenStyle(null, 1), 'page');
  assert.equal(adoptedOpenStyle('nonsense', 1), 'page');
});

test('a record written before the revision gives up the old default, once', () => {
  /* The whole point: a box running 1.9.0 has `fullscreen` persisted and no
     revision beside it, and must end up on the new default. */
  assert.equal(adoptedOpenStyle('fullscreen', undefined), 'page');
  assert.equal(adoptedOpenStyle('fullscreen', 0), 'page');
});

test('a choice made AFTER the revision is never overridden', () => {
  /* Once anything is set, `store.defaultsRev` persists alongside it — so this is
     somebody who went into Settings and asked for the picture, and a later run
     must not quietly undo them. */
  assert.equal(adoptedOpenStyle('fullscreen', 1), 'fullscreen');
  assert.equal(adoptedOpenStyle('fullscreen', 2), 'fullscreen');
});

test('the revision does not touch a setting it was not written for', () => {
  /* `page` is the new default and also a valid explicit choice; either way it
     passes through whatever the revision says. */
  assert.equal(adoptedOpenStyle('page', undefined), 'page');
  assert.equal(adoptedOpenStyle('page', 1), 'page');
});

/* ── revision 4: Live opens on the plain list ───────────────────────────────── */

test('an absent browse style is the plain list', () => {
  for (const raw of [undefined, null, '', 'tree', 'flat', true, 1, {}]) {
    assert.equal(adoptedBrowseStyle(raw, 4), 'list', JSON.stringify(raw));
  }
  assert.equal(adoptedBrowseStyle(undefined, undefined), 'list');
});

test('a groups saved before revision 4 was the old default, and is read as the new one', () => {
  /* `persist()` writes the whole record from every setter, so nearly every
     device has `groups` stored beside an older revision without anybody
     choosing it. */
  assert.equal(adoptedBrowseStyle('groups', undefined), 'list');
  assert.equal(adoptedBrowseStyle('groups', 1), 'list');
  assert.equal(adoptedBrowseStyle('groups', 3), 'list');
});

test('a groups chosen at or after revision 4 is kept, and list always is', () => {
  assert.equal(adoptedBrowseStyle('groups', 4), 'groups');
  assert.equal(adoptedBrowseStyle('groups', 5), 'groups');
  assert.equal(adoptedBrowseStyle('list', 0), 'list');
  assert.equal(adoptedBrowseStyle('list', 3), 'list');
});

test('revision 2 leaves revision 1 exactly where it was', () => {
  /* Bumping the number must not re-run the open-style rule for somebody who
     chose the picture after 1.9.0 — their record says revision 1, and `< 1` is
     still the threshold that rule answers to. */
  assert.equal(adoptedOpenStyle('fullscreen', 1), 'fullscreen');
  assert.equal(adoptedOpenStyle('fullscreen', 0), 'page');
});

/* ── resting on a channel ──────────────────────────────────────────────────── */

test('auto-open is OFF unless it was stored, whatever the storage says', () => {
  /*
   * The default matters more here than anywhere else in prefs: every time this
   * fires it asks the provider for a stream, and this account's log has already
   * recorded what a burst of opens costs — seven doors burned in sixty-five
   * seconds, then the panel API taking 38 seconds and failing. So an absent
   * value, a corrupt one, or anything unrecognised means off.
   */
  for (const raw of [undefined, null, '', 'yes', true, 1, 'On', 'RELAXED', {}]) {
    assert.equal(readAutoOpen(raw), 'off', JSON.stringify(raw));
  }
});

test('both speeds round-trip', () => {
  assert.equal(readAutoOpen('relaxed'), 'relaxed');
  assert.equal(readAutoOpen('quick'), 'quick');
});

test('the slow setting really is the slower one, and both leave room to move on', () => {
  assert.ok(AUTO_OPEN_MS.relaxed > AUTO_OPEN_MS.quick);
  /* A viewer walking a list at roughly one row per second must open nothing, so
     the quick setting cannot drop below about a second. */
  assert.ok(AUTO_OPEN_MS.quick >= 1000);
  assert.ok(AUTO_OPEN_MS.relaxed >= 2000);
});

/* ── the bouquet's own order ────────────────────────────────────────────────
 *
 * `moveFav` is the same `moveTo`-shaped move `lib/ordering.test.ts` already
 * covers for `catOrder` — down lands where it was dropped, a no-op move
 * changes nothing, a move past either end clamps rather than losing the row —
 * applied to favourites instead: a FULL list rather than a partial order, and
 * keyed by provider id rather than by ref. Every test sets `favs` directly
 * with `setPrefs` rather than building it up through `toggleFav`, so each one
 * starts from a list it fully controls rather than whatever an earlier test
 * left behind — there is one module-level store for the whole file, same as
 * the real app has one store for the whole session.
 */

test('moving a favourite down lands it where it was dropped', () => {
  setPrefs({ favs: { live: [1, 2, 3, 4], movies: [], series: [] } });
  moveFav('live', 1, 2);
  assert.deepEqual(getPrefs().favs.live, [2, 3, 1, 4]);
});

test('moving a favourite up lands it where it was dropped', () => {
  setPrefs({ favs: { live: [1, 2, 3, 4], movies: [], series: [] } });
  moveFav('live', 4, 1);
  assert.deepEqual(getPrefs().favs.live, [1, 4, 2, 3]);
});

test('a move to nowhere changes nothing', () => {
  setPrefs({ favs: { live: [1, 2, 3], movies: [], series: [] } });
  moveFav('live', 2, 1);
  assert.deepEqual(getPrefs().favs.live, [1, 2, 3]);
});

test('a move past either end clamps rather than losing the channel', () => {
  setPrefs({ favs: { live: [1, 2, 3], movies: [], series: [] } });
  moveFav('live', 1, 99);
  assert.deepEqual(getPrefs().favs.live, [2, 3, 1]);

  setPrefs({ favs: { live: [1, 2, 3], movies: [], series: [] } });
  moveFav('live', 3, -99);
  assert.deepEqual(getPrefs().favs.live, [3, 1, 2]);
});

test('moving a channel that the profile never starred is a no-op', () => {
  // A stale press — the list changed under it — must not corrupt the order.
  setPrefs({ favs: { live: [1, 2, 3], movies: [], series: [] } });
  moveFav('live', 999, 0);
  assert.deepEqual(getPrefs().favs.live, [1, 2, 3]);
});

test('a move only ever touches the section it was asked to move in', () => {
  setPrefs({ favs: { live: [1, 2, 3], movies: [10, 20], series: [30] } });
  moveFav('live', 1, 2);
  assert.deepEqual(getPrefs().favs.movies, [10, 20]);
  assert.deepEqual(getPrefs().favs.series, [30]);
});

test('toggleFav still unshifts a new star to the front', () => {
  // moveFav is new; toggleFav's own behaviour — asked to be kept exactly as it
  // is — is the thing every other list on this screen already relies on.
  setPrefs({ favs: { live: [], movies: [], series: [] } });
  toggleFav('live', 5);
  toggleFav('live', 6);
  assert.deepEqual(getPrefs().favs.live, [6, 5]);
  toggleFav('live', 5);
  assert.deepEqual(getPrefs().favs.live, [6]);
});
