import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aspectRatioFallbacks, backdropLegibilityFallbacks, colorMixFallbacks, customRulesComeLast, flattenLayers,
  focusVisibleFallbacks, gapFallbacks, physicalFallbacks, unwrapWhere,
} from './css-compat.mjs';

/**
 * An older television has to get a stylesheet it can read.
 *
 * `@layer` is Chrome/WebView 99. Below that the parser consumes the at-rule
 * WITH ITS BLOCK and discards both, so Tailwind v4's output — where the tokens,
 * the reset and every utility live inside layers — evaporates and the app paints
 * as unstyled HTML. Reported as "in some televisions there is no styling at all
 * all the buttons and everything are scrammed", which is precisely what that
 * looks like from a sofa.
 *
 * The flattener is a scanner over CSS, so the tests that matter are the ones
 * about braces it must not miscount.
 */

test('a layer block is replaced by its contents', () => {
  const { css, removed } = flattenLayers('@layer theme{:root{--a:1}}.x{color:red}');
  assert.equal(removed, 1);
  assert.equal(css, ':root{--a:1}.x{color:red}');
});

test('a bare ordering statement disappears entirely', () => {
  const { css, dropped } = flattenLayers('@layer a,b,c;.x{color:red}');
  assert.equal(dropped, 1);
  assert.equal(css, '.x{color:red}');
});

test('nested at-rules inside a layer keep their own braces', () => {
  /* The real file is `@layer properties{@supports(...){*{…}}}` — miscounting
     here would eat the `@supports` close and corrupt everything after it. */
  const { css } = flattenLayers('@layer p{@supports (color:red){*{--t:0}}}.y{top:0}');
  assert.equal(css, '@supports (color:red){*{--t:0}}.y{top:0}');
});

test('several layers flatten in order, so precedence survives', () => {
  const { css, removed } = flattenLayers(
    '@layer theme{.a{color:red}}@layer utilities{.a{color:blue}}',
  );
  assert.equal(removed, 2);
  /* Order preserved means utilities still wins, which is the whole argument. */
  assert.equal(css, '.a{color:red}.a{color:blue}');
});

test('a brace inside a string is not a brace', () => {
  const { css } = flattenLayers('@layer u{.a:after{content:"}"}}.b{top:0}');
  assert.equal(css, '.a:after{content:"}"}.b{top:0}');
});

test('a brace inside a comment is not a brace', () => {
  const { css } = flattenLayers('@layer u{/* } */.a{top:0}}.b{left:0}');
  assert.equal(css, '/* } */.a{top:0}.b{left:0}');
});

test('a stylesheet with no layers is returned untouched', () => {
  const src = '.a{color:red}@media (min-width:10px){.b{color:blue}}';
  const { css, removed, dropped } = flattenLayers(src);
  assert.equal(css, src);
  assert.equal(removed, 0);
  assert.equal(dropped, 0);
});

test('flattening is idempotent', () => {
  const once = flattenLayers('@layer theme{.a{color:red}}').css;
  const twice = flattenLayers(once).css;
  assert.equal(once, twice);
});

test('an unterminated layer is left alone rather than corrupted', () => {
  /* Truncated CSS is a broken build, and a flattener that "fixes" it by
     rewriting the tail turns a loud failure into a subtle one. */
  const src = '@layer theme';
  assert.equal(flattenLayers(src).css, src);
});

test('the precedence check notices custom rules losing their place', () => {
  assert.equal(customRulesComeLast('.stage{a:1}.flex{b:2}').ok, false);
  assert.equal(customRulesComeLast('.flex{b:2}.stage{a:1}').ok, true);
});

/**
 * And the built file itself, when there is one.
 *
 * The unit tests above prove the scanner; this proves the BUILD ran it. A
 * flattener nobody wired into `pnpm build` is worth nothing, and that is an easy
 * thing to lose in a package.json merge.
 */
