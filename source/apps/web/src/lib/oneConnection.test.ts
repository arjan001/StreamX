import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The rule, stated as a table, because the cost of getting it wrong runs both
 * ways: route every film through the server and the operator pays for video
 * nobody asked them to carry; route none and a one-connection line cannot seek
 * a film at all.
 */
const oneOf = (n: number | null | undefined): boolean =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 && n === 1;

test('one connection is one connection', () => {
  assert.equal(oneOf(1), true);
});

test('more than one is not', () => {
  assert.equal(oneOf(2), false);
  assert.equal(oneOf(5), false);
});

test('and unknown is not one', () => {
  /* A panel that never said gets the old behaviour. Guessing "one" would send
     every film on every generous line through the server for nothing. */
  assert.equal(oneOf(null), false);
  assert.equal(oneOf(undefined), false);
  assert.equal(oneOf(0), false);
  assert.equal(oneOf(Number.NaN), false);
});
