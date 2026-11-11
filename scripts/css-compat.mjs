/**
 * Flatten cascade layers out of the built CSS, so an older television gets styled.
 *
 * ── the failure ──
 *
 * "in some televisions there is no styling at all all the buttons and everything
 * are scrammed." Not a layout bug and not a theme bug: on those boxes the
 * stylesheet is being thrown away almost in its entirety, and the reason is one
 * at-rule.
 *
 * Tailwind v4 emits everything inside cascade layers:
 *
 *   @layer properties{ @supports(...){ *{--tw-…:…} } }
 *   @layer theme{ :root{ --color-ground:…; --color-ink:…; … } }
 *   @layer base{ …the reset… }
 *   @layer components;
 *   @layer utilities{ …every utility class in the app… }
 *
 * `@layer` is Chrome/WebView 99, March 2022. Below that it is an UNKNOWN
 * at-rule — and the CSS parser does not skip just the line, it consumes the
 * at-rule together with its whole `{…}` block and discards the lot (CSS Syntax
 * 3, "consume an at-rule"). So on an older WebView the browser drops:
 *
 *   every design token          --color-ground, --color-ink, --color-tally, …
 *   the entire reset            margins, box-sizing, button appearance
 *   every utility class         flex, grid, px-4, text-ink, bg-panel — all of it
 *
 * What is left is unstyled HTML: buttons at their platform default, stacked down
 * the page, no colour, no layout. Which is exactly the report. Android TV boxes
 * routinely ship WebView 8x–9x and never update it, so this is not an edge case
 * on the one device class this app exists for.
 *
 * Tailwind v4 does not support those browsers and is not going to; its stated
 * floor is Chrome 111. So the fix belongs here, after the build.
 *
 * ── why flattening is safe rather than merely convenient ──
 *
 * Layers exist to make ORDER not matter. Removing them makes order matter again,
 * so flattening is only correct if the file's order already matches the intended
 * precedence. It does, on both counts:
 *
 *   - Tailwind emits the layers in precedence order — properties, theme, base,
 *     components, utilities — so a flattened file has utilities last among them,
 *     which is where they need to be.
 *   - This app's own rules in `index.css` are UNLAYERED, and unlayered styles
 *     beat layered ones whatever the order. Measured in the built file before
 *     changing anything: `@layer utilities{` opens at byte 7525 and `.stage`,
 *     `.skeleton` and `--lift` sit at 90505, 93015 and 95528 — after it. So they
 *     won by layer before and they win by order now, and nothing changes.
 *
 * That second point is the one to re-check if this ever starts behaving oddly:
 * if custom CSS is ever emitted BEFORE the utilities layer, flattening would
 * silently hand precedence to Tailwind. The check at the end of this file
 * asserts the ordering rather than trusting it.
 *
 * `color-mix()` is deliberately left alone. It is Chrome 111 too, and Tailwind
 * already guards every use behind `@supports (color:color-mix(in lab,red,red))`
 * with a plain-colour fallback outside it — measured, 107 guards over 206 uses.
 * That one it gets right.
 *
 * Usage: node scripts/css-compat.mjs [dist-dir ...]     (default apps/web/dist)
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Replace every `@layer name { … }` with its contents, and drop the bare
 * `@layer a, b, c;` ordering statement.
 *
 * Written as a scanner rather than a regex because the blocks contain nested
 * braces (`@supports`, `@media`, `:where()` selectors with commas) and a regex
 * cannot find the matching close. Strings and comments are tracked for the same
 * reason — a `}` inside `content:"}"` is not a close brace.
 */
export function flattenLayers(css) {
  let out = '';
  let i = 0;
  let removed = 0;
  let dropped = 0;
  /* Depth of the layer blocks we are currently inside, so their closing braces
     can be swallowed rather than emitted. */
  const layerCloses = [];
  let depth = 0;

  while (i < css.length) {
    const c = css[i];

    /* Comments and strings pass through untouched. */
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      out += css.slice(i, Math.min(j + 1, css.length));
      i = j + 1;
      continue;
    }

    if (c === '@' && css.startsWith('@layer', i)) {
      /* Find where the prelude ends: `{` for a block, `;` for a statement. */
      let j = i + 6;
      while (j < css.length && css[j] !== '{' && css[j] !== ';') j++;
      if (css[j] === ';') {
        /* `@layer components;` — an ordering declaration with nothing in it. */
        dropped += 1;
        i = j + 1;
        continue;
      }
      if (css[j] === '{') {
        /* Emit nothing for the prelude or the brace; remember to eat the close. */
        removed += 1;
        depth += 1;
        layerCloses.push(depth);
        i = j + 1;
        continue;
      }
      /* Ran off the end — leave it alone rather than corrupt the file. */
      out += css.slice(i);
      break;
    }

    if (c === '{') { depth += 1; out += c; i += 1; continue; }
    if (c === '}') {
      if (layerCloses.length > 0 && layerCloses[layerCloses.length - 1] === depth) {
        layerCloses.pop();
        depth -= 1;
        i += 1;
        continue;
      }
      depth -= 1;
      out += c;
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }

  return { css: out, removed, dropped };
}

/**
 * Split a shorthand value on TOP-LEVEL whitespace.
 *
 * `gap` is `<row> <column>`, and the values here are Tailwind's
 * `calc(var(--spacing) * 3)` — which contains two spaces that are not
 * separators. Anything inside brackets is one token.
 */
