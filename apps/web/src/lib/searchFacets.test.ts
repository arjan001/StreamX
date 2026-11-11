import assert from 'node:assert/strict';
import test from 'node:test';
import { foldText } from '@iptv/core-store';
import { titleCasePerson } from './searchFacets.ts';

test('titleCasePerson', () => {
  assert.equal(titleCasePerson('jennifer aniston'), 'Jennifer Aniston');
  assert.equal(titleCasePerson('john'), 'John');
});

test('foldText matches cast storage', () => {
  assert.equal(foldText('Jennifer Aniston'), 'jennifer aniston');
});
