/**
 * Generate the launcher icons and the splash from the brand, in one place.
 *
 * Why generated rather than committed art: the app shipped with Capacitor's
 * default icon — a generic blue mark — which is the single loudest signal that a
 * build is somebody's test rather than an app. There is no image toolchain on this
 * box and no design source file, so the mark is drawn from its definition: the
 * amber wordmark tile with a dark L, which is what the web header already shows.
 *
 * Two forms are needed and they are not interchangeable:
 *   * ADAPTIVE (API 26+): a background layer and a foreground layer, each 108dp
 *     with only the middle 66dp guaranteed visible — the launcher masks the rest
 *     to whatever shape the device uses. Written as XML, so it is sharp at any
 *     density.
 *   * LEGACY (API 23-25): one flat raster per density, because `minSdkVersion` is
 *     23 and an adaptive icon is simply ignored there.
 *
 * The PNG encoder is here because Node has zlib and nothing else is installed.
 * It writes 8-bit RGBA, one filter-0 scanline per row — the simplest thing that
 * every decoder reads.
 *
 * Usage: node apps/mobile/scripts/brand-assets.mjs
 */
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { ROOT, decodePng, loadBrand, logoSvg, markRect, markSvg } from '../../../scripts/brand-kit.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'android', 'app', 'src', 'main', 'res');

/* The brand, as numbers. Amber is the accent from the Midnight palette; the
   ground is that palette's page colour, so the splash matches the first paint of
   the app rather than flashing a different dark. */
const AMBER = [232, 163, 74, 255];
const GROUND = [11, 16, 19, 255];
const INK = [11, 16, 19, 255];

function png({ width, height, paint }) {
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = paint(x, y);
      const i = (y * width + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
    }
  }
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let TABLE = null;
function crc32(buf) {
  if (TABLE === null) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/* ── the mark ──────────────────────────────────────────────────────────────
   An amber rounded square with a dark L, anti-aliased by supersampling: the
   alternative at 48px is a staircase on every curve, which is exactly what makes
   a generated icon look generated. */
const SS = 4;

function inRoundRect(x, y, l, t, w, h, r) {
  if (x < l || y < t || x > l + w || y > t + h) return false;
  const cx = Math.min(Math.max(x, l + r), l + w - r);
  const cy = Math.min(Math.max(y, t + r), t + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** The L, as two bars, in a 0..1 box. Proportions match the web wordmark. */
function inL(u, v) {
  const stem = u >= 0.30 && u <= 0.46 && v >= 0.20 && v <= 0.80;
  const foot = u >= 0.30 && u <= 0.70 && v >= 0.64 && v <= 0.80;
  return stem || foot;
}

function markPixel(x, y, size, { tile }) {
  let hits = 0, inkHits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS;
      const py = y + (sy + 0.5) / SS;
      const inTile = tile
        ? inRoundRect(px, py, size * 0.14, size * 0.14, size * 0.72, size * 0.72, size * 0.16)
        : true;
      if (!inTile) continue;
      hits++;
      const u = (px - size * 0.14) / (size * 0.72);
      const v = (py - size * 0.14) / (size * 0.72);
      if (inL(u, v)) inkHits++;
    }
  }
  const total = SS * SS;
  if (hits === 0) return [0, 0, 0, 0];
  const tileA = hits / total;
  const inkA = inkHits / total;
  // Ink over amber over transparent, composited by coverage.
  const base = AMBER;
  const out = [0, 1, 2].map((i) => Math.round((base[i] * (tileA - inkA) + INK[i] * inkA) / tileA));
  return [...out, Math.round(255 * tileA)];
}

const write = (path, buf) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
};

/* ── legacy launcher icons (API 23-25) ─────────────────────────────────── */
const BRAND = loadBrand();
const LOGO = decodePng(join(ROOT, BRAND.logo));

