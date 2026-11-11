import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blend, cssOf, edgeShade, keepAsking, startNativeAmbient, temper,
} from './ambient.ts';

/**
 * The colour beside the picture.
 *
 * The canvas half of this cannot be tested without a browser, so what is tested
 * is the part that decides what the light looks like: which pixels are read, how
 * fast it moves, and the three limits that keep a glow from being worse than no
 * glow. Those are the parts with opinions in them.
 */

/** An RGBA buffer with a solid left half and a solid right half. */
function twoTone(w: number, h: number, left: number[], right: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = x < w / 2 ? left : right;
      const i = (y * w + x) * 4;
      out[i] = c[0]!;
      out[i + 1] = c[1]!;
      out[i + 2] = c[2]!;
      out[i + 3] = 255;
    }
  }
  return out;
}

test('a solid frame samples as itself', () => {
  const px = twoTone(32, 18, [40, 80, 120], [40, 80, 120]);
  assert.deepEqual(edgeShade(px, 32, 18), { r: 40, g: 80, b: 120 });
});

test('the EDGES are what is read, not the middle', () => {
  /*
   * The glow sits around the picture, so a bright centre must not tint it. This
   * frame is black at both edges and pure white across the middle: an average of
   * the whole frame would come back grey, and an average of the edges is black.
   */
  const w = 32;
  const h = 18;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const middle = x > w / 4 && x < (w * 3) / 4;
      const v = middle ? 255 : 0;
      const i = (y * w + x) * 4;
      px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = 255;
    }
  }
  assert.deepEqual(edgeShade(px, w, h), { r: 0, g: 0, b: 0 });
});

test('both sides count, so a one-sided shot does not swing the whole glow', () => {
  const px = twoTone(32, 18, [200, 0, 0], [0, 0, 200]);
  const got = edgeShade(px, 32, 18);
  assert.deepEqual(got, { r: 100, g: 0, b: 100 });
});

test('a buffer that does not match its dimensions is refused, not read past', () => {
  assert.equal(edgeShade(new Uint8ClampedArray(8), 32, 18), null);
  assert.equal(edgeShade(twoTone(4, 4, [1, 1, 1], [1, 1, 1]), 1, 4), null);
});

test('blending moves part of the way and never past', () => {
  const from = { r: 0, g: 0, b: 0 };
  const to = { r: 100, g: 200, b: 50 };
  assert.deepEqual(blend(from, to, 0), from);
  assert.deepEqual(blend(from, to, 1), to);
  assert.deepEqual(blend(from, to, 0.5), { r: 50, g: 100, b: 25 });
  /* A factor out of range is clamped rather than allowed to overshoot — an
     overshoot here is a colour brighter than any frame in the film. */
  assert.deepEqual(blend(from, to, 4), to);
  assert.deepEqual(blend(from, to, -2), from);
});

test('a cut cannot be reached in one sample', () => {
  /* The whole reason blending exists: a step change in the source must arrive as
     a ramp, or the room flickers on every edit. */
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  const after = blend(black, white, 0.34);
  assert.ok(after.r > 0 && after.r < 255, `${after.r}`);
});

test('a black frame still gives light, and a white one does not flood the room', () => {
  const dark = temper({ r: 0, g: 0, b: 0 });
  assert.ok(dark.r >= 18 && dark.g >= 18 && dark.b >= 18, JSON.stringify(dark));
  const bright = temper({ r: 255, g: 255, b: 255 });
  assert.ok(bright.r <= 190 && bright.g <= 190 && bright.b <= 190, JSON.stringify(bright));
});

test('a garish frame is pulled back but keeps its hue', () => {
  /*
   * Saturated colour bands on a TV panel and oversaturated reds read as harsh at
   * three metres — both are in the platform's own design guidance. So a pure red
   * frame must still look red and must not ring the picture in neon.
   */
  const red = temper({ r: 255, g: 0, b: 0 });
  assert.ok(red.r > red.g && red.r > red.b, JSON.stringify(red));
  assert.ok(red.r < 255, JSON.stringify(red));
  assert.ok(red.g > 0, JSON.stringify(red));
});

test('tempering is stable — a tempered shade does not keep drifting', () => {
  /* It runs on its own output every sample, so a function that moved a settled
     colour would walk the glow to grey over a long film. */
  const once = temper({ r: 90, g: 40, b: 120 });
  const twice = temper(once);
  for (const k of ['r', 'g', 'b'] as const) {
    assert.ok(Math.abs(once[k] - twice[k]) <= 12, `${k}: ${once[k]} → ${twice[k]}`);
  }
});

test('a shade becomes a colour a stylesheet accepts', () => {
  assert.equal(cssOf({ r: 1, g: 22, b: 255 }), 'rgb(1 22 255)');
});

/* ── the native source ─────────────────────────────────────────────────────── */

test('a refusal that can change is retried, and one that cannot is not', () => {
  /*
   * This distinction is the whole of whether the native glow works. The first
   * sample almost always lands before libVLC has decoded a frame, so a sampler
   * that gave up on any `lit: false` would never start; and a stream on a
   * protected buffer answers "no" for its whole length, so one that never gave
   * up would poll it 6,000 times over a film.
   */
  for (const why of ['idle', 'hidden', 'nosurface', undefined, 'something-new']) {
    assert.equal(keepAsking(why), true, String(why));
  }
  for (const why of ['api', 'refused', 'read', 'empty', 'copy1', 'copy3']) {
    assert.equal(keepAsking(why), false, why);
  }
});

test('the native sampler stops for good on a permanent refusal', async () => {
  let asked = 0;
  const stop = startNativeAmbient(async () => {
    asked += 1;
    return { lit: false, why: 'refused' };
  }, () => { throw new Error('should not have reported a shade'); });
  await new Promise((r) => setTimeout(r, 40));
  const afterFirst = asked;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(asked, afterFirst, `kept asking: ${asked}`);
  assert.ok(asked >= 1, 'never asked at all');
  stop();
});

test('the native sampler tempers what the plugin hands it', async () => {
  /* A pure black frame off the surface must still give light, exactly as it does
     down the canvas path — the floor lives in `temper` and both callers use it. */
  const seen = [];
  const stop = startNativeAmbient(
    async () => ({ lit: true, r: 0, g: 0, b: 0 }),
    (s) => seen.push(s),
  );
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.ok(seen.length >= 1, 'reported nothing');
  assert.ok(seen[0].r >= 18 && seen[0].g >= 18 && seen[0].b >= 18, JSON.stringify(seen[0]));
});

test('a channel out of range from the bridge cannot escape 0-255', async () => {
  /* The plugin computes these, but they arrive over a bridge as plain JSON, and
     a colour above 255 would render as an invalid `rgb()` and paint nothing. */
  const seen = [];
  const stop = startNativeAmbient(
    async () => ({ lit: true, r: 900, g: -40, b: 12 }),
    (s) => seen.push(s),
  );
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.ok(seen.length >= 1, 'reported nothing');
  for (const k of ['r', 'g', 'b']) {
    assert.ok(seen[0][k] >= 0 && seen[0][k] <= 255, `${k}=${seen[0][k]}`);
  }
});

test('a bridge that throws does not switch the glow off', async () => {
  /* A call can be lost while the activity is being recreated. That is not a
     reason to stop for the rest of the film. */
  let asked = 0;
  const stop = startNativeAmbient(async () => {
    asked += 1;
    throw new Error('bridge gone');
  }, () => {});
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.ok(asked >= 1, 'never asked');
});
