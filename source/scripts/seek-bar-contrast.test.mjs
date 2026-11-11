/**
 * The downloaded band on the seek bar, against the track it sits on.
 *
 *     als i cannt see last prgress areas
 *
 * They could not. The band was `bg-ink-3/50`, and measured against the track
 * across every palette it came to 1.6:1 to 1.8:1 — on a band four pixels tall,
 * watched from a sofa. Three to one is the floor for a part of an interface
 * that carries meaning rather than decoration (WCAG 1.4.11), and this one
 * carries the only answer to "can I jump there without waiting". `ink-2/85`
 * measures 3.69:1 at its worst across all twenty-one.
 *
 * ── what this gate reads ──
 *
 * The CLASS out of the component and the COLOURS out of the stylesheet, so it
 * fails on a change to either: a tone edited back down, or a new palette whose
 * rule and ink-2 sit too close together. Both modes of every theme, because a
 * palette nobody here uses is still somebody's television.
 *
 * Tokens are not all hex — several themes give `--color-rule` as
 * `rgb(9 30 56 / .16)`, translucent over the ground. A first version of this
 * matched only `#rrggbb`, silently fell back to the default dark rule for
 * those, and reported a light theme as having a black track. It composites
 * now, which is what a browser does.
 *
 * ── what it deliberately does not assert ──
 *
 * That the downloaded band and the played fill are distinguishable FROM EACH
 * OTHER **by colour**. They are not, everywhere: in `carbon light` they
 * measure 1.03:1 — a dark grey band and a dark teal fill at the same
 * luminance — and no tuning of one token fixes that without changing palettes.
 *
 * So the component does not ask colour to do it. The watched fill is drawn a
 * pixel proud of the track at top and bottom, which puts a STEP in the bar
 * where it ends, and a step needs no palette to cooperate. Both that and the
 * handle are pinned below, because between them they are the whole of how the
 * boundary is read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../apps/web/src/index.css', import.meta.url), 'utf8');
const player = readFileSync(new URL('../apps/web/src/components/VideoPlayer.tsx', import.meta.url), 'utf8');

/** Lowest ratio a meaningful part of an interface may have against its ground. */
const FLOOR = 3;

const srgb = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) =>
  0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** A token as [r, g, b, a] — `#rrggbb` or `rgb(r g b / a)`, or null. */
function parse(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return [...[0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), 1];
  const fn = /^rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)$/i.exec(value.trim());
  if (fn) return [+fn[1], +fn[2], +fn[3], fn[4] === undefined ? 1 : +fn[4]];
  return null;
}
/** A colour laid on an opaque background, at an extra utility alpha. */
const onto = (c, bg, a = 1) =>
  c[3] * a >= 1 ? c.slice(0, 3) : c.slice(0, 3).map((x, i) => x * (c[3] * a) + bg[i] * (1 - c[3] * a));

const VALUE = /--color-([a-z0-9-]+):\s*(#[0-9a-f]{6}|rgb\([^)]*\))/gi;

/** One palette per theme and mode, cascaded the way a browser cascades them. */
function palettes() {
  const base = {};
  const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(theme, 'no @theme block in index.css');
  for (const m of theme[1].matchAll(VALUE)) base[m[1]] = m[2];

  const blocks = [...css.matchAll(
    /html\[data-theme=('[^']+'|"[^"]+")\]((?:\[data-mode='[a-z]+'\])?)\s*\{([\s\S]*?)\n\}/g,
  )].map((m) => ({
    theme: m[1].slice(1, -1),
    mode: /'([a-z]+)'/.exec(m[2])?.[1] ?? null,
    body: m[3],
  }));

  const out = [{ name: 'default dark', colors: base }];
  for (const name of [...new Set(blocks.map((b) => b.theme))]) {
    for (const mode of ['dark', 'light']) {
      const colors = { ...base };
      for (const b of blocks) {
        if (b.theme !== name) continue;
        if (b.mode !== null && b.mode !== mode) continue;
        for (const v of b.body.matchAll(VALUE)) colors[v[1]] = v[2];
      }
      out.push({ name: `${name} ${mode}`, colors });
    }
  }
  return out;
}

/** The tone the component actually paints the downloaded stretches in. */
function band() {
  const m = /absolute inset-y-0 bg-([a-z0-9-]+)(?:\/(\d+))?"/.exec(player);
  assert.ok(m, 'the downloaded band on the seek bar no longer matches — check SeekBar');
  return { token: m[1], alpha: m[2] === undefined ? 1 : Number(m[2]) / 100 };
}

test('every palette resolves a ground, a rule and the band’s own token', () => {
  const { token } = band();
  const all = palettes();
  assert.ok(all.length >= 20, `only ${all.length} palette(s) found — the parser has drifted`);
  for (const p of all) {
    for (const k of ['ground', 'rule', token, 'tally']) {
      assert.ok(parse(p.colors[k] ?? ''), `${p.name}: --color-${k} is ${p.colors[k]}`);
    }
  }
});

test('what is downloaded is visible against the bar, in every palette', () => {
  const { token, alpha } = band();
  const thin = [];
  for (const p of palettes()) {
    const ground = onto(parse(p.colors.ground), [0, 0, 0]);
    const rule = onto(parse(p.colors.rule), ground);
    const r = ratio(onto(parse(p.colors[token]), rule, alpha), rule);
    if (r < FLOOR) thin.push(`${p.name} ${r.toFixed(2)}:1`);
  }
  assert.deepEqual(thin, [], `below ${FLOOR}:1 against the track: ${thin.join(', ')}`);
});

test('the handle marks where the played fill ends', () => {
  /* The two fills can share a luminance — 1.03:1 in carbon light — so the
     handle is what tells a viewer which part has been watched. Both must be
     placed from the same number or the mark drifts off the boundary. */
  const fill = /className="absolute inset-y-0 left-0 bg-tally" style=\{\{ width: `\$\{pct\}%` \}\}/.test(player);
  const handle = /-translate-x-1\/2 -translate-y-1\/2 bg-tally"\s*\n\s*style=\{\{ left: `\$\{pct\}%` \}\}/.test(player);
  assert.ok(fill, 'the played fill is no longer drawn from `pct`');
  assert.ok(handle, 'the handle is no longer placed at `pct`');
});

/**
 * The step that makes the boundary readable where colour cannot.
 *
 * `-inset-y-px` against the band's `inset-y-0`: the watched fill overhangs the
 * track by a pixel at top and bottom, so it is six pixels against the band's
 * four. Asserted on the class rather than a rendering, for the same reason the
 * rest of this file is: it is the thing a future edit would quietly drop.
 */
test('the watched fill stands proud of the band beside it', () => {
  const fill = /className="absolute (-inset-y-px) left-0 [^"]*bg-tally"/.exec(player);
  assert.ok(fill !== null, 'the watched fill is no longer drawn a pixel proud of the track');
  const band = /className="absolute (inset-y-0) bg-ink-2\/85"/.exec(player);
  assert.ok(band !== null, 'the downloaded band no longer fills the track exactly');
  assert.notEqual(fill[1], band[1], 'both are the same height again — the step is gone');
});
