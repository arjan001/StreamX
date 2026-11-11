/**
 * The fault this file exists for, written down as a test.
 *
 * The Android build sets Vite's base to `./`. That relative URL was handed to
 * CSS inside a custom property, and CSS resolves a relative `url()` in a custom
 * property against the STYLESHEET that spends it — which lives in `/assets/`.
 * So the television asked for `/assets/modern-bg-dark.jpg` and got nothing,
 * while the same build's `<img src>` logo loaded fine.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveAsset } from './assetUrl.ts';

test('a relative base resolves against the PAGE, not the stylesheet', () => {
  const url = resolveAsset('./modern-bg-dark.jpg?v=abc', 'https://localhost/');
  assert.equal(url, 'https://localhost/modern-bg-dark.jpg?v=abc');
  assert.ok(!url.includes('/assets/'), 'must not land in the stylesheet directory');
});

test('the hash router does not move the base', () => {
  /* The wrapper uses a hash router, so the document URL carries a fragment.
     A fragment is not a path segment and must not change where the file is. */
  const url = resolveAsset('./modern-bg-light.jpg', 'https://localhost/#/home');
  assert.equal(url, 'https://localhost/modern-bg-light.jpg');
});

test('an already-absolute base is left alone', () => {
  assert.equal(
    resolveAsset('/backdrop.jpg?v=1', 'https://iptv.example.com/movie/2.1'),
    'https://iptv.example.com/backdrop.jpg?v=1',
  );
});

test('the answer is always absolute, so nothing can re-resolve it', () => {
  for (const base of ['https://localhost/', 'https://localhost/#/live', 'http://127.0.0.1:7500/get']) {
    const url = resolveAsset('./modern-bg-dark.jpg', base);
    assert.match(url, /^https?:\/\//, `${base} produced a relative URL`);
  }
});

test('a nonsense base degrades to the relative form rather than throwing', () => {
  assert.equal(resolveAsset('./x.jpg', 'not a url'), './x.jpg');
});
