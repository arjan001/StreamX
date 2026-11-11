import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVariant } from './liveQuality.ts';
import type { Variant } from './api';

function v(quality: string, id: number): Variant {
  return { id, name: quality, quality, ext: 'ts', active: false };
}

const set = [v('4K', 1), v('FHD', 2), v('HEVC', 3), v('HD', 4), v('SD', 5)];

test('manual lock uses that label', () => {
  assert.equal(pickVariant(set, 'HD', 50).id, 4);
  assert.equal(pickVariant(set, 'FHD RAW', 50).quality, 'FHD');
});

test('auto on a fast link takes 4K', () => {
  assert.equal(pickVariant(set, 'auto', 20).quality, '4K');
});

test('auto on a typical link prefers HEVC over 4K', () => {
  assert.equal(pickVariant(set, 'auto', 8).quality, 'HEVC');
  assert.equal(pickVariant(set, 'auto', null).quality, 'HEVC');
});

test('auto on a slow link stays at SD', () => {
  assert.equal(pickVariant(set, 'auto', 1).quality, 'SD');
});

test('a missing lock still returns a feed', () => {
  assert.equal(pickVariant([v('HD', 9)], '4K', null).quality, 'HD');
});