test('the built stylesheet carries no cascade layers', () => {
  const assets = join(import.meta.dirname, '..', 'apps', 'web', 'dist', 'assets');
  let files;
  try {
    files = readdirSync(assets).filter((f) => f.endsWith('.css'));
  } catch {
    console.log('    (no build to check — run pnpm build)');
    return;
  }
  for (const f of files) {
    const css = readFileSync(join(assets, f), 'utf8');
    assert.ok(!css.includes('@layer'), `${f} still contains @layer — did pnpm build skip css-compat?`);
    /* Balanced braces is the cheapest proof the scanner did not corrupt it. */
    const open = (css.match(/{/g) ?? []).length;
    const close = (css.match(/}/g) ?? []).length;
    assert.equal(open, close, `${f} has unbalanced braces after flattening`);
  }
});


/*
 * ── the three passes that came after the layers ────────────────────────────
 *
 * Each one exists because a single property or selector, unsupported, takes the
 * whole declaration or the whole rule with it. They are pure string functions,
 * so the tests that matter are the ones about values a naive split would cut in
 * half — `calc(var(--spacing) * 2)` contains two spaces and neither separates
 * anything — and about the cases each pass must decline to touch.
 */

test('a logical property gains its physical pair, and keeps the original after it', () => {
  const { css, added } = physicalFallbacks('.px-2{padding-inline:calc(var(--spacing) * 2)}');
  assert.equal(added, 1);
  assert.equal(
    css,
    '.px-2{padding-left:calc(var(--spacing) * 2);padding-right:calc(var(--spacing) * 2);'
    + 'padding-inline:calc(var(--spacing) * 2)}',
  );
});

test('the logical property comes LAST, so a modern browser still wins with it', () => {
  const { css } = physicalFallbacks('.a{padding-block:1px}');
  assert.ok(css.indexOf('padding-block') > css.indexOf('padding-bottom'));
});

test('two values are start-then-end, which left-to-right is left-then-right', () => {
  const { css } = physicalFallbacks('.a{margin-inline:1px 2px}');
  assert.ok(css.includes('margin-left:1px;margin-right:2px'));
});

test('the long forms are Chrome 69 and left alone', () => {
  const { added } = physicalFallbacks('.a{padding-inline-start:1px}');
  assert.equal(added, 0);
});

test('a gap utility gets a margin for each direction, behind the attribute', () => {
  const { css, added } = gapFallbacks('.gap-2{gap:8px}');
  assert.equal(added, 1);
  assert.ok(css.includes('[data-nogap] .gap-2.flex-col>*+*{margin-top:8px}'));
  assert.ok(css.includes('[data-nogap] .gap-2:not(.grid):not(.flex-col)>*+*{margin-left:8px}'));
});

test('a rule that says which way it runs gets only that axis', () => {
  const { css } = gapFallbacks('.col{display:flex;flex-direction:column;gap:4px}');
  assert.ok(css.includes('margin-top:4px'));
  assert.ok(!css.includes('margin-left'));
});

test('a grid is skipped — grid gap is Chrome 66 and doubling it would be worse', () => {
  const { added } = gapFallbacks('.g{display:grid;gap:4px}');
  assert.equal(added, 0);
});

test('running twice produces the same file, not two copies of the fallback', () => {
  /* The pass regenerates rather than appends, so `added` counts the rules it
     wrote either way — the invariant that matters is the OUTPUT. */
  const once = gapFallbacks('.gap-2{gap:8px}').css;
  assert.equal(gapFallbacks(once).css, once);
});

test('the physical pair is regenerated, not duplicated, on a second run', () => {
  const once = physicalFallbacks('.px-2{padding-inline:8px}').css;
  const twice = physicalFallbacks(once).css;
  assert.equal(twice, once);
});

test('a selector that is entirely :where() is unwrapped', () => {
  const { css, unwrapped } = unwrapWhere(':where(.space-y-4>:not(:last-child)){margin-top:1px}');
  assert.equal(unwrapped, 1);
  assert.equal(css, '.space-y-4>:not(:last-child){margin-top:1px}');
});