/**
 * Render an SVG to a PNG through headless Chromium.
 *
 * The hand-rolled encoder above stays for the silhouette, where the input is an
 * alpha channel and the output is two colours. Everything else is now real
 * artwork — a logo with gradients and a glow — and drawing that by plotting
 * pixels in JavaScript is not a thing to attempt. Chromium is already a
 * devDependency here because the web brand script needs it.
 */
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function shot(svg, width, height = width) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.waitForTimeout(90);
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return buf;
}

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, size] of Object.entries(DENSITIES)) {
  /* Square and round are the same file: the mark has its own silhouette, so a
     launcher that masks it to a circle crops transparency, not artwork. */
  const legacy = await shot(markSvg(BRAND, LOGO, { size, inset: 0.04 }), size);
  write(join(RES, `mipmap-${d}`, 'ic_launcher.png'), legacy);
  write(join(RES, `mipmap-${d}`, 'ic_launcher_round.png'), legacy);
  /* The adaptive FOREGROUND, inset to the 66-of-108dp safe zone — 22% a side — or
     a round launcher takes a bite out of the mark. */
  write(join(RES, `mipmap-${d}`, 'ic_launcher_foreground.png'),
    await shot(markSvg(BRAND, LOGO, { size, inset: 0.22 }), size));
}

/* ── the themed (monochrome) layer ─────────────────────────────────────────
   Android 13 tints a single-colour version of the icon to the system palette, so
   it has to be a silhouette — the one thing the artwork cannot supply and the one
   thing the little encoder above is good at: alpha in, one colour out. */
{
  /* The symbol's own rectangle, not its rows and the whole image width — see
     `markRect`. On a horizontal lockup the second of those is the entire logo,
     and this layer is a silhouette, so it came out as the word "Streamix" in
     the system's tint colour. */
  const { top, bottom, left, right } = markRect(LOGO, BRAND);
  const mw = LOGO.width;
  const size = 192;
  const bandW = right - left + 1;
  const bandH = bottom - top + 1;
  const side = Math.max(bandW, bandH);
  const inset = 0.22;
  write(join(RES, 'mipmap-anydpi-v26', 'ic_launcher_mono.png'), png({
    width: size, height: size, paint: (x, y) => {
      const u = (x / size - inset) / (1 - inset * 2);
      const v = (y / size - inset) / (1 - inset * 2);
      if (u < 0 || u > 1 || v < 0 || v > 1) return [0, 0, 0, 0];
      const sx = Math.round(left - (side - bandW) / 2 + u * side);
      const sy = Math.round(top - (side - bandH) / 2 + v * side);
      if (sx < left || sx > right || sy < top || sy > bottom) return [0, 0, 0, 0];
      return LOGO.rgba[(sy * mw + sx) * 4 + 3] > 96 ? [...INK, 255] : [0, 0, 0, 0];
    },
  }));
}

/* ── the TV banner ─────────────────────────────────────────────────────────
   Android TV shows a 320x180 banner in the launcher row, not an icon, and without
   one the app is a grey rectangle with its label typed over it. This is the one
   launcher surface with room for a NAME, and the artwork already carries one.

   ── the geometry, because it was wrong and it looked like a stale icon ──

   This drew the logo at a hand-written `x=110 y=14 width=100`. Measured against
   the frame that is 31% of the width and 18% of the height, with the wordmark's
   centre 60px ABOVE the banner's own centre — a small stamp near the top of an
   otherwise empty rectangle. Beside Play Store and Play Games in the same row,
   whose artwork fills its banner, the app reads as unfinished, which is how it
   was reported: "the app icon I still see the old one". The mark was never old;
   there was just so little of it, so far off centre, that it did not register as
   the new one.

   So the placement is computed rather than typed: fit the logo inside the frame
   less a margin, preserving its aspect ratio, and centre it on both axes. It is
   written to bind on whichever edge runs out first, so a future logo that is tall
   rather than wide lands correctly instead of overflowing — the failure this
   replaces was precisely a constant that stopped being true of the artwork. */
const BANNER = { w: 320, h: 180, padX: 32, padY: 26 };
{
  const boxW = BANNER.w - BANNER.padX * 2;
  const boxH = BANNER.h - BANNER.padY * 2;
  /* The smaller scale is the one that fits: a wide wordmark is limited by the
     width, a squarer mark by the height, and taking the minimum means neither
     is ever cropped or stretched. */
  const scale = Math.min(boxW / LOGO.width, boxH / LOGO.height);
  const w = Math.round(LOGO.width * scale);
  const h = Math.round(LOGO.height * scale);
  write(join(RES, 'drawable-xhdpi', 'tv_banner.png'), await shot(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BANNER.w}" height="${BANNER.h}"`
    + ` viewBox="0 0 ${BANNER.w} ${BANNER.h}">`
    + `<rect width="${BANNER.w}" height="${BANNER.h}" fill="${BRAND.ground}"/>`
    + `<image x="${Math.round((BANNER.w - w) / 2)}" y="${Math.round((BANNER.h - h) / 2)}"`
    + ` width="${w}" height="${h}"`
    + ` href="data:image/png;base64,${readFileSync(join(ROOT, BRAND.logo)).toString('base64')}"/>`
    + '</svg>', BANNER.w, BANNER.h));
  console.log(`  tv banner        logo ${w}x${h} in ${BANNER.w}x${BANNER.h}`
    + ` (${Math.round((100 * w) / BANNER.w)}% wide), centred`);
}

