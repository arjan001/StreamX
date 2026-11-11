/**
 * One brand definition, read by everything that draws it.
 *
 * The ask was "make it white-label so we can rebrand it any time", and the state
 * before this was the opposite: the name was typed into eight files and the mark
 * was DRAWN — a rounded amber tile with a letter L, as code, in two scripts that
 * each plotted it their own way. Changing the logo meant editing two drawing
 * routines; changing the name meant a grep.
 *
 * So: `brand.config.json` is the source of truth, the artwork is a file, and this
 * module is what turns them into pixels. Rebranding is one JSON edit, one image,
 * and `pnpm brand`.
 *
 * The PNG decoder is here because this box has no image toolchain — no
 * ImageMagick, no sharp, no canvas — and a logo has to be cropped and measured
 * before it can be used. Node ships zlib, which is the only hard part of reading
 * a PNG.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadBrand() {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'brand.config.json'), 'utf8'));
  for (const key of ['name', 'wordmark', 'logo', 'accent', 'ground']) {
    if (typeof cfg[key] !== 'string' || cfg[key] === '') {
      throw new Error(`brand.config.json: "${key}" is required`);
    }
  }
  return cfg;
}

/** A PNG, as { width, height, rgba } — 4 bytes per pixel, top-left first. */
/**
 * A short revision that changes when the ARTWORK does, and never otherwise.
 *
 * ── the bug this exists to close ──
 *
 * The brand images are served from stable names — `brand-logo.png`,
 * `brand-mark.png`, `backdrop.jpg` — and `staticCacheControl` gives anything
 * unhashed `public, max-age=86400`. The document is `no-cache`, so a new
 * `index.html` arrives immediately; the logo it names does not, because the URL
 * did not change. Measured after swapping the logo: the server was serving the
 * new 90,815 bytes and the splash was still the old picture, for a day.
 *
 * That is the exact reasoning already written above the `/assets/` rule — the
 * hash makes the URL the version — applied to the assets that had been left out
 * of it. They cannot be bundled and hashed by Vite, because the splash has to
 * paint before any JavaScript has parsed.
 *
 * Content, not a counter: it moves when the picture moves, so a rebuild with no
 * artwork change does not invalidate anything, and a changed accent does — the
 * mark is cropped from the logo and the backdrop is composed from the accent, so
 * both are downstream of these two inputs.
 */
export function brandRev(cfg) {
  const bytes = readFileSync(join(ROOT, cfg.logo));
  return createHash('sha256')
    .update(bytes)
    .update(String(cfg.accent ?? ''))
    .digest('hex')
    .slice(0, 10);
}

export function decodePng(file) {
  const buf = readFileSync(file);
  let p = 8;
  let w = 0; let h = 0; let ctype = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9];
      if (data[8] !== 8) throw new Error(`${file}: only 8-bit PNGs are supported`);
    }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (ctype !== 6 && ctype !== 2) throw new Error(`${file}: needs RGB or RGBA (colour type ${ctype})`);
  const bpp = ctype === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  // Un-filter, which is the whole of PNG decoding once zlib has run.
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c); const pb = Math.abs(a - c); const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    rgba[j] = px[i * bpp];
    rgba[j + 1] = px[i * bpp + 1];
    rgba[j + 2] = px[i * bpp + 2];
    rgba[j + 3] = bpp === 4 ? px[i * bpp + 3] : 255;
  }
  return { width: w, height: h, rgba };
}

/**
 * Where the mark stops and the wordmark starts.
 *
 * Supplied artwork pairs a symbol with the name, and an app icon must be the
 * symbol alone — the name is illegible at 48px and the launcher writes it
 * underneath anyway. Rather than asking someone to type pixel rows into the
 * config, the split is found: the widest band of fully transparent lines between
 * the two is the gutter, and everything on the symbol's side of it is the mark.
 *
 * ── both lockups, because artwork arrives in both ──
 *
 * The first version of this only looked at ROWS, because the logo it was written
 * against stacked the symbol above the name (rows 234-261 empty). The next logo
 * supplied was a horizontal lockup — symbol at the left, "Streamix" beside it,
 * 863x289 — and a row scan finds no gutter in it at all, so it fell through to
 * "the whole image" and every icon in the product came out as the entire lockup
 * squeezed into a square. Measured on that file: columns 187-202 are empty, the
 * symbol is 50-186 and the name 203-828.
 *
 * So the orientation is decided from the aspect ratio and the same scan runs
 * along the other axis. `markBox` in the config overrides the whole rectangle,
 * and `markRows` still overrides the vertical pair, for artwork with no gutter.
 */

/** The widest fully transparent band strictly inside `[0, n)`, or null. */
function gutter(ink, n, from, to) {
  const bands = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (ink[i] === 0) run++;
    else { if (run >= 4) bands.push([i - run, i - 1]); run = 0; }
  }
  return bands
    /* A band at either end is margin, not a gutter. */
    .filter(([a, z]) => a > from && z < to)
    .sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0] ?? null;
}

/** How many pixels in each row, and in each column, are not transparent. */
function inkProfile(img) {
  const { width: w, height: h, rgba } = img;
  const rows = new Array(h).fill(0);
  const cols = new Array(w).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 24) { rows[y] += 1; cols[x] += 1; }
    }
  }
  return { rows, cols };
}

/**
 * The symbol's own rectangle in source pixels.
 *
 * Returns `{ top, bottom, left, right }` — inclusive, and already tight to the
 * ink, so a caller needs no second pass to avoid cropping margin into an icon.
 */
