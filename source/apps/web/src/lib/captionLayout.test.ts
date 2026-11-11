import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captionBottomPct, captionBoxStyle, captionFontRem, captionLift, overlayCaptionRows,
  shouldCommitCaption,
} from './captionLayout.ts';

test('a comma-heavy sentence stays one caption until the period', () => {
  const s = 'Ask not what your country can do for you, ask what you can do for your country';
  assert.equal(shouldCommitCaption(s), false);
  assert.equal(shouldCommitCaption(s + '.'), true);
});

test('two sentences commit separately', () => {
  assert.equal(shouldCommitCaption('Hello there, how are you today?'), true);
  assert.equal(shouldCommitCaption('I am fine, thanks.'), true);
});

test('length alone never closes a caption', () => {
  const long = 'The quick brown fox jumps over the lazy dog near the river bank this morning while people keep talking';
  assert.ok(long.length > 70);
  assert.equal(shouldCommitCaption(long), false);
  assert.equal(shouldCommitCaption('x'.repeat(200)), false);
});

test('overlay keeps two finals when talk is fast and nothing is in flight', () => {
  const rows = overlayCaptionRows([
    { orig: 'One.', final: true },
    { orig: 'Two.', final: true },
    { orig: 'Three.', final: true },
    { orig: 'Four.', final: true },
  ]);
  assert.deepEqual(rows.map((r) => r.orig), ['Three.', 'Four.']);
});

test('overlay keeps one final beside the line still being spoken', () => {
  const rows = overlayCaptionRows([
    { orig: 'One.', final: true },
    { orig: 'Two.', final: true },
    { orig: 'Three.', final: true },
    { orig: 'and then they', final: false },
  ]);
  assert.deepEqual(rows.map((r) => r.orig), ['Three.', 'and then they']);
});

test('lines=1 with a live partial must not dump every final (slice(-0) trap)', () => {
  const rows = overlayCaptionRows([
    { orig: 'One.', final: true },
    { orig: 'Two.', final: true },
    { orig: 'Three.', final: true },
    { orig: 'and then they', final: false },
  ], 1);
  assert.deepEqual(rows.map((r) => r.orig), ['and then they']);
});

test('lines=1 with only finals keeps the newest', () => {
  const rows = overlayCaptionRows([
    { orig: 'One.', final: true },
    { orig: 'Two.', final: true },
    { orig: 'Three.', final: true },
  ], 1);
  assert.deepEqual(rows.map((r) => r.orig), ['Three.']);
});

test('a single line still shows when that is all there is', () => {
  assert.deepEqual(
    overlayCaptionRows([{ orig: 'Hello.', final: true }]).map((r) => r.orig),
    ['Hello.'],
  );
});

/**
 * The caption ladder, in pixels rather than in rem.
 *
 * A rem assertion proves nothing here: the bug being tested is that one rem
 * ladder meant two different physical sizes, because `data-density='tv'` makes
 * the root font size the whole scale and the set-top boxes clamp it to 13px
 * where a desk sits at 16. So these convert, at the two roots that actually
 * ship, and assert the SIZE — which is the thing that was reported.
 */
const px = (rem: string, root: number): number => Number(rem.replace('rem', '')) * root;
/** The root `html[data-density='tv']` clamps to on a 960x540 set-top box. */
const TV_ROOT = 13;
/** `html { font-size: 16px }` — a desk, and the TV floor on a set that reports 1280+. */
const DESK_ROOT = 16;

test('every television caption size clears the app\'s own smallest label', () => {
  /* `--t-2xs` is .75rem at TV density: 9.75px on the 960x540 box. A caption
     below the smallest label in the interface is the reported bug. */
  const floor = 0.75 * TV_ROOT;
  for (const size of ['sm', 'md', 'lg'] as const) {
    for (const newest of [true, false]) {
      const got = px(captionFontRem(size, newest, 'tv'), TV_ROOT);
      assert.ok(got > floor, `${size}/${newest ? 'newest' : 'older'} is ${got}px, under the ${floor}px label floor`);
    }
  }
});

test('the default caption size is readable from a sofa, which it was not', () => {
  /* `defaultCaptions()` ships `sm`. It used to be 0.8rem — 10.4px on the box
     that reports 960x540 — and the report was "by default its way too small
     for tvs". Google TV asks for 14sp body and 12sp captions; this is over
     both, and on the 1080p panel behind that report it is 39 device pixels. */
  assert.equal(px(captionFontRem('sm', true, 'tv'), TV_ROOT), 19.5);
  assert.ok(px(captionFontRem('sm', true, 'tv'), TV_ROOT) > 10.4 * 1.8);
});

