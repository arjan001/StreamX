import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neighbourIndexes } from './reel.ts';

test('the middle of a list has a neighbour on each side', () => {
  assert.deepEqual(neighbourIndexes(3, 10), { prev: 2, next: 4 });
});

test('both ends wrap, so neither button can vanish mid-film', () => {
  assert.deepEqual(neighbourIndexes(0, 4), { prev: 3, next: 1 });
  assert.deepEqual(neighbourIndexes(3, 4), { prev: 2, next: 0 });
});

test('a pair points at each other', () => {
  assert.deepEqual(neighbourIndexes(0, 2), { prev: 1, next: 1 });
  assert.deepEqual(neighbourIndexes(1, 2), { prev: 0, next: 0 });
});

test('a package holding one title offers no neighbours at all', () => {
  assert.equal(neighbourIndexes(0, 1), null, 'two buttons that reload the same film is worse than none');
});

test('a position that is not in the list is refused rather than guessed at', () => {
  assert.equal(neighbourIndexes(-1, 10), null, 'not found');
  assert.equal(neighbourIndexes(10, 10), null, 'past the end');
  assert.equal(neighbourIndexes(0, 0), null, 'nothing to be in');
  assert.equal(neighbourIndexes(1.5, 10), null, 'not a row');
});
