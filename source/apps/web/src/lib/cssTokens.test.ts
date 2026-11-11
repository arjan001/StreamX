import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every custom property a component names must actually exist.
 *
 * An undefined custom property does not fall back and does not warn. `var(--t-xl)`
 * where `--t-xl` was never declared makes the whole declaration invalid at
 * computed-value time, which for an inherited property means "use the parent's
 * value" — so `font-size: var(--t-xl)` silently paints at body size instead.
 * Nothing about that is visible in a type, in a diff, or in a screenshot taken
 * on a phone-sized window where body size is not obviously wrong.
 *
 * ── the bug this is here to stop coming back ──
 *
 * `--t-xl` and `--t-2xl` were used in four places in `Welcome.tsx` and one in
 * `SeriesDesk.tsx` and were declared nowhere. The type scale stops at `--t-lg`.
 * So the first screen anybody ever sees had its heading, its question and its
 * body copy all at exactly 12px, which is why it was reported as "this looks so
 * bad" — the screen had no typographic hierarchy at all, and the code said it
 * did.
 *
 * The scan is deliberately dumb: any `var(--name)` in a `.ts`/`.tsx` source has
 * to appear as `--name:` somewhere in `index.css`. Two things it does NOT try to
 * be clever about, both on purpose:
 *
 *   - Declarations set from script (`--ambient`, and the tint slots) are read
 *     from the code as well as the stylesheet, so a property the app defines at
 *     runtime counts as defined.
 *   - Scope is ignored. A token declared under one theme and used under another
 *     is a different bug and one this cannot see; what it catches is the token
 *     that exists nowhere, which is the one that has actually happened twice.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const CSS = join(SRC, 'index.css');
const CHROME = join(SRC, 'components/Chrome.tsx');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** Names declared anywhere in the stylesheet, at any scope. */
function declaredInCss(): Set<string> {
  const css = readFileSync(CSS, 'utf8');
  const out = new Set<string>();
  for (const m of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) out.add(m[1]!);
  return out;
}

/**
 * Names the app writes itself, via `setProperty` or a `style` object.
 *
 * `--ambient` is published by the player from the frame it is showing and the
 * five tint slots are written from a viewer's own colours, so none of them can
 * be declared in the stylesheet — the stylesheet is what reads them.
 */
function declaredInCode(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/setProperty\(\s*['"`](--[a-zA-Z0-9-]+)/g)) out.add(m[1]!);
    /* An inline style object: `{ '--ambient': shade }`. */
    for (const m of s.matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]\s*:/g)) out.add(m[1]!);
  }
  return out;
}

test('no component names a custom property that does not exist', () => {
  const files = sources(SRC);
  assert.ok(files.length > 100, `only found ${files.length} sources`);
  const known = new Set([...declaredInCss(), ...declaredInCode(files)]);

  const missing: string[] = [];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      const name = m[1]!;
      if (known.has(name)) continue;
      const line = s.slice(0, m.index).split('\n').length;
      missing.push(`${f.slice(SRC.length)}:${line}  ${name}`);
    }
  }
  assert.deepEqual(missing, [], `undefined custom properties:\n${missing.join('\n')}`);
});

test('the type scale is complete in both densities', () => {
  /*
   * Every step has to exist in the television block as well as the default one.
   * A step declared only at `:root` does not break — it inherits the phone size
   * — it just quietly stops scaling on the one screen the scale exists for, and
   * a 21px heading among 15px rows is a hierarchy that collapses at three
   * metres. This is the check the missing tokens would not have needed.
   */
  const css = readFileSync(CSS, 'utf8');
  const block = (selector: string): Set<string> => {
    const at = css.indexOf(selector);
    assert.ok(at !== -1, `${selector} not found`);
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', open);
    const out = new Set<string>();
    for (const m of css.slice(open, close).matchAll(/(--t-[a-z0-9]+)\s*:/g)) out.add(m[1]!);
    return out;
  };
  const root = block('\n:root {\n  --t-2xs');
  const tv = block("html[data-density='tv'] {");
  assert.ok(root.size >= 7, `${root.size} steps at :root`);
  assert.deepEqual([...root].sort(), [...tv].sort());
});

/**
 * The header's own edge clears the overscan band, and the header actually
 * spends the property that does it.
 *
 * "look at those top circles are not properly circle, i mean have you didnt
 * have enough space or what". Measured on the box's own 960x540: the round
 * icon buttons in the header are a perfect 33x33 circle, and the rightmost
 * one's outer edge sat 13px from the panel edge — inside the ~2.5-3% band a
 * television crops off every picture (see the comment on `--edge-t` above),
 * which is what made a real circle read as clipped.
 *
 * Two ways this could quietly regress: the number drifts back under the
 * overscan band (this is the same check `--row-step` gets above, for the
 * same reason — the two places that have to agree are a stylesheet and a
 * component, and nothing but a test catches them drifting apart), or the
 * property stays correctly defined while some later edit to `Chrome.tsx`
 * drops the utility that reads it, which would compile clean and look
 * clipped again on the one screen nobody was looking at.
 */
test("the header's inline safe margin clears the overscan band, and the header spends it", () => {
  const css = readFileSync(CSS, 'utf8');
  const m = /--tv-safe-x:\s*([\d.]+)vw/.exec(css);
  assert.ok(m, '--tv-safe-x is not declared as a vw value in index.css');
  const vw = Number(m![1]);
  assert.ok(vw >= 2.5 && vw <= 3, `--tv-safe-x is ${vw}vw, want 2.5-3vw (24-29px at 960px wide)`);

  const chrome = readFileSync(CHROME, 'utf8');
  assert.match(
    chrome,
    /tv:px-\[var\(--tv-safe-x\)\]/,
    'the header no longer spends --tv-safe-x — the circles it protects will clip again',
  );
});
