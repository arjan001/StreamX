import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, brandRev, loadBrand } from './brand-kit.mjs';

/**
 * A stable asset name plus a long cache is a stale splash, and it happened.
 *
 * The brand images are served from fixed names — `brand-logo.png`,
 * `brand-mark.png`, `backdrop.jpg` — and `staticCacheControl` in the API gives
 * anything unhashed `public, max-age=86400`. `index.html` is `no-cache`, so a
 * new document arrives at once; the pictures it names do not, because their
 * URLs did not change.
 *
 * Measured after the logo was replaced: the server was serving the new 90,815
 * bytes and the splash — the very first thing anybody sees — was still the old
 * artwork, and would have been for a day. Reported as "the splash screen still
 * has the old logo", which was exactly right.
 *
 * These files cannot be bundled and hashed by Vite, because the splash paints
 * before any JavaScript has parsed. So the revision goes in the query, and this
 * checks that every generated reference carries it — the failure mode being a
 * rebrand that looks like it worked to whoever ran it, on a screen that had
 * never seen the old one.
 */

const REV = /^[0-9a-f]{10}$/;

test('the revision is a content hash of the artwork and the accent', () => {
  const cfg = loadBrand();
  const rev = brandRev(cfg);
  assert.match(rev, REV);
  /* Stable for the same inputs — a rebuild with no artwork change must not
     invalidate the caches of every device in the field. */
  assert.equal(brandRev(cfg), rev);
  /* And it moves when the accent does, because the mark is cropped from the
     logo and the backdrop is composed from the accent: both are downstream. */
  assert.notEqual(brandRev({ ...cfg, accent: '#123456' }), rev);
});

test('every generated brand URL carries the revision', () => {
  const rev = brandRev(loadBrand());
  const ts = readFileSync(join(ROOT, 'apps/web/src/brand.ts'), 'utf8');
  for (const name of ['brand-logo.png', 'brand-mark.png', 'backdrop.jpg']) {
    assert.ok(
      ts.includes(`${name}?v=${rev}`),
      `brand.ts names ${name} without the current revision — run \`pnpm brand\``,
    );
  }
  /*
   * The splash is the one that matters most and the one a component cannot fix:
   * it is markup in the document, painted before the bundle exists.
   */
  const html = readFileSync(join(ROOT, 'apps/web/index.html'), 'utf8');
  assert.ok(
    html.includes(`brand-logo.png?v=${rev}`),
    'the splash in index.html names the logo without the current revision — run `pnpm brand`',
  );
});

test('nothing references a brand image without a revision', () => {
  /*
   * A component that spells a filename out itself would reintroduce the bug in
   * one line and look completely reasonable in review. `brand.ts` is the only
   * place these names may appear.
   */
  const ts = readFileSync(join(ROOT, 'apps/web/src/brand.ts'), 'utf8');
  const html = readFileSync(join(ROOT, 'apps/web/index.html'), 'utf8');
  for (const src of [ts, html]) {
    for (const m of src.matchAll(/(brand-logo\.png|brand-mark\.png|backdrop\.jpg)(\?v=[0-9a-f]{10})?/g)) {
      assert.ok(m[2] !== undefined, `${m[1]} appears with no ?v= revision`);
    }
  }
});