test('the ladder climbs, and the older line is always quieter than the newest', () => {
  for (const ff of ['tv', 'desktop'] as const) {
    const newest = (['sm', 'md', 'lg'] as const).map((s) => px(captionFontRem(s, true, ff), TV_ROOT));
    assert.ok(newest[0]! < newest[1]! && newest[1]! < newest[2]!, `${ff}: sm/md/lg do not climb`);
    for (const s of ['sm', 'md', 'lg'] as const) {
      assert.ok(
        px(captionFontRem(s, false, ff), TV_ROOT) < px(captionFontRem(s, true, ff), TV_ROOT),
        `${ff}/${s}: the older line is not smaller than the newest`,
      );
    }
  }
});

test('a television caption is bigger than the same step on a desk, at the same root', () => {
  /* The whole point of two ladders. At one root the TV step must win; the real
     gap is wider still, because the TV root is the lower of the two. */
  for (const s of ['sm', 'md', 'lg'] as const) {
    assert.ok(
      px(captionFontRem(s, true, 'tv'), TV_ROOT) > px(captionFontRem(s, true, 'desktop'), DESK_ROOT),
      `${s}: the television caption is not bigger than the desk one`,
    );
  }
});

test('phone and tablet read the desk ladder, only tv moves — the `densityFor` rule', () => {
  for (const ff of ['phone', 'tablet', 'desktop'] as const) {
    assert.equal(captionFontRem('md', true, ff), captionFontRem('md', true, 'desktop'));
  }
  assert.notEqual(captionFontRem('md', true, 'tv'), captionFontRem('md', true, 'desktop'));
});

test('the low position stays inside a television title-safe margin', () => {
  /* 5% of the picture is exactly the title-safe band a set overscans into, and
     "really below area" was the ask. Anything under it is a caption a TV can
     eat. */
  assert.equal(captionBottomPct('low'), '5%');
  for (const p of ['low', 'mid', 'high'] as const) {
    assert.ok(Number(captionBottomPct(p).replace('%', '')) >= 5);
  }
});

/**
 * Only `low` ever reaches the control bar — see the measurement on
 * `captionLift`. 46px of overlap there at every size, because the box is
 * anchored by its BOTTOM edge; `mid` (56px clear) and `high` (132px clear)
 * never come close, so a caption in either is never lifted.
 */
test('low lifts clear of the bar while it is showing; mid and high never move', () => {
  assert.equal(captionLift('low', true), 'translateY(-4rem)');
  assert.equal(captionLift('mid', true), 'translateY(0)');
  assert.equal(captionLift('high', true), 'translateY(0)');
});

test('the lift is only for while the bar can actually reach the caption', () => {
  /* The bar hidden, or nothing playing: the low position sits exactly where
     `captionBottomPct` already puts it — no jump waiting to happen the moment
     the bar wakes up later. */
  assert.equal(captionLift('low', false), 'translateY(0)');
});

test('a subtitle with no plate is outlined on every side, not just underneath', () => {
  /*
   * White text over a white road sign, photographed: "add some shadow to the
   * subtitles so you can see it properly, otherwise it's flat". The old rule cast
   * one shadow DOWNWARDS, so the top and sides of every letter met the picture
   * with nothing between them.
   */
  const shadow = captionBoxStyle({ bg: false, bgOpacity: 60, bgColor: 'black' }).textShadow;
  for (const corner of ['1px 1px', '-1px -1px', '1px -1px', '-1px 1px']) {
    assert.ok(shadow.includes(corner), `no ink at ${corner}`);
  }
  assert.ok(shadow.includes('0 0 2px'), 'no halo to close the gaps between letters');
});

test('a white plate is ringed in white, so dark ink keeps its edge', () => {
  const shadow = captionBoxStyle({ bg: false, bgOpacity: 60, bgColor: 'white' }).textShadow;
  assert.ok(shadow.includes('255 255 255'), 'dark ink ringed in black would be invisible');
});

test('only a solid plate drops the outline', () => {
  assert.equal(captionBoxStyle({ bg: true, bgOpacity: 100, bgColor: 'black' }).textShadow, 'none');
  assert.notEqual(captionBoxStyle({ bg: true, bgOpacity: 40, bgColor: 'black' }).textShadow, 'none');
});