export function markRect(img, cfg = {}) {
  const { width: w, height: h } = img;
  if (Array.isArray(cfg.markBox) && cfg.markBox.length === 4) {
    const [left, top, right, bottom] = cfg.markBox;
    return { top, bottom, left, right };
  }
  const { rows, cols } = inkProfile(img);
  const tight = (ink, n) => {
    let a = ink.findIndex((v) => v > 0);
    let z = n - 1;
    while (z > 0 && ink[z] === 0) z -= 1;
    return [a === -1 ? 0 : a, z];
  };
  const [inkTop, inkBottom] = tight(rows, h);
  const [inkLeft, inkRight] = tight(cols, w);

  /* A vertical pair given by hand still wins, and still means a stacked lockup. */
  if (Array.isArray(cfg.markRows) && cfg.markRows.length === 2) {
    return { top: cfg.markRows[0], bottom: cfg.markRows[1], left: inkLeft, right: inkRight };
  }

  /*
   * Wider than about 3:2 and the name is beside the symbol, not under it.
   * The threshold is loose on purpose: a stacked lockup is nearly square or
   * taller, and a horizontal one is 2:1 or wider. Nothing lands between.
   */
  const horizontal = (inkRight - inkLeft) / Math.max(1, inkBottom - inkTop) > 1.6;
  if (horizontal) {
    const g = gutter(cols, w, inkLeft, inkRight);
    const right = g === null ? inkRight : g[0] - 1;
    /* Re-tighten the rows to the symbol's own columns: the name is usually
       shorter than the symbol is tall, and its rows would pad the crop. */
    const { rgba } = img;
    let top = h; let bottom = 0;
    for (let y = 0; y < h; y++) {
      for (let x = inkLeft; x <= right; x++) {
        if (rgba[(y * w + x) * 4 + 3] > 24) { if (y < top) top = y; if (y > bottom) bottom = y; }
      }
    }
    return top > bottom
      ? { top: inkTop, bottom: inkBottom, left: inkLeft, right }
      : { top, bottom, left: inkLeft, right };
  }

  const g = gutter(rows, h, h * 0.45, h - 2);
  const bottom = g === null ? inkBottom : g[0] - 1;
  const { rgba } = img;
  let left = w; let right = 0;
  for (let y = inkTop; y <= bottom; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 24) { if (x < left) left = x; if (x > right) right = x; }
    }
  }
  return left > right
    ? { top: inkTop, bottom, left: inkLeft, right: inkRight }
    : { top: inkTop, bottom, left, right };
}

/** The logo as a data URI, for embedding in SVG and HTML that Chromium renders. */
export function logoDataUri(file) {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

/**
 * The mark alone, as an SVG that crops the source with a viewBox.
 *
 * A viewBox crop rather than a re-encoded bitmap: the renderer scales the
 * original pixels once, at the final size, instead of twice.
 */
export function markSvg(cfg, img, { size = 512, inset = 0.06, ground = null } = {}) {
  const { top, bottom, left, right } = markRect(img, cfg);
  const boxW = right - left + 1;
  const boxH = bottom - top + 1;
  const side = Math.max(boxW, boxH);
  // Centre the mark's ink in a square of source pixels…
  const ox = left - (side - boxW) / 2;
  const oy = top - (side - boxH) / 2;
  /*
    …then crop with the OUTER viewBox, not an inner one.
    `viewBox` is not an attribute of `<image>` — the first version of this put it
    there, which SVG ignores, so every icon came out as the whole logo including
    the wordmark. The crop belongs to the surface; the image is placed at its
    natural size inside it, and the padding is the viewBox growing outward.
  */
  const pad = inset >= 0.5 ? 0 : (side * inset) / (1 - 2 * inset);
  const vb = [ox - pad, oy - pad, side + pad * 2, side + pad * 2];
  /*
    Clipped to the mark's own rows as well as cropped.

    A maskable icon insets the artwork by a fifth, and growing the viewBox to make
    that room pulled the wordmark back into frame — a ghost of "Streamix" along the
    bottom edge of every launcher icon. The crop decides what is centred; the clip
    decides what exists.
  */
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`
    + ` viewBox="${vb.map((n) => Math.round(n * 100) / 100).join(' ')}">`
    /* Clipped on BOTH axes. It used to clip rows only, which is all a stacked
       lockup needs; on a horizontal one the name sits at the same rows as the
       symbol, so a maskable icon's outward padding pulled "Streamix" back into
       frame from the side instead of from below. */
    + `<defs><clipPath id="mark"><rect x="${left}" y="${top}" width="${right - left + 1}" height="${bottom - top + 1}"/></clipPath></defs>`
    + (ground === null ? '' : `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="${ground}"/>`)
    + `<g clip-path="url(#mark)"><image x="0" y="0" width="${img.width}" height="${img.height}"`
    + ` href="${logoDataUri(join(ROOT, cfg.logo))}"/></g>`
    + '</svg>';
}

/** The full logo, mark and wordmark together, for a splash or a social card. */
export function logoSvg(cfg, img, { width = 512 } = {}) {
  const ratio = img.height / img.width;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(width * ratio)}"`
    + ` viewBox="0 0 ${img.width} ${img.height}">`
    + `<image x="0" y="0" width="${img.width}" height="${img.height}" href="${logoDataUri(join(ROOT, cfg.logo))}"/>`
    + '</svg>';
}