/*
 * And the template art Capacitor scaffolds, which is still here.
 *
 * `drawable-v24/ic_launcher_foreground.xml` is Android Studio's clipart robot and
 * `drawable/ic_launcher_background.xml` is its teal #26A69A grid. Nothing points
 * at either — both adaptive icons name `@mipmap/ic_launcher_foreground` and
 * `@color/ic_launcher_background` — so they are dead weight AND a loaded gun:
 * `@drawable/ic_launcher_background` resolves, silently, to stock teal. Removed
 * here rather than by hand so a Capacitor re-scaffold cannot quietly restore them.
 */
for (const stale of [
  join(RES, 'drawable-v24', 'ic_launcher_foreground.xml'),
  join(RES, 'drawable', 'ic_launcher_background.xml'),
]) {
  if (existsSync(stale)) { rmSync(stale); console.log(`  removed stale     ${stale.slice(RES.length + 1)}`); }
}

/* ── the splash ────────────────────────────────────────────────────────────
   One vector, replacing eleven raster files. Capacitor ships a splash.png per
   orientation and density; a layer-list with a centred vector is sharp on all of
   them, weighs nothing, and cannot be the wrong size on a device nobody tested. */
for (const dir of [
  'drawable', 'drawable-port-mdpi', 'drawable-port-hdpi', 'drawable-port-xhdpi',
  'drawable-port-xxhdpi', 'drawable-port-xxxhdpi', 'drawable-land-mdpi',
  'drawable-land-hdpi', 'drawable-land-xhdpi', 'drawable-land-xxhdpi', 'drawable-land-xxxhdpi',
]) {
  const p = join(RES, dir, 'splash.png');
  if (existsSync(p)) rmSync(p);
}

/* The splash artwork: the full logo at a size that is sharp on a 4K television and
   still decodes instantly. `drawable-nodpi`, so Android never rescales it. */
write(join(RES, 'drawable-nodpi', 'splash_mark.png'),
  await shot(logoSvg(BRAND, LOGO, { width: 720 }), 720, Math.round(720 * LOGO.height / LOGO.width)));

const hex = (c) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;

write(join(RES, 'values', 'brand.xml'), Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/mobile/scripts/brand-assets.mjs. Do not hand-edit. -->
<resources>
    <color name="brand_ground">${BRAND.ground}</color>
    <color name="brand_accent">${BRAND.accent}</color>
    <!-- The adaptive background sits behind a mark that has its own colour. -->
    <color name="ic_launcher_background">${BRAND.ground}</color>
</resources>
`));

write(join(RES, 'drawable', 'splash.xml'), Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/mobile/scripts/brand-assets.mjs. Do not hand-edit. -->
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/brand_ground" />
    <item android:gravity="center">
        <bitmap android:gravity="center" android:src="@drawable/splash_mark" />
    </item>
</layer-list>
`));

/* ── the adaptive icon ─────────────────────────────────────────────────── */
for (const name of ['ic_launcher', 'ic_launcher_round']) {
  write(join(RES, 'mipmap-anydpi-v26', `${name}.xml`), Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/mobile/scripts/brand-assets.mjs. Do not hand-edit. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_mono" />
</adaptive-icon>
`));
}

await browser.close();

console.log(`brand assets written from ${BRAND.logo} (${BRAND.name}):`);
console.log(`  legacy icons     ${Object.keys(DENSITIES).length} densities x 3 files`);
console.log('  adaptive icon    mipmap-anydpi-v26/{ic_launcher,ic_launcher_round}.xml');
console.log('  splash           drawable/splash.xml + drawable-nodpi/splash_mark.png');
console.log('  colours          values/brand.xml');
