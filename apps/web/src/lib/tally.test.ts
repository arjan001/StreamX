import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTally } from './tally.ts';

test('zero is nothing at all, not "0"', () => {
  assert.equal(formatTally(0), null);
});

test('a real count is grouped for reading', () => {
  assert.equal(formatTally(1), '1');
  assert.equal(formatTally(148497), (148497).toLocaleString());
});

test('nothing to count is also nothing to print', () => {
  assert.equal(formatTally(null), null);
  assert.equal(formatTally(undefined), null);
  assert.equal(formatTally(Number.NaN), null);
});

test('a negative count is a bug upstream, and prints nothing rather than a minus', () => {
  assert.equal(formatTally(-3), null);
});
