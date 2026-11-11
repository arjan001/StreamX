/**
 * When a live caption card may close.
 *
 * Words are shown as they arrive on the current card. A new card starts only at
 * sentence-final punctuation (or a speaker change, handled at ingest). Width
 * wrapping, breaths, and `<end>` must not cut the line — that drops the start of
 * the thought from the overlay while someone is still talking.
 */

import type { FormFactor } from './formFactor.ts';
import type { CaptionPrefs } from './prefs.ts';

export const SENT_END = /[.!?…؟。！？։۔।]["»”'’]?\s*$/;

/** Default how many caption rows the video overlay keeps visible. */
export const OVERLAY_CAPTION_LINES = 2;

export function shouldCommitCaption(text: string): boolean {
  return text.trim().length >= 12 && SENT_END.test(text);
}

/**
 * The rows drawn over the picture: up to `max` recent lines.
 *
 * Fast talk used to leave one row because the overlay only painted "last final
 * + current partial", and between sentences there is no partial — so a burst of
 * short lines collapsed to a single final. Take the newest finals to fill the
 * remaining slots beside any in-progress line.
 */
export function overlayCaptionRows<T extends { orig: string; final: boolean }>(
  lines: readonly T[],
  max = OVERLAY_CAPTION_LINES,
): T[] {
  const clean = lines.filter((l) => l.orig.trim() !== '');
  if (clean.length === 0 || max <= 0) return [];
  const partial = clean.filter((l) => !l.final);
  const finals = clean.filter((l) => l.final);
  const live = partial.length === 0 ? [] : [partial[partial.length - 1]!];
  const need = Math.max(0, max - live.length);
  /* `slice(-0)` is `slice(0)` in JS — the whole array — so lines=1 with a
     live partial used to dump every final caption onto the picture. */
  const older = need === 0 ? [] : finals.slice(-need);
  return [...older, ...live];
}

const BG_RGB: Record<CaptionPrefs['bgColor'], string> = {
  black: '0 0 0',
  navy: '8 18 40',
  green: '6 40 18',
  white: '240 240 240',
};

/** Bottom inset of the caption stack over the picture. */
export function captionBottomPct(position: CaptionPrefs['position']): string {
  if (position === 'high') return '38%';
  if (position === 'mid') return '24%';
  return '5%';
}

/**
 * How big a caption line is — per size step, and per KIND of screen.
 *
 * Reported from the sofa as "by default its way too small for tvs", and the
 * numbers say the same thing. One rem ladder served both a desk and a
 * television, and on the television it was the wrong ladder twice over:
 *
 *   1. `sm` — the default — was 0.8rem, which is a caption two steps BELOW the
 *      app's own smallest label. Nothing else in this app is set below
 *      `--t-2xs`; the one piece of text that has to be read across a room was.
 *   2. A rem is not a fixed size here. `data-density='tv'` makes the root font
 *      the whole scale, and the set-top boxes this is built for report 960x540
 *      CSS pixels at ratio 2 — so the root clamps to its 13px floor (see the
 *      `max-width: 1100px` clause in index.css). 0.8rem THERE is 10.4px. The
 *      figure the ladder was tuned against, 0.8rem of a 16px desk root, is
 *      12.8px, and the two were never the same number.
 *
 * So there are two ladders, chosen by the same question the rest of the type
 * scale is chosen by: `densityFor()` in formFactor.ts sets `data-density='tv'`
 * exactly when the form factor is `tv`, and `captionFontRem` branches on that
 * same form factor. One switch, so captions cannot disagree with the interface
 * around them.
 *
 * The television steps, measured at the 13px root the 960x540 box produces:
 *
 *          newest      older      (and at a 16px root, e.g. a 1280 CSS-px set)
 *   sm     19.5px      16.25px     24px / 20px
 *   md     24.7px      20.15px     30.4px / 24.8px
 *   lg     31.2px      26px        38.4px / 32px
 *
 * On the 1080p panel behind that 960x540 report every one of those doubles in
 * device pixels: `sm` lands at 39, `lg` at 62 — 3.6% and 5.8% of picture
 * height, which is the band broadcast captions have always lived in. `sm` is
 * deliberately still the DEFAULT: the owner asked for small captions with no
 * plate low on the picture and liked the result. Small now means small for a
 * television rather than small for a monitor.
 *
 * Desk keeps the ladder it had before it was quietened — 0.95/1.2/1.45 — which
 * is what those steps were tuned against and what a phone held at arm's length
 * still wants. `classify()` pins every screen to `tv` today, so that branch is
 * the one that reopens with the others rather than one anybody is reading now.
 */
const CAPTION_REM: Record<'tv' | 'desk', Record<CaptionPrefs['size'], readonly [number, number]>> = {
  tv: { sm: [1.5, 1.25], md: [1.9, 1.55], lg: [2.4, 2] },
  desk: { sm: [0.95, 0.8], md: [1.2, 1], lg: [1.45, 1.15] },
};

/**
 * `ff` is required, not defaulted, on purpose: a caller that forgets it is a
 * caller painting desk-sized captions onto a television, and that is exactly
 * the bug this function was changed to end. The compiler asks instead.
 */
export function captionFontRem(
  size: CaptionPrefs['size'], newest: boolean, ff: FormFactor,
): string {
  const step = CAPTION_REM[ff === 'tv' ? 'tv' : 'desk'][size];
  return `${newest ? step[0] : step[1]}rem`;
}

/* ── clear of the control bar, only where it actually reaches ────────────── */

/**
 * How far the `low` position has to rise to clear the control bar, while the
 * bar is showing.
 *
 * Measured at the TV geometry this app targets — 960x540, `data-density='tv'`
 * (13px root), the low position's own default — with the caption stack's real
 * classes from `CaptionOverlay.tsx` and the control bar's real ones from
 * `VideoPlayer.tsx`, populated with the full live-channel button row (LIVE
 * pill, restart, ±10s, prev/next, subs, captions, guide, settings, theatre,
 * pip, fullscreen — the tallest the bar gets; the comment on that row in
 * `VideoPlayer.tsx` confirms it never wraps at this width, so this is the real
 * height, not a cherry-picked one):
 *
 *   the bar        73px tall, top edge 467px down a 540px stage
 *   `low`'s box    bottom edge fixed at 513px, EVERY size — `sm` through `lg`
 *
 * `low` overlaps the bar by 46px, and that number does not move with size: a
 * caption box positioned by `bottom: captionBottomPct(...)` is anchored at its
 * BOTTOM edge, so a bigger caption grows upward — the edge nearest the bar
 * never does. `mid` (56px clear) and `high` (132px clear) never come close at
 * any size, so they are left alone; lifting a caption that already clears the
 * bar would be a jump with nothing to fix.
 *
 * 4rem clears the measured 46px with a little to spare (6px, at this box's own
 * 13px root floor), and is itself in rem for the reason `captionFontRem` is:
 * the bar's own height is built from rem paddings and rem icons, so a rem lift
 * stays proportioned to it as the root moves: `html[data-density='tv'] .ctl`
 * alone is a third again the size of its own desk figure. A flat px number
 * would only ever be right at the one root it was measured against.
 */
const CAPTION_BAR_CLEAR_REM = 4;

/**
 * The caption stack's own transform: lifted clear of the bar only where it can
 * reach — `low`, and only while the bar is actually showing. `mid` and `high`
 * are always `translateY(0)`, at every size, because they never overlap it.
 *
 * A transform rather than a taller `captionBottomPct`, so the move is a
 * repaint, not a layout — `CaptionOverlay.tsx` pairs this with a CSS
 * transition for "smooth, no jump", and the return to `translateY(0)` the
 * instant `barShowing` goes false is what puts the caption back exactly where
 * `captionBottomPct` already says it belongs, the same instant the bar itself
 * starts hiding.
 */
export function captionLift(position: CaptionPrefs['position'], barShowing: boolean): string {
  return barShowing && position === 'low' ? `translateY(-${CAPTION_BAR_CLEAR_REM}rem)` : 'translateY(0)';
}

/**
 * An OUTLINE, not a drop shadow.
 *
 * With the plate turned off — which is how most people watch, because a black bar
 * across the picture is worse than the problem it solves — the only thing between
 * white text and a white background is this. It used to be
 * `0 2px 6px rgb(0 0 0 / .95)`: one soft shadow, cast DOWNWARDS. Below each
 * letter there is something dark; above it, to its left and to its right there is
 * nothing at all, so a subtitle over a bright sky, snow, or a white road sign
 * dissolves into it.
 *
 * Photographed over a blue-and-white sign, with the note "add some shadow to the
 * subtitles so you can see it properly, otherwise it's flat".
 *
 * So: a tight ring in all four diagonals to draw the edge of every letter, a
 * 2px halo to close the gaps between them, and the soft drop kept underneath for
 * depth. This is the same recipe `video::cue` in `index.css` already uses for
 * subtitle files — the two renderers should not disagree about legibility.
 */
const RING = (rgb: string): string => [
  `0 0 2px rgb(${rgb} / .95)`,
  `0 1px 3px rgb(${rgb} / .9)`,
  `0 2px 6px rgb(${rgb} / .75)`,
  `1px 1px 1px rgb(${rgb} / .85)`,
  `-1px -1px 1px rgb(${rgb} / .85)`,
  `1px -1px 1px rgb(${rgb} / .85)`,
  `-1px 1px 1px rgb(${rgb} / .85)`,
].join(', ');

/** Black behind light text; white behind dark text, which is the white plate. */
const DARK_RING = RING('0 0 0');
const LIGHT_RING = RING('255 255 255');

/** Plate + ink for the caption box from prefs. */
export function captionBoxStyle(p: Pick<CaptionPrefs, 'bg' | 'bgOpacity' | 'bgColor'>): {
  background: string;
  color: string;
  textShadow: string;
} {
  const dark = p.bgColor === 'white';
  const ink = dark ? 'rgb(11 16 19)' : 'rgb(231 237 239)';
  if (!p.bg) {
    /* No plate: the ring IS the legibility, so it is drawn in the opposite of
       the ink rather than always in black. */
    return {
      background: 'transparent',
      color: ink,
      textShadow: dark ? LIGHT_RING : DARK_RING,
    };
  }
  const a = Math.min(1, Math.max(0.1, p.bgOpacity / 100));
  /*
   * With a plate, the ring still earns its place: a plate at 30% opacity is a
   * suggestion, not a background, and the text in front of it meets whatever the
   * picture is doing. Only a FULLY opaque plate makes it pointless.
   */
  return {
    background: `rgb(${BG_RGB[p.bgColor]} / ${a})`,
    color: ink,
    textShadow: a >= 0.98 ? 'none' : (dark ? LIGHT_RING : DARK_RING),
  };
}
