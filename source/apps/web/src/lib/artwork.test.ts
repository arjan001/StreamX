import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artworkAt, rewriteArtwork, WIDTH_TIERS, tierWidth } from './artwork.ts';

test('rewrites a 26-character TMDB hash on the dead mirror', () => {
  assert.equal(
    rewriteArtwork('http://203.0.113.10/images/movies//4q2NNj4S5dG2RLF9CpXsej7yXl.jpg'),
    'https://image.tmdb.org/t/p/original/4q2NNj4S5dG2RLF9CpXsej7yXl.jpg',
  );
});

test('rewrites a 27-character TMDB hash', () => {
  assert.equal(
    rewriteArtwork('http://203.0.113.10/images/movies/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg'),
    'https://image.tmdb.org/t/p/original/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg',
  );
});

test('leaves YTS covers alone', () => {
  const yts = 'https://img.yts.mx/assets/images/movies/the_big_fat_quiz_of_the_year_2025/medium-cover.jpg';
  assert.equal(rewriteArtwork(yts), yts);
});

/* ── asking for the size that will be drawn ────────────────────────────────── */

test('a TMDB master is asked for at the tile size instead', () => {
  // The measured case: t/p/original is a 2000x3000, 1.3MB file, and the poster
  // tile on a 1080p box is 109 CSS px. At DPR 1 (this runner) that wants 109,
  // and the smallest published rendition that covers it is w154.
  const master = 'https://image.tmdb.org/t/p/original/waLbm384SQDwLTCn6ttPqQS5kfV.jpg';
  assert.equal(
    artworkAt(master, 109),
    'https://image.tmdb.org/t/p/w154/waLbm384SQDwLTCn6ttPqQS5kfV.jpg',
  );
});

test('and the oversized named rendition is brought down too', () => {
  // 38% of this catalogue points at w600_and_h900_bestv2 — 122KB for a tile that
  // needs 35KB. The rendition segment is replaced whatever it was called.
  const named = 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/abc.jpg';
  assert.equal(artworkAt(named, 200), 'https://image.tmdb.org/t/p/w342/abc.jpg');
});

test('a box bigger than every published rendition keeps the master', () => {
  const master = 'https://image.tmdb.org/t/p/original/abc.jpg';
  assert.equal(artworkAt(master, 1600), master);
});

test('a rendition that already fits is left exactly alone', () => {
  // Byte-identical, so it is the same entry in the service worker's cache.
  const fits = 'https://image.tmdb.org/t/p/w342/abc.jpg';
  assert.equal(artworkAt(fits, 342), fits);
});

test('the wsrv proxy is finally asked to resize, and never to enlarge', () => {
  // It has always been in the path for plaintext artwork as a mixed-content
  // shim; it resizes too, and was simply never asked. `we` is what stops a 60px
  // picon being blown up into a blur.
  //
  // The width is a LADDER step now, not the drawn number: a URL is the cache key
  // in the service worker, the browser and the WebView's own poster cache, so
  // asking for 180 where another area asks for 192 is two downloads of one
  // picture. See `tierWidth`.
  const proxied = 'https://wsrv.nl/?maxage=1y&url=example.com%2Flogo.png';
  assert.equal(artworkAt(proxied, 180), `${proxied}&w=192&we`);
});

test('the encoded url is never round-tripped through URLSearchParams', () => {
  // Re-encoding turns one picture into two cache entries. The original string
  // has to survive the rewrite character for character.
  const proxied = 'https://wsrv.nl/?maxage=1y&url=a.example%2Fp%2Fx%20y.jpg';
  assert.ok(artworkAt(proxied, 180).startsWith(proxied));
});

test('a width already asked for is not asked for twice', () => {
  const once = 'https://wsrv.nl/?maxage=1y&url=x&w=180&we';
  assert.equal(artworkAt(once, 342), once);
});

test('anything else is returned untouched', () => {
  // Deliberate: wrapping every origin in wsrv would make a third party
  // load-bearing for all artwork rather than some.
  const other = 'https://cdn.example.com/poster.jpg';
  assert.equal(artworkAt(other, 180), other);
  assert.equal(artworkAt('/local/logo.png', 180), '/local/logo.png');
  assert.equal(artworkAt('', 180), '');
});

test('a relative path is left alone', () => {
  assert.equal(artworkAt('/icons/apple-touch-icon.png', 180), '/icons/apple-touch-icon.png');
});

/* ── the website is not the CDN, and it cost more than a redirect ──────────── */

test('a TMDB website url becomes a CDN url', () => {
  // What the panel writes for most series covers on this line. It is a 301, so
  // it worked — and being a different host, it went past the rendition swap.
  assert.equal(
    rewriteArtwork('https://www.themoviedb.org/t/p/original/bDg16Hhq2zAEjYWUsfCcdw2pcoY.jpg'),
    'https://image.tmdb.org/t/p/original/bDg16Hhq2zAEjYWUsfCcdw2pcoY.jpg',
  );
  // The rendition, whatever it is called, is the caller's business and is kept.
  assert.equal(
    rewriteArtwork('https://themoviedb.org/t/p/w600_and_h900_bestv2/abc.jpg'),
    'https://image.tmdb.org/t/p/w600_and_h900_bestv2/abc.jpg',
  );
  // Only the rendition path space: the website is also a website.
  const page = 'https://www.themoviedb.org/tv/1396-breaking-bad';
  assert.equal(rewriteArtwork(page), page);
});

test('and it is resized even when it arrives unrewritten', () => {
  /* A detail response's `cover` comes from the panel, not from the catalogue, so
     it never passes through `safeImage`. Measured: 1,159,971 bytes as written,
     6,342 as w92 — for a rail thumbnail drawn 28 CSS pixels wide. */
  assert.equal(
    artworkAt('https://www.themoviedb.org/t/p/original/bDg16Hhq2zAEjYWUsfCcdw2pcoY.jpg', 28),
    'https://image.tmdb.org/t/p/w92/bDg16Hhq2zAEjYWUsfCcdw2pcoY.jpg',
  );
});

test('a drawn width is rounded UP to its tier, never down', () => {
  assert.deepEqual([...WIDTH_TIERS], [64, 96, 128, 192, 256, 384, 512, 768]);
  assert.equal(tierWidth(1), 64);
  assert.equal(tierWidth(64), 64);
  assert.equal(tierWidth(65), 96);
  assert.equal(tierWidth(109), 128);
  assert.equal(tierWidth(163), 192);
  /* Past the last tier the last tier is what is asked for. */
  assert.equal(tierWidth(2000), 768);
});

test('three areas asking for one picon produce ONE url', () => {
  /* The measurement behind the change: a 39px guide logo, a 48px channel row
     and a 68px rail tile are the same file, and they were three cache entries
     and three downloads. */
  const u = `https://wsrv.nl/?url=${encodeURIComponent('http://host/picon.png')}`;
  const at = (css: number) => artworkAt(u, css);
  assert.equal(at(39), at(48));
  assert.equal(at(48), at(64));
  /* And a genuinely bigger box still gets a bigger picture. */
  assert.notEqual(at(48), at(300));
});
