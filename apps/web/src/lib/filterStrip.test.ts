import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStrip, stripKey } from './filterStrip.ts';

test('the strip is shut unless somebody opened it', () => {
  assert.equal(readStrip(null), false, 'never chosen');
  assert.equal(readStrip('0'), false);
  assert.equal(readStrip('1'), true);
  assert.equal(readStrip('garbage'), false, 'an unreadable value is the default, not open');
});

test('each section remembers its own answer', () => {
  assert.notEqual(stripKey('movies'), stripKey('series'));
  assert.notEqual(stripKey('movies'), stripKey('series'));
});