function parts(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of value) {
    if (c === '(' || c === '[') depth += 1;
    if (c === ')' || c === ']') depth -= 1;
    if (depth === 0 && /\s/.test(c)) {
      if (cur !== '') { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** `a:b;c:d` → { a: 'b', c: 'd' }, last one wins, as the cascade says. */
function declarations(body) {
  const out = {};
  let depth = 0;
  let cur = '';
  const push = (d) => {
    const k = d.indexOf(':');
    if (k === -1) return;
    out[d.slice(0, k).trim()] = d.slice(k + 1).trim();
  };
  for (const c of body) {
    if (c === '(' || c === '[') depth += 1;
    if (c === ')' || c === ']') depth -= 1;
    if (c === ';' && depth === 0) { push(cur); cur = ''; continue; }
    cur += c;
  }
  push(cur);
  return out;
}

/**
 * Flexbox `gap` is Chrome/WebView 84, and below it every space in the app is zero.
 *
 * ── the failure ──
 *
 * Reproduced on a Google TV AVD at 1920x1080 running WebView 83: the app boots,
 * downloads all 11,048 channels and reaches "You're set" — and every place two
 * things should have air between them, they touch. The header reads
 * `HomeMoviesSeriesLive TVCatch-up` with each icon welded to its label; the
 * ready badge reads `✓11,048 CHANNELS READY`; the two cards share an edge. That
 * is "all the buttons and everything are scrammed", and it is one property.
 *
 * `gap` on a GRID is Chrome 66 and fine. Only flex is late, and there is no
 * polyfill for it — the spacing has to come from margins on the children.
 *
 * ── how the direction is decided, since CSS cannot see the element ──
 *
 * A margin needs an axis and `gap` does not have one: it means column-gap in a
 * row and row-gap in a column. Three sources, in order of confidence:
 *
 *   the rule says so      `flex-direction: column` in its own body — the app's
 *                         hand-written rules usually do
 *   the class says so     Tailwind's `.flex-col` is on the same element as
 *                         `.gap-4`, so `SEL.flex-col` and `SEL:not(.flex-col)`
 *                         split the two cases with no guessing
 *   it is a grid          skipped entirely: grid gap works, and adding margins
 *                         on top of a gap that already applies would double it
 *
 * ── and why the whole thing hides behind an attribute ──
 *
 * `html[data-nogap]` is set by a five-line measurement in `index.html` — two
 * 10px children in a 10px-gap flex box, which is 30px wide where gap works and
 * 20px where it does not. A browser that supports gap never sees any of this, so
 * the fallback cannot regress a modern television.
 *
 * The known cost, stated rather than discovered: these rules are more specific
 * than a `mt-*` utility on a child, so on a box that takes this path an explicit
 * margin on a flex child loses to the fallback. That is the right trade — the
 * alternative on those boxes is no spacing anywhere at all — but it is why this
 * is gated rather than unconditional.
 */
export function gapFallbacks(css) {
  let added = 0;
  /* Idempotent by REGENERATING, not by detecting: anything this pass emitted
     before is removed first, so running it twice on the same file produces the
     same file rather than two copies of every fallback. Caught by its own test,
     which is the only reason it is not still a latent duplicate. */
  const fresh = css.replace(/\[data-nogap\][^{}]*\{[^{}]*\}/g, '');
  const out = fresh.replace(/([^{}]+)\{([^{}]*)\}/g, (whole, rawSel, body) => {
    const sel = rawSel.trim();
    if (sel === '' || sel.startsWith('@')) return whole;
    /* Idempotent: a second pass over an already-processed file adds nothing. */
    if (sel.includes('[data-nogap]')) return whole;
    if (!/(^|[;{\s])(gap|column-gap|row-gap)\s*:/.test(`;${body}`)) return whole;

    const d = declarations(body);
    if (/grid/.test(d.display ?? '')) return whole;

    const shorthand = d.gap === undefined ? null : parts(d.gap);
    const rowGap = d['row-gap'] ?? (shorthand ? shorthand[0] : undefined);
    const colGap = d['column-gap'] ?? (shorthand ? (shorthand[1] ?? shorthand[0]) : undefined);
    if (rowGap === undefined && colGap === undefined) return whole;

    /* Every selector in the list gets the same treatment. */
    const each = (suffix, prop, value) => sel
      .split(',')
      .map((one) => `[data-nogap] ${one.trim()}${suffix}>*+*{${prop}:${value}}`)
      .join('');

    const dir = d['flex-direction'] ?? '';
    let rules = '';
    if (/column/.test(dir)) {
      if (rowGap !== undefined) rules += each('', 'margin-top', rowGap);
    } else if (/row/.test(dir)) {
      if (colGap !== undefined) rules += each('', 'margin-left', colGap);
    } else {
      if (rowGap !== undefined) rules += each('.flex-col', 'margin-top', rowGap);
      if (colGap !== undefined) rules += each(':not(.grid):not(.flex-col)', 'margin-left', colGap);
    }
    if (rules === '') return whole;
    added += 1;
    /* Emitted immediately after the rule it mirrors, so it inherits its media
       query and its place in the cascade without this pass having to model
       either. */
    return `${whole}${rules}`;
  });
  return { css: out, added };
}

/**
 * The logical box properties are Chrome/WebView 87, and Tailwind writes ALL of
 * them.
 *
 * `px-2` is not `padding-left`/`padding-right` in Tailwind v4, it is
 * `padding-inline`. So is `py-*` (`padding-block`), `mx-*`, `my-*`, and the
 * `inset-x`/`inset-y` pair. The shorthands landed in Chrome 87 — the long forms
 * (`padding-inline-start`) are Chrome 69 and fine, it is only the two-sided
 * shorthand that is late.
 *
 * Measured in the built stylesheet: 23 `padding-inline`, 38 `padding-block`, 5
 * `margin-inline`, 21 `margin-block`, 4 `inset-*`. On a box below 87 every one
 * is dropped, which is most of the padding in the app. Seen on a Google TV AVD
 * running WebView 83 as `☆Favourites` with the star touching the word — the
 * label's `px-2` simply was not there.
 *
 * ── the physical fallback goes BEFORE the logical one, and that is the trick ──
 *
 * Same declaration block, same specificity, so the later one wins wherever it is
 * understood. A modern browser therefore keeps the logical property with its
 * writing-mode awareness intact; an old one ignores the line it cannot parse and
 * is left holding the physical pair. Nothing is overridden and nothing is lost —
 * the fallback is invisible to anything that does not need it, which is why this
 * needs no feature query and no runtime flag.
 *
 * The physical mapping assumes left-to-right. That is safe precisely because it
 * only ever applies where the logical property was thrown away, and a browser
 * old enough to throw it away is being asked to render an English television UI.
 */
const LOGICAL = {
  'padding-inline': ['padding-left', 'padding-right'],
  'padding-block': ['padding-top', 'padding-bottom'],
  'margin-inline': ['margin-left', 'margin-right'],
  'margin-block': ['margin-top', 'margin-bottom'],
  'inset-inline': ['left', 'right'],
  'inset-block': ['top', 'bottom'],
};

export function physicalFallbacks(css) {
  let added = 0;
  const out = css.replace(/([^{}]+)\{([^{}]*)\}/g, (whole, sel, body) => {
    if (sel.trim().startsWith('@')) return whole;
    const names = Object.keys(LOGICAL).filter((n) => new RegExp(`(^|[;\\s])${n}\\s*:`).test(`;${body}`));
    if (names.length === 0) return whole;

    /* Rebuilt declaration by declaration rather than by regex replacement: the
       values contain `calc(var(--spacing) * 2)`, so a naive split on `;` or on
       whitespace would cut them in half. */
    const decls = [];
    let depth = 0;
    let cur = '';
    for (const c of body) {
      if (c === '(' || c === '[') depth += 1;
      if (c === ')' || c === ']') depth -= 1;
      if (c === ';' && depth === 0) { decls.push(cur); cur = ''; continue; }
      cur += c;
    }
    decls.push(cur);

    /* What this pass would emit for this block — computed first, so a pair left
       behind by an earlier run can be dropped instead of duplicated. Same
       reasoning as `gapFallbacks`: regenerate, never append. */
    const emitted = new Set();
    for (const d of decls) {
      const k = d.indexOf(':');
      const pair = k === -1 ? undefined : LOGICAL[d.slice(0, k).trim()];
      if (pair === undefined) continue;
      const sides = parts(d.slice(k + 1).trim());
      const a = sides[0] ?? '';
      emitted.add(`${pair[0]}:${a}`);
      emitted.add(`${pair[1]}:${sides[1] ?? a}`);
    }

    const rebuilt = [];
    for (const d of decls) {
      const k = d.indexOf(':');
      const name = k === -1 ? '' : d.slice(0, k).trim();
      const pair = LOGICAL[name];
      if (pair === undefined) {
        if (!emitted.has(d.trim())) rebuilt.push(d);
        continue;
      }
      const value = d.slice(k + 1).trim();
      const sides = parts(value);
      /* One value covers both sides; two are start-then-end, which left-to-right
         means first-then-second. */
      const a = sides[0] ?? value;
      const b = sides[1] ?? a;
      rebuilt.push(`${pair[0]}:${a}`);
      rebuilt.push(`${pair[1]}:${b}`);
      /* And the logical one after it, still winning where it is understood. */
      rebuilt.push(d);
      added += 1;
    }
    return `${sel}{${rebuilt.filter((d) => d.trim() !== '').join(';')}}`;
  });
  return { css: out, added };
}

/**
 * `:focus-visible` is Chromium 86, and it is the one that actually matters —
 * see `index.html`'s probe for why. Measured in the built stylesheet: 60
 * selectors carry it, including the bare `:focus-visible{outline:2px solid
 * var(--color-focus);outline-offset:1px}` that draws the ring for anything not
 * covered by a more specific rule. Below Chromium 86 the whole rule containing
 * an unrecognised pseudo-class is invalid and dropped — not just the fragment
 * that names it, the ENTIRE comma-separated selector list, because a style
 * rule's prelude is a non-forgiving selector list (the same grammar rule
 * `unwrapWhere`'s header describes for `:where()`, working in the opposite
 * direction here since nothing recovers it). So every one of those 60 rules
 * disappears on a Samsung before Tizen 7.0 or an LG of comparable age, and a
 * D-pad interface with literally no focus indicator anywhere is not merely
 * plain — there is no way to tell which tile the remote is about to activate,
 * which is the whole interface.
 *
 * ── verifying the probe before trusting it ──
 *
 * `CSS.supports('selector(:focus-visible)')` looks like the obvious test, but
 * `selector()` as a feature-query function is ITSELF Chromium 88 — two
 * versions after `:focus-visible` shipped in 86 — so it cannot tell 86/87
 * apart from older, and reports "unsupported" on exactly the versions where
 * the real answer is yes. What `index.html` uses instead is
 * `document.querySelector(':focus-visible')` in a try/catch. This is not a
 * guess: `querySelector` parses its argument as a selector list using the
 * Selectors API's NON-forgiving grammar — the same grammar that voids a whole
 * stylesheet rule over one bad fragment — and an engine with no production for
 * an unrecognised pseudo-class fails that parse and throws `SyntaxError`. So
 * the probe throws in precisely the cases where the stylesheet rule above
 * would have been dropped, and succeeds in precisely the cases where it would
 * not: the same failure, read from the other side. This is the standard
 * feature-detection idiom for a Selectors-Level-4 pseudo-class — it is how
 * :focus-visible polyfills themselves have always detected native support —
 * and it is confirmed here rather than assumed, because a probe that always
 * answers "supported" would be worse than no probe at all.
 *
 * ── why the fallback is `:focus`, and the cost that comes with it ──
 *
 * `:focus-visible` exists specifically to show the ring for keyboard/remote
 * focus and suppress it for a mouse click; `:focus` cannot make that
 * distinction, because making it is the entire reason the newer pseudo-class
 * exists. So on a pre-2023 Samsung the ring will also flash on a pointer
 * click, on the rare set that has a pointer at all. That is accepted rather
 * than overlooked: the alternative on hardware whose only input is a D-pad is
 * no ring ever, and a ring that is occasionally too eager on a device that
 * mostly has no pointer is a rounding error next to that.
 *
 * ── rewriting a selector list ──
 *
 * Each comma-separated fragment gets both edits independently: every
 * `:focus-visible` in it — there can be more than one, since Tailwind's
 * `group-focus-visible` variant nests one inside `:is(:where(.group) *)` —
 * becomes `:focus`, and the fragment is scoped to the probe. Most of this
 * app's own TV rules already lead with `html[data-ff=tv] …` /
 * `html[data-shell=modern] …`; for those the attribute is folded into that
 * SAME compound (`html[data-nofocusvisible][data-ff=tv] …`) rather than
 * prepended as a second `html`, which would require `<html>` to be its own
 * descendant and match nothing. Anything else — a bare `:focus-visible` or a
 * Tailwind utility compound — is prefixed with `html[data-nofocusvisible] `,
 * the same way `gapFallbacks` scopes its output.
 *
 * The WHOLE fragment list is reproduced, not just the fragments that mention
 * `:focus-visible` — because the whole original rule was dropped, a fragment
 * that only said `:hover` lost its styling too, and the duplicate has to
 * restore it rather than add the one piece that was technically invalid.
 *
 * One combination this cannot reach: `group-focus-visible`'s `:is()`/
 * `:where()` wrapper is ALSO Chromium 88 — the same generation as
 * `:focus-visible`, not an older one. Swapping the pseudo-class still leaves a
 * selector function these engines do not have, so that rule's duplicate is
 * emitted like any other but stays dark on every engine this file targets.
 * It is one cosmetic hover-group colour change, not the focus ring, and is
 * left as a known gap rather than special-cased.
 */
export function focusVisibleFallbacks(css) {
  const ATTR = '[data-nofocusvisible]';
  /* Regenerate, not append — same reasoning as `gapFallbacks`. */
  const fresh = css.replace(/html\[data-nofocusvisible\][^{}]*\{[^{}]*\}/g, '');
  let added = 0;
  const out = fresh.replace(/([^{}]+)\{([^{}]*)\}/g, (whole, rawSel, body) => {
    const sel = rawSel.trim();
    if (sel === '' || sel.startsWith('@')) return whole;
    if (sel.includes(ATTR)) return whole;
    if (!sel.includes(':focus-visible')) return whole;

    const newSel = sel.split(',').map((rawFragment) => {
      const fragment = rawFragment.trim().replace(/:focus-visible/g, ':focus');
      return /^html\b/.test(fragment)
        ? fragment.replace(/^html/, `html${ATTR}`)
        : `html${ATTR} ${fragment}`;
    }).join(',');

    added += 1;
    return `${whole}${newSel}{${body}}`;
  });
  return { css: out, added };
}

/**
 * `aspect-ratio` is Chromium 88, and a box that depends on it for its height
 * has none below that. The classic fallback — a `::before` sized by
 * `padding-top` as a percentage of width, with real content pinned
 * `position:absolute` over it — restores the box, but only where nothing else
 * in it needs to be a normal flow child, and that is not true everywhere this
 * property is used.
 *
 * ── one of the five was already fixed, by hand, before this file existed ──
 *
 * `.stage` — the video player's own frame — is wrapped in `index.css` as
 * `@supports not (aspect-ratio:16 / 9){.stage{height:0;padding-bottom:
 * 56.25%}}`. That is a native feature query rather than a probed attribute,
 * and it needs nothing further here: `@supports` itself is Chromium 28, so it
 * has always correctly reported "not supported" for a property these engines
 * have never heard of. Left alone, and NOT duplicated by this pass — `.stage`
 * also sets `overflow:hidden`, and layering a second, redundant `::before` box
 * inside an already-correctly-sized zero-height container would be dead
 * weight at best.
 *
 * ── the other four, looked at one at a time rather than assumed alike ──
 *
 *   `.aspect-square`     shared by Poster.tsx's channel-logo frame — a plain
 *                        `block overflow-hidden` box around one flow `<img>`,
 *                        exactly like the poster case below — AND by
 *                        PinGate.tsx's PIN keypad, `grid aspect-square
 *                        place-items-center` around a real digit character.
 *                        Tailwind emits ONE rule for both call sites: a
 *                        `::before` inserted into a GRID becomes an actual
 *                        grid item next to that digit, not a spacer behind it,
 *                        and the keypad's layout breaks. The fix cannot reach
 *                        one call site without reaching the other. Left alone.
 *
 *   `.aspect-\[3\/4\]`     only ModernHome.tsx's launch tile: `flex flex-col
 *                        items-center justify-center` around a real icon and
 *                        label. Same failure one layer down — a `::before` in
 *                        a flex column is a flex ITEM, and it would push the
 *                        icon and label down rather than sit behind them.
 *                        Left alone.
 *
 *   `.aspect-video`      its highest-traffic use, the video player, is
 *                        `.stage` and is already covered (above), including
 *                        SeriesDesk's pass-through className, which renders
 *                        through the same component. What is left is
 *                        DetailHero's trailer `<iframe>`, where the class sits
 *                        directly on a REPLACED element with no wrapper to
 *                        hold a `::before` at all — the CSS Pseudo-Elements
 *                        spec leaves generated content on replaced elements
 *                        undefined, so this is not solid ground to build a
 *                        fallback on either. Left alone.
 *
 *   `.aspect-\[2\/3\]`     used exactly two ways: a bare skeleton `<div>` with
 *                        NO children at all (TitleGrid, RelatedRail,
 *                        MovieDetail, Rail's default), and Poster.tsx's `Art`
 *                        frame — a `block overflow-hidden` `<span>` around one
 *                        flow `<img class="art-img h-full w-full">`. Neither
 *                        participates in flex or grid layout, and neither
 *                        already draws a `::before` (checked: nothing in this
 *                        stylesheet puts one on `.skeleton`, `.art`, or
 *                        `.art-img`). This is the one call site the hack is
 *                        actually safe for, and the only one this pass edits.
 *
 * ── why the probe is a straight `CSS.supports`, not a rendered measurement ──
 *
 * `gapFallbacks` cannot trust `CSS.supports('gap','1px')` because that answers
 * yes for grid-only support and lies about flex — the same property name
 * means two different things depending on `display`. `aspect-ratio` has no
 * such split: it is one property with one meaning, so
 * `CSS.supports('aspect-ratio','1 / 1')` has nothing to lie about.
 *
 * ── the fallback ──
 *
 * `.aspect-\[2\/3\]` gains `position:relative`, a `::before` sized by
 * `padding-top` computed from the declared ratio (2/3 means width:height is
 * 2:3, so height is `3/2 * 100%` of the width — 150%), and every real child
 * pinned `position:absolute;inset:0` over it. For the skeleton usage that
 * `>*` selector matches nothing, because there is nothing inside a skeleton
 * div; for the `Art` frame it turns the existing flow `<img>` into an overlay
 * instead, reproducing exactly what a resolved `height` would have given it.
 */
export function aspectRatioFallbacks(css) {
  const ATTR = '[data-noaspect]';
  const SAFE_SELECTOR = '.aspect-[2/3]';
  const fresh = css.replace(/html\[data-noaspect\][^{}]*\{[^{}]*\}/g, '');
  let added = 0;
  const out = fresh.replace(/([^{}]+)\{([^{}]*)\}/g, (whole, rawSel, body) => {
    const sel = rawSel.trim();
    /* Backslash-escapes are stripped rather than matched literally, so this
       survives Tailwind changing how it escapes `[`, `/` and `]` without
       silently going dark. */
    if (sel.replace(/\\/g, '') !== SAFE_SELECTOR) return whole;

    const d = declarations(body);
    const raw = d['aspect-ratio'];
    if (raw === undefined) return whole;
    const [wStr, hStr] = raw.split('/').map((s) => s.trim());
    const w = Number(wStr);
    const h = hStr === undefined ? 1 : Number(hStr);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0) return whole;
    const pct = Math.round((h / w) * 10000) / 100;

    added += 1;
    return `${whole}`
      + `html${ATTR} ${sel}{position:relative}`
      + `html${ATTR} ${sel}::before{content:"";display:block;padding-top:${pct}%}`
      + `html${ATTR} ${sel}>*{position:absolute;inset:0}`;
  });
  return { css: out, added };
}

/**
 * `backdrop-filter` is Chromium 76, and losing it is cosmetic — UNLESS a panel
 * is leaning on the blur itself for legibility rather than on its own
 * background colour, in which case losing the blur but keeping the
 * transparency leaves text sitting directly on whatever is moving underneath
 * it.
 *
 * ── why this cannot be found by scanning declarations alone ──
 *
 * Tailwind's utilities are atomic: `bg-ground/50` and `backdrop-blur-sm` are
 * always two SEPARATE rules, one class each, one declaration each. A rule
 * that sets `backdrop-filter` never also carries the background colour it is
 * blurring — that pairing only exists at the element, in whichever `className`
 * string puts both classes together. So "does this backdrop-filter rule sit
 * on a very transparent background" cannot be answered by looking at the 16
 * `backdrop-filter` lines on their own; it took reading every call site.
 *
 * That turned up four consumers of an actual `backdrop-blur-*`/`backdrop-filter`
 * class:
 *
 *   `.backdrop-blur-\[2px\]`  matches no element in the app at all. Tailwind's
 *                           content scanner is a plain text scan, and it found
 *                           the string inside a COMMENT in DetailHero.tsx that
 *                           documents a style which was since removed — dead
 *                           output from dead prose.
 *   `.backdrop-filter`       same story: the bare word appears in an arbitrary
 *                           `transition-[...]` property list and in a comment
 *                           in Welcome.tsx. Also matches nothing.
 *   `.backdrop-blur-md`      Chrome.tsx's header when NOT scrolled over a
 *                           hero, paired with `bg-panel/95` — 95% opaque
 *                           already, so the blur is decorating a background
 *                           that reads as solid regardless. Losing it changes
 *                           nothing worth fixing.
 *   `.backdrop-blur-sm`      Chrome.tsx's header WHEN scrolled over a hero,
 *                           paired with `bg-ground/50` — 50% opaque, actually
 *                           relying on the blur to stay readable over a
 *                           picture. This is the one that qualifies.
 *
 * ── the fix is targeted, not generic, because the finding is not generic ──
 *
 * A general rule cannot be derived from CSS text that cannot see this pairing
 * in the first place, so this does not try: it checks that both classes still
 * exist in the build, then emits ONE compound selector requiring both —
 * `.bg-ground\/50.backdrop-blur-sm` — which matches exactly the element that
 * carries both classes in its `className` and nothing that carries only one
 * of them. `bg-ground/50` alone shows up elsewhere in this app (chips, an
 * input, a cover overlay) and none of those are touched.
 *
 * The replacement reuses `--color-ground-rgb`, already defined per theme
 * because Tailwind's own opacity-modifier syntax needs it (`bg-ground/50`
 * itself compiles to `rgb(var(--color-ground-rgb) / 0.5)`), at 94% — the same
 * "reads as solid" figure `--glass-read` and `bg-panel/95` already use
 * elsewhere in this app for a panel that has to look opaque.
 */
export function backdropLegibilityFallbacks(css) {
  const ATTR = '[data-nobackdrop]';
  const SEL = '.bg-ground\\/50.backdrop-blur-sm';
  const fresh = css.replace(/html\[data-nobackdrop\][^{}]*\{[^{}]*\}/g, '');
  const hasBoth = fresh.includes('.bg-ground\\/50{') && fresh.includes('.backdrop-blur-sm{');
  if (!hasBoth) return { css: fresh, added: 0 };
  const rule = `html${ATTR} ${SEL}{background-color:rgb(var(--color-ground-rgb) / 0.94)}`;
  return { css: `${fresh}${rule}`, added: 1 };
}

/**
 * `color-mix()` is Chrome/WebView 111, and it failed in the worst way available.
 *
 * Reported from the sofa as "circled icons dont look circuled on TV". The header's
 * round buttons draw their circle as `border: 1px solid color-mix(in srgb,
 * var(--color-ink) 28%, transparent)`, the television's WebView is 83-90, and so
 * the circle was simply never drawn. It is not one rule: the built stylesheet
 * carried 286 `color-mix()` calls — glass edges, focus washes, chip fills,
 * scrims — and every one of them is gone on that hardware.
 *
 * ── why the usual fallback does not work here ──
 *
 * The standard trick is to write a plain declaration first and the modern one
 * after it, so an old parser keeps the first and discards the second. That relies
 * on the parser REJECTING the second, and it cannot: any value containing `var()`
 * is accepted at parse time and only validated at computed-value time, because
 * the browser cannot know what the variable holds until then. So an old WebView
 * keeps the `color-mix()` declaration as the winner, fails to compute it, and
 * sets the property to its initial value — no border, transparent fill — which
 * is worse than having no fallback at all.
 *
 * ── why a REPLACEMENT is exact ──
 *
 * Every one of these that matters mixes a colour with `transparent`, and CSS
 * interpolates alpha premultiplied: `C` at N% against a fully transparent colour
 * unpremultiplies back to exactly `C` at alpha N, in any interpolation space. So
 * `color-mix(in srgb, var(--color-ink) 28%, transparent)` IS
 * `rgb(var(--color-ink-rgb) / 0.28)` — not an approximation, the same colour —
 * and the second form has been understood since Chrome 65. It is swapped in
 * place, and a modern browser renders nothing different.
 *
 * That needs the channels of each token as a variable, so every opaque hex
 * colour token gets an `-rgb` companion written beside it, in every block that
 * defines it: a theme switch re-points the companion exactly as it re-points the
 * token. A token is only rewritten when EVERY definition of it is plain hex — one
 * defined as `var(--other)` anywhere, or carrying its own alpha, is left alone,
 * because a companion that is missing or wrong in one theme would break that
 * theme on every browser rather than fix one.
 *
 * Mixes of two real colours, and `currentColor`, cannot be expressed without
 * `color-mix()` and are left exactly as they were. Regenerates rather than
 * appends, like the passes above.
 */
const HEX_TOKEN = /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\s*$/;
const MIX_VAR = /color-mix\(\s*in\s+[a-z-]+\s*,\s*var\(\s*(--[\w-]+)\s*\)\s+([\d.]+)%\s*,\s*transparent\s*\)/g;
const MIX_HEX = /color-mix\(\s*in\s+[a-z-]+\s*,\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\s+([\d.]+)%\s*,\s*transparent\s*\)/g;

function channels(hex) {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(' ');
}

function alphaOf(pct) {
  /* Decimal rather than a percentage inside `rgb()`: both are valid CSS Color 4,
     and the decimal is the one there is no doubt about on the oldest parser. */
  return String(Math.round(Number(pct) * 100) / 10000);
}

export function colorMixFallbacks(css) {
  /* Which tokens are safe: every definition, everywhere, is opaque hex. */
  const seen = new Map();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const name = m[1];
    if (name.endsWith('-rgb')) continue;
    const ok = HEX_TOKEN.test(`${name}:${m[2].trim()}`);
    seen.set(name, (seen.get(name) ?? true) && ok);
  }
  const safe = new Set([...seen].filter(([, ok]) => ok).map(([n]) => n));

  let companions = 0;
  const withCompanions = css.replace(/([^{}]+)\{([^{}]*)\}/g, (whole, sel, body) => {
    if (sel.trim().startsWith('@')) return whole;
    if (!/--[\w-]+\s*:\s*#/.test(body)) return whole;
    const rebuilt = [];
    for (const d of body.split(';')) {
      const t = d.trim();
      if (t === '') continue;
      /* Drop our own companion from an earlier run; it is re-derived below. */
      const comp = /^(--[\w-]+)-rgb\s*:/.exec(t);
      if (comp !== null && safe.has(comp[1])) continue;
      rebuilt.push(t);
      const m = HEX_TOKEN.exec(t);
      if (m !== null && safe.has(m[1])) {
        rebuilt.push(`${m[1]}-rgb:${channels(m[2])}`);
        companions += 1;
      }
    }
    return `${sel}{${rebuilt.join(';')}}`;
  });

  let replaced = 0;
  const swapped = withCompanions
    .replace(MIX_VAR, (whole, name, pct) => {
      if (!safe.has(name)) return whole;
      replaced += 1;
      return `rgb(var(${name}-rgb) / ${alphaOf(pct)})`;
    })
    .replace(MIX_HEX, (_whole, hex, pct) => {
      replaced += 1;
      return `rgb(${channels(hex)} / ${alphaOf(pct)})`;
    });

  /*
   * And then take away the guard that was only there for what just left.
   *
   * The build does not leave these rules bare: for every declaration using
   * `color-mix()` it writes a static fallback outside — `border:1px solid
   * #e7edef47`, the DEFAULT theme's ink at 28% — and the real rule inside
   * `@supports (color:color-mix(in lab,red,red))`. A WebView below 111 fails that
   * test and skips the whole block. So swapping values inside it changes nothing
   * that hardware can see, and what it does see is the default palette frozen
   * into hex: pick any other theme on an old television and every one of those
   * surfaces stays Midnight.
   *
   * A block whose contents no longer use anything the test was guarding is
   * unwrapped, so its rules — now `rgb(var(--x-rgb) / a)` — apply everywhere, and
   * the theme follows. It lands after the static fallback in source order, so a
   * modern browser resolves exactly as it did before. A block that still carries
   * any colour function that needs this engine keeps its guard.
   */
  const GUARD = '@supports (color:color-mix(in lab,red,red)){';
  const NEEDS = /color-mix\(|oklch\(|oklab\(|\blab\(|\blch\(/;
  let unwrapped = 0;
  let out = '';
  let i = 0;
  for (;;) {
    const at = swapped.indexOf(GUARD, i);
    if (at === -1) { out += swapped.slice(i); break; }
    out += swapped.slice(i, at);
    let depth = 1;
    let j = at + GUARD.length;
    for (; j < swapped.length && depth > 0; j++) {
      if (swapped[j] === '{') depth += 1;
      else if (swapped[j] === '}') depth -= 1;
    }
    const inner = swapped.slice(at + GUARD.length, j - 1);
    if (NEEDS.test(inner)) out += swapped.slice(at, j);
    else { out += inner; unwrapped += 1; }
    i = j;
  }
  return { css: out, replaced, companions, unwrapped };
}

/**
 * `:where()` is Chrome/WebView 88, and an unknown pseudo-class voids its rule.
 *
 * The app's own variants stopped using it — see the note by `@custom-variant` in
 * `index.css`, which is where 96 of the 122 uses came from. What is left is
 * Tailwind's own: `space-y-*` wraps its whole selector in `:where()` so that a
 * `mt-*` on a child can still win, and the preflight uses it for a few resets.
 *
 * Unwrapping a selector that is ENTIRELY `:where(...)` is exact in what it
 * matches and differs only in weight — which is the same trade `gapFallbacks`
 * makes, for the same reason: a rule that is dropped has no weight at all.
 * Selectors where `:where()` is only a part are left alone, because rewriting
 * those changes which elements match, not just how loudly.
 */
export function unwrapWhere(css) {
  let out = '';
  let i = 0;
  let unwrapped = 0;
  while (i < css.length) {
    if (!css.startsWith(':where(', i)) { out += css[i]; i += 1; continue; }
    /* Is this the start of a selector? Only then is the whole selector this. */
    let b = out.length - 1;
    while (b >= 0 && /\s/.test(out[b])) b -= 1;
    const before = b < 0 ? '{' : out[b];
    if (before !== '{' && before !== '}' && before !== ',' && before !== ';') {
      out += css[i]; i += 1; continue;
    }
    /* Find the matching close. */
    let depth = 0;
    let j = i + ':where('.length - 1;
    for (; j < css.length; j += 1) {
      if (css[j] === '(') depth += 1;
      else if (css[j] === ')') { depth -= 1; if (depth === 0) break; }
    }
    if (j >= css.length) { out += css[i]; i += 1; continue; }
    let k = j + 1;
    while (k < css.length && /\s/.test(css[k])) k += 1;
    if (css[k] !== '{' && css[k] !== ',') { out += css[i]; i += 1; continue; }
    out += css.slice(i + ':where('.length, j);
    unwrapped += 1;
    i = j + 1;
  }
  return { css: out, unwrapped };
}

/**
 * Do this app's own rules still come after Tailwind's utilities?
 *
 * The whole safety argument for flattening rests on it — see the header — so it
 * is asserted on every build rather than assumed once. `.stage` is a good
 * sentinel: it is ours, it is in `index.css`, and it exists to beat a utility.
 */
export function customRulesComeLast(css) {
  const utilities = css.lastIndexOf('.flex{');
  const ours = css.indexOf('.stage');
  if (utilities === -1 || ours === -1) return { ok: true, why: 'no sentinel found' };
  return {
    ok: ours > utilities,
    why: `.stage at ${ours}, last .flex{ at ${utilities}`,
  };
}

/**
 * Only when run, never when imported.
 *
 * The first version had this loop at the top level, so `css-compat.test.mjs`
 * importing `flattenLayers` also ran the whole pass and then called
 * `process.exit(0)` — which ended the test process mid-file and reported one
 * passing test instead of eleven. A module that does work on import cannot be
 * tested, and a test that cannot run is worse than no test because it reports
 * success.
 */
/**
 * Every file in the bundle that could name a stylesheet.
 *
 * `index.html` is the one that always does; a JS chunk names it too whenever a
 * route's CSS is loaded on demand. One shallow walk is cheaper than reasoning
 * about which.
 */
function referencesIn(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (/\.(html|js|css|json|webmanifest)$/.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function main(dirs) {
  let bad = 0;
  for (const dir of dirs) {
    const assets = join(resolve(dir), 'assets');
    let files;
    try {
      files = readdirSync(assets).filter((f) => f.endsWith('.css'));
    } catch {
      console.log(`css-compat: no ${assets} — nothing to do`);
      continue;
    }
    for (const f of files) {
      const path = join(assets, f);
      const before = readFileSync(path, 'utf8');
      const flat = flattenLayers(before);
      let css = flat.css;

      const order = customRulesComeLast(css);
      if (!order.ok) {
        console.log(`css-compat: REFUSING ${f} — custom rules would lose precedence (${order.why})`);
        bad += 1;
        continue;
      }
      /* A flatten that leaves one behind is worse than none: the file would be
         partly layered and the precedence argument would no longer hold. */
      if (css.includes('@layer')) {
        console.log(`css-compat: REFUSING ${f} — @layer still present after flattening`);
        bad += 1;
        continue;
      }

      /* Order matters between the two below: unwrapping first means a rule that
         was `:where(.space-y-4>…)` is a real selector by the time the gap pass
         reads it, so it gets a fallback too rather than being skipped as an
         unparseable prelude. */
      const wrapped = unwrapWhere(css);
      css = wrapped.css;
      const physical = physicalFallbacks(css);
      css = physical.css;
      const gaps = gapFallbacks(css);
      css = gaps.css;
      const focusVisible = focusVisibleFallbacks(css);
      css = focusVisible.css;
      const aspect = aspectRatioFallbacks(css);
      css = aspect.css;
      const backdrop = backdropLegibilityFallbacks(css);
      css = backdrop.css;
      /* Last among the rewrites: it only swaps values and adds custom properties,
         so nothing after it can be confused by what it changed. */
      const mixes = colorMixFallbacks(css);
      css = mixes.css;

      /*
       * Rename to match the NEW content, and rewrite every reference to it.
       *
       * Vite hashes the filename from the source stylesheet; this pass then
       * rewrites the bytes behind that name. Together they mean a build whose
       * SOURCE css is unchanged but whose COMPAT pass changed ships different
       * content under an identical URL — and a content-hashed asset URL is
       * exactly the thing nothing ever re-fetches.
       *
       * Not hypothetical. It cost an afternoon here: the fixes below were in the
       * APK, verified by unzipping it, and the television went on painting the
       * old stylesheet because its WebView still had that filename cached from
       * the previous install. A viewer updating the app hits precisely that —
       * the origin is `https://localhost` and it survives the upgrade.
       *
       * So the name follows the bytes: eight hex of the final content appended
       * to the hash Vite wrote, and every file in the bundle that mentions the
       * old name is repointed at the new one.
       */
      const stamp = createHash('sha256').update(css).digest('hex').slice(0, 8);
      const renamed = f.replace(/-([A-Za-z0-9_-]+)\.css$/, `-$1.${stamp}.css`);
      writeFileSync(path, css);
      let repointed = 0;
      if (renamed !== f) {
        renameSync(path, join(assets, renamed));
        for (const ref of referencesIn(resolve(dir))) {
          const text = readFileSync(ref, 'utf8');
          if (!text.includes(f)) continue;
          writeFileSync(ref, text.split(f).join(renamed));
          repointed += 1;
        }
      }
      const delta = css.length - before.length;
      console.log(
        `css-compat: ${f} — layers ${flat.removed} flattened / ${flat.dropped} dropped, `
        + `:where() unwrapped ${wrapped.unwrapped}, logical props ${physical.added}, `
        + `gap fallbacks ${gaps.added}, focus-visible fallbacks ${focusVisible.added}, `
        + `aspect-ratio fallbacks ${aspect.added}, backdrop legibility fallbacks ${backdrop.added}, `
        + `color-mix ${mixes.replaced} replaced (+${mixes.companions} -rgb, ${mixes.unwrapped} guards lifted), `
        + `${delta >= 0 ? '+' : ''}${delta} bytes, re-hashed into ${repointed} reference(s) `
        + `— ${order.why}`,
      );
    }
  }
  return bad;
}

if (process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) dirs.push('apps/web/dist');
  process.exit(main(dirs) === 0 ? 0 : 1);
}
