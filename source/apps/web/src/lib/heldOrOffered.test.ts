import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldOrOffered } from './localRead.ts';

/**
 * The rule that broke twice, in the same way, for the same reason.
 *
 * An on-demand library downloads packages when somebody opens them, so "how many
 * films are on this device" is zero for every device nobody has browsed yet. That
 * was survivable while a zero merely produced an empty grid. It stopped being
 * survivable the moment sections with a count of zero began to be HIDDEN: a
 * subscription with 96,821 items behind it lost its MOVIES and SERIES tiles and
 * was left showing a single enormous LIVE TV button.
 *
 * Counting only downloaded items hid a section from every device that had not
 * already opened it, which is every device. So the rule is one function now, and
 * it is tested.
 */

const cat = (kind: number, itemCount: number) => ({ kind, itemCount });

/** 2 is films, 3 is series, in the catalogue's own numbering. */
const FILM = 2;
const SERIES = 3;

test('a library that offers films has films, even with none downloaded', () => {
  // The reported bug, exactly: structure arrives with the library, packages do not.
  const categories = [cat(FILM, 12_000), cat(FILM, 8_000), cat(SERIES, 4_000)];
  assert.equal(heldOrOffered(0, categories, FILM), 20_000);
  assert.equal(heldOrOffered(0, categories, SERIES), 4_000);
});

test('a library that offers none still has none', () => {
  // The free public lists are channel directories: every category is kind 1, so
  // nothing here may resurrect a films section that does not exist.
  const channelsOnly = [cat(1, 900), cat(1, 566)];
  assert.equal(heldOrOffered(0, channelsOnly, FILM), 0);
  assert.equal(heldOrOffered(0, channelsOnly, SERIES), 0);
});

test('what is actually downloaded wins when it is the larger number', () => {
  // Categories can under-report — a panel that gives no per-category count sends
  // zero — and a device holding 500 films must never be told it has none.
  assert.equal(heldOrOffered(500, [cat(FILM, 0)], FILM), 500);
  assert.equal(heldOrOffered(500, [], FILM), 500);
});

test('a category with no count at all does not poison the sum', () => {
  const categories = [cat(FILM, 300), { kind: FILM }, cat(FILM, 200)];
  assert.equal(heldOrOffered(0, categories, FILM), 500);
});

test('kinds do not bleed into each other', () => {
  const categories = [cat(FILM, 1000), cat(SERIES, 50), cat(1, 9999)];
  assert.equal(heldOrOffered(0, categories, FILM), 1000);
  assert.equal(heldOrOffered(0, categories, SERIES), 50);
});

test('an empty library is empty, which is what sends the app to Live TV', () => {
  assert.equal(heldOrOffered(0, [], FILM), 0);
});