test(':where() in the MIDDLE of a selector is left alone — unwrapping changes what matches', () => {
  const { unwrapped } = unwrapWhere('.a:where([data-ff=tv] *){color:red}');
  assert.equal(unwrapped, 0);
});

test('a feature query naming :where() is not a selector and is not touched', () => {
  const src = '@supports selector(:where(a)){.x{color:red}}';
  assert.equal(unwrapWhere(src).css, src);
});

/* ── color-mix(), which a television below WebView 111 cannot compute ──────── */

test('a mix of a token with transparent becomes the same colour at that alpha', () => {
  /* The header's round buttons, exactly as they ship. */
  const src = ':root{--color-ink:#e7edef}'
    + '.modern-icon{border:1px solid color-mix(in srgb, var(--color-ink) 28%, transparent)}';
  const { css, replaced, companions } = colorMixFallbacks(src);
  assert.equal(replaced, 1);
  assert.equal(companions, 1);
  assert.match(css, /--color-ink-rgb:231 237 239/);
  assert.match(css, /border:1px solid rgb\(var\(--color-ink-rgb\) \/ 0\.28\)/);
  assert.doesNotMatch(css, /color-mix/);
});

test('the rewrite leaves no var()-bearing color-mix behind for an old parser to keep', () => {
  /* The trap: a value containing var() cannot be rejected at parse time, so a
     "fallback first" pair has the OLD browser keep the color-mix one and then
     blank the property. The only safe outcome is that none remain. */
  const src = ':root{--color-ground:#0b1013;--color-tally:#e8a34a}'
    + '.a{background:color-mix(in srgb,var(--color-ground) 70%,transparent)}'
    + '.b{background-color:color-mix(in oklab,var(--color-tally) 15%,transparent)}';
  const { css } = colorMixFallbacks(src);
  assert.doesNotMatch(css, /color-mix\([^)]*var\(/);
});

test('every theme block gets its own companion, so a theme switch still follows', () => {
  const src = ':root{--color-ink:#ffffff}html[data-theme=paper]{--color-ink:#09120f}'
    + '.x{color:color-mix(in srgb,var(--color-ink) 50%,transparent)}';
  const { css } = colorMixFallbacks(src);
  assert.match(css, /:root\{--color-ink:#ffffff;--color-ink-rgb:255 255 255\}/);
  assert.match(css, /data-theme=paper\]\{--color-ink:#09120f;--color-ink-rgb:9 18 15\}/);
});

test('a token that is not plain hex everywhere is left exactly alone', () => {
  /* A companion that is missing in one theme would break that theme on EVERY
     browser. Refusing is the only safe answer when one definition is a var. */
  const src = ':root{--glass-edge:#ffffff}html[data-shell=modern]{--glass-edge:var(--color-ink)}'
    + '.x{border-color:color-mix(in srgb,var(--glass-edge) 40%,transparent)}';
  const { css, replaced } = colorMixFallbacks(src);
  assert.equal(replaced, 0);
  assert.match(css, /color-mix\(in srgb,var\(--glass-edge\) 40%,transparent\)/);
  assert.doesNotMatch(css, /--glass-edge-rgb/);
});

test('a mix of two real colours is not something rgb() can say, and is kept', () => {
  const src = ':root{--color-tally:#e8a34a;--color-ink:#e7edef}'
    + '.x{color:color-mix(in srgb,var(--color-tally) 60%,var(--color-ink))}';
  const { css, replaced } = colorMixFallbacks(src);
  assert.equal(replaced, 0);
  assert.match(css, /color-mix\(in srgb,var\(--color-tally\) 60%,var\(--color-ink\)\)/);
});

test('a literal hex mix is folded to its value', () => {
  const { css } = colorMixFallbacks('.x{background:color-mix(in srgb, #fff 8%, transparent)}');
  assert.equal(css, '.x{background:rgb(255 255 255 / 0.08)}');
});

test('the color-mix pass run twice changes nothing the second time', () => {
  const src = ':root{--color-ink:#e7edef}'
    + '.x{border:1px solid color-mix(in srgb,var(--color-ink) 28%,transparent)}';
  const once = colorMixFallbacks(src).css;
  assert.equal(colorMixFallbacks(once).css, once);
});


test('a guard with nothing left to guard is lifted, so an old WebView applies the rule', () => {
  const src = ':root{--color-ink:#e7edef}'
    + '.m{border:1px solid #e7edef47}'
    + '@supports (color:color-mix(in lab,red,red)){.m{border:1px solid color-mix(in srgb,var(--color-ink) 28%,transparent)}}';
  const { css, unwrapped } = colorMixFallbacks(src);
  assert.equal(unwrapped, 1);
  assert.doesNotMatch(css, /@supports/);
  /* The static fallback stays first, and the themed rule now follows it. */
  assert.ok(css.indexOf('#e7edef47') < css.indexOf('rgb(var(--color-ink-rgb) / 0.28)'));
});

test('a guard still protecting a colour function keeps its block', () => {
  const src = ':root{--a:#ffffff;--b:#000000}'
    + '@supports (color:color-mix(in lab,red,red)){.m{color:color-mix(in srgb,var(--a) 50%,var(--b))}}';
  const { css, unwrapped } = colorMixFallbacks(src);
  assert.equal(unwrapped, 0);
  assert.match(css, /@supports \(color:color-mix\(in lab,red,red\)\)\{/);
});


/*
 * ── `:focus-visible`, where an unrecognised pseudo-class voids the WHOLE rule ──
 *
 * The critical fallback: without it, every rule that mentions the pseudo-class
 * — including the one that draws the focus ring at all — is dropped below
 * Chromium 86, and a D-pad interface with no focus ring cannot be used.
 */

test('a bare :focus-visible rule is duplicated, gated, and rewritten to :focus', () => {
  const { css, added } = focusVisibleFallbacks(':focus-visible{outline:2px solid red}');
  assert.equal(added, 1);
  assert.ok(css.includes(':focus-visible{outline:2px solid red}'), 'the original rule survives untouched');
  assert.ok(css.includes('html[data-nofocusvisible] :focus{outline:2px solid red}'));
});

test('a class compound keeps its class and is scoped as a descendant of the probe', () => {
  const { css } = focusVisibleFallbacks('.focus-visible\\:border-focus:focus-visible{border-color:red}');
  assert.ok(css.includes(
    'html[data-nofocusvisible] .focus-visible\\:border-focus:focus{border-color:red}',
  ));
});

test('a selector already leading with html[...] gets the attribute folded into THAT compound', () => {
  /* Prepending a second `html` ancestor would require <html> to be its own
     descendant, which can never match — this is the trap the fold avoids. */
  const { css } = focusVisibleFallbacks('html[data-ff=tv] :focus-visible{outline:none}');
  assert.ok(css.includes('html[data-nofocusvisible][data-ff=tv] :focus{outline:none}'));
  assert.ok(!css.includes('html[data-nofocusvisible] html'));
});

test('every fragment in the list is reproduced, not just the ones naming :focus-visible', () => {
  /* The whole rule was invalid, so the :hover fragment lost its styling too —
     the duplicate has to restore all of it, not add back only the bad part. */
  const { css } = focusVisibleFallbacks('.tile:hover,.tile:focus-visible{transform:none}');
  const fallback = 'html[data-nofocusvisible] .tile:hover,html[data-nofocusvisible] .tile:focus{transform:none}';
  assert.ok(css.includes(fallback));
});

test('a fragment with :focus-visible more than once gets every occurrence rewritten', () => {
  const { css } = focusVisibleFallbacks('.a:focus-visible:not(:focus-visible.x){color:red}');
  assert.ok(css.includes('html[data-nofocusvisible] .a:focus:not(:focus.x){color:red}'));
});

test('the group-focus-visible shape is rewritten too, even though :is()/:where() leave it dark on old engines', () => {
  /* Documented limitation, not a bug: :is()/:where() are Chromium 88, the same
     generation as :focus-visible itself, so this duplicate cannot help the
     televisions this file targets — see the header comment. The rewrite still
     happens uniformly rather than special-casing it away. */
  const { css } = focusVisibleFallbacks(
    '.group-focus-visible\\/hdr\\:text-focus:is(:where(.group\\/hdr):focus-visible *){color:red}',
  );
  assert.ok(css.includes(
    'html[data-nofocusvisible] .group-focus-visible\\/hdr\\:text-focus:is(:where(.group\\/hdr):focus *){color:red}',
  ));
});

test('a rule with no :focus-visible is left alone', () => {
  const { added } = focusVisibleFallbacks('.a:hover{color:red}');
  assert.equal(added, 0);
});

test('running the focus-visible pass twice changes nothing the second time', () => {
  const once = focusVisibleFallbacks('.a:focus-visible{color:red}').css;
  assert.equal(focusVisibleFallbacks(once).css, once);
});

/* ── `aspect-ratio`, where only one of four utility classes is safe to touch ── */

test('the poster-ratio utility gets a padding-hack fallback with a correctly computed percentage', () => {
  const { css, added } = aspectRatioFallbacks('.aspect-\\[2\\/3\\]{aspect-ratio:2/3}');
  assert.equal(added, 1);
  assert.ok(css.includes('.aspect-\\[2\\/3\\]{aspect-ratio:2/3}'), 'the original rule survives untouched');
  assert.ok(css.includes('html[data-noaspect] .aspect-\\[2\\/3\\]{position:relative}'));
  assert.ok(css.includes('html[data-noaspect] .aspect-\\[2\\/3\\]::before{content:"";display:block;padding-top:150%}'));
  assert.ok(css.includes('html[data-noaspect] .aspect-\\[2\\/3\\]>*{position:absolute;inset:0}'));
});

test('square, 3/4 and video are left alone — each is shared with a call site the hack would break', () => {
  const src = '.aspect-square{aspect-ratio:1}'
    + '.aspect-\\[3\\/4\\]{aspect-ratio:3/4}'
    + '.aspect-video{aspect-ratio:var(--aspect-video)}';
  const { css, added } = aspectRatioFallbacks(src);
  assert.equal(added, 0);
  assert.equal(css, src);
});

test('running the aspect-ratio pass twice changes nothing the second time', () => {
  const once = aspectRatioFallbacks('.aspect-\\[2\\/3\\]{aspect-ratio:2/3}').css;
  assert.equal(aspectRatioFallbacks(once).css, once);
});

/* ── `backdrop-filter`, where only one verified pairing needs a fallback ── */

test('the one legibility-risking pairing gets a compound, opaque fallback', () => {
  const src = '.bg-ground\\/50{background-color:rgb(var(--color-ground-rgb) / 0.5)}'
    + '.backdrop-blur-sm{backdrop-filter:blur(8px)}';
  const { css, added } = backdropLegibilityFallbacks(src);
  assert.equal(added, 1);
  assert.ok(css.includes(
    'html[data-nobackdrop] .bg-ground\\/50.backdrop-blur-sm{background-color:rgb(var(--color-ground-rgb) / 0.94)}',
  ));
});

test('a bg-ground/50 use with no blur class anywhere in the file gets nothing added', () => {
  const { added } = backdropLegibilityFallbacks('.bg-ground\\/50{background-color:red}.chip{color:blue}');
  assert.equal(added, 0);
});

test('running the backdrop pass twice changes nothing the second time', () => {
  const src = '.bg-ground\\/50{background-color:red}.backdrop-blur-sm{backdrop-filter:blur(8px)}';
  const once = backdropLegibilityFallbacks(src).css;
  assert.equal(backdropLegibilityFallbacks(once).css, once);
});
