import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from './admin.ts';

test('versions compare by number, not by string', () => {
  // "1.10.0" < "1.9.0" as strings, and that would force-update everyone on 1.10.
  assert.equal(compareVersions('1.10.0', '1.9.0') > 0, true);
  assert.equal(compareVersions('1.4.0', '1.4.1') < 0, true);
  assert.equal(compareVersions('2.0.0', '1.99.99') > 0, true);
});

test('a missing part is a zero, so 1.4 and 1.4.0 are the same build', () => {
  // Both spellings ship in the wild; treating them as different would force one
  // pointless update on every device.
  assert.equal(compareVersions('1.4', '1.4.0'), 0);
  assert.equal(compareVersions('1.4.0.0', '1.4'), 0);
});

test('junk sorts as zero rather than throwing', () => {
  assert.equal(compareVersions('', '0.0.0'), 0);
  assert.equal(compareVersions('nightly', '0.0.1') < 0, true);
});

/* ── paging ────────────────────────────────────────────────────────────────── */

import { paging } from './admin.ts';

test('a page size cannot be talked past its cap', () => {
  assert.equal(paging({ size: '1000000' }).limit, 200);
  assert.equal(paging({ size: '0' }).limit, 50);
  assert.equal(paging({ size: 'banana' }).limit, 50);
  assert.equal(paging({ page: '-5' }).offset, 0);
  assert.deepEqual(paging({ page: '3', size: '25' }), { limit: 25, offset: 75, page: 3, size: 25 });
});

