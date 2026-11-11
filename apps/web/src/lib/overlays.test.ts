import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every overlay in the app declares what it does to focus.
 *
 * This test exists because of the exact failure it now prevents. Focus
 * containment was added to `Sheet`, `PinGate` and two others — and the app has
 * fourteen overlays. So the settings panel, the filter dropdown, the profile
 * sheet and the player's own subtitle panel all leaked: press Down enough times
 * in any of them and focus walked out onto the page behind, which on a remote
 * means the highlight vanishes into a list you cannot see.
 *
 * Deciding this per component is the bug. A rule that a person has to remember
 * for a component they are writing at 2am is not a rule, so it is checked here
 * instead: anything positioned and painted above the frame must say one of three
 * things about itself.
 *
 *   `data-nav-contain`  a boundary — focus cannot leave it (every menu, sheet,
 *                       dialog, dropdown and panel)
 *   `data-nav-scope`    a section — preferred, but focus may escalate out
 *   `data-nav-skip`     not navigable at all (a backdrop, a gradient, a caption)
 *
 * The threshold is z-40, which is where this app's frame starts: the header, the
 * tab bar and the hint bar sit there, and everything that floats over them is
 * above. `relative` elements are excluded because they are the frame itself
 * rather than something on top of it.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** Every .tsx under apps/web/src, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(path));
    else if (e.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/**
 * The text of the JSX opening tag containing a given offset.
 *
 * Written by hand rather than with a parser for one reason: `>` appears inside
 * attributes all the time (`onClick={() => …}`), so finding the end of a tag means
 * tracking brace and quote depth. That is 20 lines here and a build dependency
 * otherwise.
 */
function tagAround(src: string, at: number): string | null {
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) { start = i; break; }
    if (src[i] === '>') return null; // we walked out of the tag: not an attribute
  }
  if (start === -1) return null;

  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const FLOATS = /\b(?:fixed|absolute)\b/;
const COVERS = /\b(?:fixed|absolute)\b[^"`]*\binset-0\b/;
const HIGH = /\bz-(?:40|50|\[[6-9]0\]|\[1[0-9]{2}\])\b/;
const DECLARED = /data-nav-(?:contain|scope|skip)/;

test('every overlay says what it does to focus', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const src = readFileSync(file, 'utf8');
    const seen = new Set<string>();
    for (const m of src.matchAll(/\bz-(?:40|50|\[[0-9]+\])\b/g)) {
      const tag = tagAround(src, m.index);
      if (tag === null || seen.has(tag)) continue;
      seen.add(tag);
      if (!HIGH.test(tag) || !FLOATS.test(tag)) continue;
      // Something that cannot be clicked cannot hold focus either.
      if (tag.includes('pointer-events-none')) continue;
      if (DECLARED.test(tag)) continue;
      const where = `${file.slice(file.lastIndexOf('/') + 1)}:${src.slice(0, m.index).split('\n').length}`;
      offenders.push(`${where}  ${tag.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} floating element(s) above the frame do not declare focus behaviour.\n`
      + 'Add data-nav-contain (a menu or dialog), data-nav-scope (a section) or '
      + 'data-nav-skip (a backdrop or decoration):\n  ' + offenders.join('\n  '),
  );
});


/**
 * A click-catcher must not be somewhere focus can land.
 *
 * Every overlay in this app closes on a press outside, and the way that is
 * implemented is a viewport-sized `<button>` behind the panel. With a mouse it is
 * exactly right. To spatial navigation it is a focusable rectangle the size of the
 * screen, whose centre therefore sits nearer to almost everything than anything
 * else does — so it wins geometry contests it has no business entering, and
 * landing on it means an invisible target where OK closes the menu.
 *
 * `data-nav-skip` takes it out of the running while leaving the mouse behaviour
 * untouched. This is separate from the rule above because these have no z-index of
 * their own: they sit inside a container that already has one.
 */
test('a full-screen click-catcher is never a focus target', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<button\b/g)) {
      const tag = tagAround(src, m.index + 2);
      if (tag === null || !COVERS.test(tag)) continue;
      if (/data-nav-skip/.test(tag)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${file.slice(file.lastIndexOf('/') + 1)}:${line}  ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} viewport-sized button(s) can take focus. Add data-nav-skip:\n  `
      + offenders.join('\n  '),
  );
});
