import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No element may carry an unconditional position utility AND a conditional one.
 *
 * This is not a style rule. Tailwind emits the position utilities in one fixed
 * order — `static`, `fixed`, `absolute`, `relative`, `sticky` — all at the same
 * specificity, so when two of them land on the same element the LAST one in the
 * stylesheet wins regardless of which one the code meant. Measured in the built
 * bundle: `.fixed{position:fixed}` at byte 7880, `.relative{position:relative}`
 * at 7936. `relative` therefore beats `fixed` every time, silently.
 *
 * ── the bug this is here to stop coming back ──
 *
 * The player's `.stage` was written as
 *
 *     `stage group relative overflow-hidden bg-black ${cssFull
 *        ? 'fixed inset-0 z-50 h-full w-full'
 *        : `shrink-0 ${className ?? 'aspect-video w-full'}`}`
 *
 * which reads as "relative normally, fixed in fullscreen" and is not what it
 * does: `relative` sits in the static prefix, so in fullscreen the element
 * carried both and stayed relative. `inset-0 h-full w-full` then applied to a
 * still-in-flow box inside the right-hand column, so the picture reflowed to the
 * column's width and letterboxed itself while the header, the country rail and
 * the channel list stayed exactly where they were.
 *
 * Measured on the Android TV emulator at the box's own 960x540: the "fullscreen"
 * picture was 442x454 at 518,43 — 442px being precisely the `w-[46%]` column.
 * Reported as "now when full screen, the whole player disapers", and it had
 * never worked, including in the release whose commit message called it "Proper
 * fullscreen".
 *
 * Nothing about that is visible in the diff, in a type, or in a screenshot taken
 * anywhere but a television. It is visible here.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const POSITION = ['static', 'fixed', 'absolute', 'relative', 'sticky'] as const;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(path));
    else if (e.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** Comments hold prose about `relative` and `fixed` and must not be read as code. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * The class tokens a `className={...}` expression always applies, versus the
 * ones it only applies down some branch.
 *
 * Only template literals can mix the two, so only they are split: literal text
 * at interpolation depth 0 is unconditional, and everything inside a `${...}` is
 * a branch. An expression that is not a template literal has no static part to
 * conflict with.
 */
function split(expr: string): { always: string[]; sometimes: string[] } {
  const always: string[] = [];
  const sometimes: string[] = [];
  const src = stripComments(expr);
  if (!src.trimStart().startsWith('`')) return { always, sometimes: words(src) };

  const start = src.indexOf('`');
  let depth = 0;
  let literal = '';
  let dynamic = '';
  for (let i = start + 1; i < src.length; i++) {
    const two = src.slice(i, i + 2);
    if (depth === 0 && two === '${') { depth = 1; i += 1; continue; }
    if (depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) continue;
      }
      dynamic += src[i];
      continue;
    }
    if (src[i] === '`') break;
    literal += src[i];
  }
  return { always: words(literal), sometimes: words(dynamic) };
}

/** Bare class tokens, with quotes and punctuation treated as separators. */
function words(s: string): string[] {
  return s.split(/[^A-Za-z0-9_[\]:%.\-/]+/).filter((w) => w.length > 0);
}

/** Every `className={...}` expression in a file, brace-balanced. */
function classNameExprs(src: string): string[] {
  const out: string[] = [];
  const needle = 'className={';
  for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
    let depth = 0;
    const from = at + needle.length - 1;
    for (let i = from; i < src.length; i++) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) { out.push(src.slice(from + 1, i)); break; }
      }
    }
  }
  return out;
}

test('no className mixes an unconditional position utility with a conditional one', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const expr of classNameExprs(src)) {
      const { always, sometimes } = split(expr);
      const fixedAlways = POSITION.filter((p) => always.includes(p));
      const fixedSometimes = POSITION.filter((p) => sometimes.includes(p));
      if (fixedAlways.length === 0 || fixedSometimes.length === 0) continue;
      /* The same utility on both sides is redundant, not wrong. */
      const clash = fixedSometimes.filter((p) => !fixedAlways.includes(p));
      if (clash.length === 0) continue;
      offenders.push(
        `${file.slice(SRC.length)}: always "${fixedAlways.join(' ')}" + sometimes "${clash.join(' ')}"`,
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `A conditional position utility cannot beat an unconditional one — Tailwind's
order decides, not the code's intent. Move the unconditional one into the branch
that wants it:\n  ${offenders.join('\n  ')}`,
  );
});

test('the split reads a template literal the way the compiler does', () => {
  const { always, sometimes } = split(
    '`stage group relative overflow-hidden ${cssFull ? \'fixed inset-0\' : \'shrink-0\'}`',
  );
  assert.ok(always.includes('relative'), 'literal text is unconditional');
  assert.ok(!always.includes('fixed'), 'a branch is not unconditional');
  assert.ok(sometimes.includes('fixed') && sometimes.includes('shrink-0'));
});

test('prose about position in a comment is not a class', () => {
  const { always } = split('`stage /* fixed is wrong here */ ${x ? \'absolute\' : \'\'}`');
  assert.ok(!always.includes('fixed'));
});
