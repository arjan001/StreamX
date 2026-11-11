import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSqueezed, squeeze, unsqueeze } from './squeeze.ts';

/**
 * The panel payloads, kept but made small.
 *
 * 151.7MB of rows on the owner's line, stored alongside the 107.3MB catalogue
 * they were used to build, on an origin whose IndexedDB quota takes neither.
 * Deleting them was the obvious move and wrong — six paths call `rebuild()` and
 * every one reads them back — so they are compressed instead, by the browser's
 * own gzip, on the device.
 */
test('a payload survives the round trip exactly', async () => {
  const panel = {
    live: Array.from({ length: 500 }, (_, i) => ({
      num: i, name: `Channel ${i}`, stream_id: 1000 + i, category_id: String(i % 20),
      stream_icon: `http://example.test/${i}.png`, tv_archive: i % 2,
    })),
    liveCategories: [{ category_id: '1', category_name: 'News' }],
    loaded: ['*'],
  };
  const packed = await squeeze(panel);
  assert.equal(isSqueezed(packed), true, 'it should have compressed');
  assert.deepEqual(await unsqueeze(packed), panel, 'byte-for-byte the same rows back');
});

test('it actually makes the thing smaller', async () => {
  /* The whole point. Rows from a panel repeat heavily — the same keys, the same
     category ids, the same host in every icon URL — which is exactly what gzip
     is good at. Measured in a real browser on the real origin: 94%. */
  const rows = Array.from({ length: 4000 }, (_, i) => ({
    num: i, name: `A channel with a fairly long name number ${i}`,
    stream_id: 100000 + i, stream_icon: `http://example.test/logo/${i}.png`,
    epg_channel_id: `chan.${i}`, category_id: String(i % 200), custom_sid: '',
  }));
  const plain = new TextEncoder().encode(JSON.stringify(rows)).byteLength;
  const packed = await squeeze(rows);
  assert.equal(isSqueezed(packed), true);
  const small = (packed as { bytes: ArrayBuffer }).bytes.byteLength;
  assert.ok(small < plain / 4, `expected well under a quarter, got ${small} of ${plain}`);
});

test('an older uncompressed value still reads', async () => {
  /* A device that upgrades must not lose the catalogue it already holds. */
  const plain = { live: [{ name: 'stored before this existed' }], loaded: [] };
  assert.equal(isSqueezed(plain), false);
  assert.deepEqual(await unsqueeze(plain), plain);
  assert.equal(await unsqueeze(null), null);
});

test('failing to compress is not failing to save', async () => {
  /* No CompressionStream — an old WebView, a locked-down engine. Storing the
     value as it is beats refusing to store it at all. */
  const had = Reflect.get(globalThis, 'CompressionStream');
  Reflect.deleteProperty(globalThis, 'CompressionStream');
  try {
    const v = { live: [{ name: 'x' }] };
    const out = await squeeze(v);
    assert.equal(isSqueezed(out), false);
    assert.deepEqual(out, v);
  } finally {
    if (had) Object.defineProperty(globalThis, 'CompressionStream', { value: had, configurable: true });
  }
});
