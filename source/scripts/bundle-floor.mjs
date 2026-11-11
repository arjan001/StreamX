/**
 * How old a browser can be and still run this bundle.
 *
 * One stray modern API from a transitive dependency is a white screen on a whole
 * model year with no console, so the built bundle is grepped for it. Without this
 * check the floor was whatever Vite's default `target` happened to be, a moving
 * number nobody looked at: the shipped wrapper bundle needed Chrome 92+, in an APK
 * whose `minSdkVersion` is 23 (Android 6).
 *
 * FLOOR is 68. The packaged TV builds (Tizen, webOS) run on the television's own
 * browser engine, and 70 missed two entire
 * 2020 model years by one or two versions — Samsung's own developer docs put
 * Tizen 5.5 (2020) at Chromium 69, and LG's put webOS 5 (2020) at roughly
 * Chromium 68. 68 is the lower of those two, so one number covers both 2020
 * sets instead of leaving one of them out by a single version. Full reasoning
 * and the measured byte cost of 70/69/68/63 are in `apps/web/vite.config.ts`
 * next to `target` — keep the two comments and the two numbers in step.
 * RAISING THIS BACK TO 70 SILENTLY DROPS EVERY 2020 SAMSUNG AND LG TELEVISION —
 * the build stays green, nothing errors, the sets just show a white screen.
 *
 * That matters more here than in most apps. A Capacitor build renders in the
 * SYSTEM WebView — the device's own browser engine — and on TV boxes that engine
 * is routinely frozen at whatever shipped with the hardware. Playback no longer
 * depends on it (libVLC decodes natively, see `lib/nativePlayer.ts`), but the
 * interface does, completely.
 *
 * TWO KINDS OF FINDING, and they are not the same problem:
 *
 *   SYNTAX — `?.`, `??`, `||=`, `#private`, `static {}`. A build target fixes
 *     these: esbuild compiles them down. If one appears above the declared floor,
 *     `build.target` in vite.config.ts is not doing what it says.
 *
 *   RUNTIME APIS — `structuredClone`, `Array.at`, `Object.hasOwn`. No transpiler
 *     can invent these; they need a polyfill or avoiding. A call that would
 *     crash the floor engine FAILS unless the inline shim block in index.html
 *     puts the API back; one an older engine merely ignores is only noted.
 *
 * Usage: bundle-floor.mjs [dir ...]   (defaults to the web and wrapper outputs)
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What `apps/web/index.html` already puts back, so this gate does not cry wolf.
 *
 * The page carries an inline ES5 block that installs `Array.prototype.flat`,
 * `flatMap`, `Object.fromEntries` and `globalThis` where the engine lacks them
 * — see the comment above it, and `scripts/legacy-shim.test.mjs`, which runs
 * that exact block against the real methods.
 *
 * Without this, the gate reports those four as crashes forever, on a build
 * where they demonstrably are not: a real browser with them deleted still draws
 * every screen. A warning that is wrong every time
 * is a warning nobody reads, and the next genuine one goes past unnoticed.
 *
 * Read from the file rather than listed here, so deleting a shim turns its
 * warning back on by itself.
 */
function shimmedApis() {
  let html = '';
  try { html = readFileSync(join(ROOT, 'apps/web/index.html'), 'utf8'); } catch { return new Set(); }
  const block = /\/\* legacy-shim:start \*\/([\s\S]*?)\/\* legacy-shim:end \*\//.exec(html);
  if (block === null) return new Set();
  const src = block[1];
  const has = new Set();
  if (/'flat'/.test(src)) has.add('flat');
  if (/'flatMap'/.test(src)) has.add('flatMap');
  if (/Object\.fromEntries\s*=/.test(src)) has.add('fromEntries');
  if (/globalThis\s*=\s*window/.test(src)) has.add('globalThis');
  if (/structuredClone\s*=\s*function/.test(src)) has.add('structuredClone');
  return has;
}

const SHIMMED = shimmedApis();

/** Which shim, if any, covers a RUNTIME entry. Named by the entry's own label. */
const COVERED_BY = [
  ['Array flat / flatMap', ['flat', 'flatMap']],
  ['Object.fromEntries', ['fromEntries']],
  ['structuredClone', ['structuredClone']],
  ['globalThis (property / `in` access, not the safe `typeof globalThis` guard)', ['globalThis']],
];


/** What `build.target` in vite.config.ts declares. Keep the two in step. */
const FLOOR = 68;

/**
 * Syntax that a transpiler CAN remove, with the first Chrome that understands it.
 *
 * Deliberately conservative patterns: a false positive here costs a minute of
 * someone's attention, and a false negative costs a white screen on a TV nobody
 * in this office owns.
 */
const SYNTAX = [
  /*
   * `?.` NOT followed by a digit.
   *
   * `/[\w)\]]\?\./` also matches a ternary whose first branch is a decimal —
   * `x > 0 ?.5 ** n : 1`, which minifiers produce constantly because dropping
   * the leading zero saves a byte. That is not optional chaining, it is Chrome
   * 1, and it failed the build on three chunks that were entirely clean. A gate
   * that cries wolf is a gate somebody switches off, which is worse than not
   * having one.
   */
  ['optional chaining  ?.', /[\w)\]]\?\.(?![0-9])/, 80],
  ['nullish  ??', /\?\?[^=]/, 80],
  ['logical assignment  ??= ||= &&=', /(\?\?=|\|\|=|&&=)/, 85],
  /*
   * A private field is `#name =` or `#name;` after a `{`, `;` or space.
   *
   * The looser version — any `#name` followed by `=`, `;` or `(` — matched
   * `/^#EXT(?:INF|-X-TARGETDURATION):/` inside hls.js, an M3U8 parser whose
   * whole job is matching strings that begin with a hash. One regex literal,
   * reported as a syntax feature the bundle does not contain and cannot be
   * built without. Requiring the `(` case to go was enough: a private METHOD
   * call reads `this.#m(`, and `this.` is covered by the `\s`-or-`{`-or-`;`
   * lead-in about as well as a regex can manage without becoming a tokeniser.
   */
  ['private class field  #x', /[{;\s]#[A-Za-z_$][\w$]*\s*[=;]/, 74],
  ['static initialisation block', /static\s*\{/, 94],
  /*
   * Class fields, and ONLY in a minified chunk.
   *
   * The pattern is "an indented `name = value`", which in a built bundle is a
   * class field and in hand-written source is every reassignment there is:
   * `s = Math.max(...)` inside a loop, `res = await fetch(...)` inside a try.
   * It requires two spaces of indentation, so it could never fire on the
   * minified chunks it was written for and fired only on the copied files where
   * it is always wrong. Scoped to minified output, where the indentation means
   * what the pattern assumes.
   */
  ['class fields', /^\s{2,}[A-Za-z_$][\w$]*\s*=\s*[^=>]/m, 72, 'minified'],
];

/**
 * Library calls no build target can rewrite.
 *
 * The fourth column is what an engine that lacks it actually DOES, and the
 * difference decides whether anyone needs to care:
 *
 *   'crash'    — the call throws `TypeError: x.y is not a function` and takes the
 *                render with it. A blank screen with no console, on a device
 *                nobody here owns. These are worth removing.
 *   'degrades' — the engine ignores it and carries on. `new Error(m, { cause })`
 *                is the case: a constructor given an argument it does not know
 *                simply drops it, so `err.cause` is undefined and nothing else
 *                changes. Reporting these as problems forever is how a check
 *                stops being read.
 */
const RUNTIME = [
  ['Array.prototype.at', /\.at\(\s*-?\d/, 92, 'crash'],
  ['Object.hasOwn', /Object\.hasOwn\(/, 93, 'crash'],
  ['Array findLast', /\.findLast(Index)?\(/, 97, 'crash'],
  ['structuredClone', /structuredClone\(/, 98, 'crash'],
  ['Array toSorted / with', /\.(toSorted|toReversed|toSpliced)\(/, 110, 'crash'],
  ['Object.groupBy', /Object\.groupBy\(/, 117, 'crash'],
  ['Error cause option', /\{\s*cause:\s*[\w$]/, 93, 'degrades'],
  /*
   * The four entries below were added moving FLOOR 70 → 68 (2026-09-17). They
   * were not needed before because nothing above ever asked the gate to look
   * this low, not because the calls are new — the codebase was already making
   * two of them (`globalThis`, `Object.fromEntries`) above the OLD floor of
   * 70 too, unflagged the whole time. Found by grepping the built chunks by
   * hand while measuring the candidate floors; none of these can be fixed by
   * `build.target`, they need a polyfill or a rewrite at the call site.
   */
  ['Array flat / flatMap', /\.(flat|flatMap)\(/, 69, 'crash'],
  ['Object.fromEntries', /Object\.fromEntries\(/, 73, 'crash'],
  ['String trimStart / trimEnd', /\.(trimStart|trimEnd)\(/, 66, 'crash'],
  /*
   * `globalThis` is not like the others above: the identifier itself is what
   * throws (`ReferenceError: globalThis is not defined`) on an engine before
   * Chrome 71, so unlike `structuredClone` a FEATURE-DETECTED usage can still
   * crash — `typeof globalThis.foo` resolves the `globalThis` reference (and
   * throws) before `typeof` ever gets a say; only a bare `typeof globalThis`
   * with nothing chained after it is safe, and this codebase's own bundle
   * has both forms. So this checks for the UNSAFE shapes specifically
   * (`globalThis.x`, `globalThis[x]`, `x in globalThis`) rather than for the
   * identifier's mere presence, which would flag the already-safe guard too.
   */
  ['globalThis (property / `in` access, not the safe `typeof globalThis` guard)', /globalThis\s*[.[]|\bin\s+globalThis\b/, 71, 'crash'],
];

const dirs = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [join(ROOT, 'apps/web/dist/assets'), join(ROOT, 'apps/web/dist-app/assets')];

/** Every `.js` under `dir`, relative to it, at any depth. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, `${prefix}${entry}/`));
    else if (entry.endsWith('.js')) out.push(`${prefix}${entry}`);
  }
  return out;
}

let failed = false;

for (const dir of dirs) {
  if (!existsSync(dir)) {
    console.log(`(skipped: ${dir.replace(ROOT, '.')} — not built)`);
    continue;
  }
  /*
   * EVERY .js under the directory, not the top level of it.
   *
   * This read `readdirSync(dir)` and filtered for `.js`, which in a Vite output
   * is `sw.js` and a worklet — two files that are copied in rather than built,
   * and the only two the gate has ever looked at. The application itself is
   * forty-five chunks in `assets/`, one directory down, and every one of them
   * went unchecked for the whole life of the check. A gate that exists to stop a
   * white screen on a television nobody in this office owns, reporting green on
   * the two files that are not the application.
   */
  const files = walk(dir);
  /*
   * Matched against CODE, not against the comments above it.
   *
   * A built chunk carries no comments, so this never mattered until the check
   * started reading files that are copied rather than compiled — and then it
   * failed the build on a comment in `sw.js` explaining why that file avoids
   * `??`. A gate that fails on its own documentation teaches people to ignore
   * it. Strings can still produce a false positive and that is left alone: one
   * is a minute of attention, and stripping them properly means writing a
   * tokeniser.
   */
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const sources = files.map((f) => [f, strip(readFileSync(join(dir, f), 'utf8'))]);
  /* A chunk with no long unbroken lines is hand-written and copied in, not
     built — the indentation-based rules below cannot mean anything there. */
  const minified = new Map(sources.map(([f, src]) => [f, /[^\n]{400,}/.test(src)]));

  console.log(`\n${dir.replace(ROOT, '.')}  (${files.length} chunks, floor: Chrome ${FLOOR})`);

  let worst = 0;
  const over = [];
  for (const [name, re, ver, scope] of SYNTAX) {
    const hits = sources
      .filter(([f, src]) => (scope === 'minified' ? minified.get(f) === true : true) && re.test(src))
      .map(([f]) => f);
    if (hits.length === 0) continue;
    worst = Math.max(worst, ver);
    if (ver > FLOOR) over.push([name, ver, hits]);
  }
  console.log(`  syntax floor: Chrome ${worst || FLOOR}`);
  for (const [name, ver, hits] of over) {
    console.log(`  FAIL  ${name} needs Chrome ${ver}  — ${hits.join(', ')}`);
    failed = true;
  }

  for (const [name, re, ver, effect] of RUNTIME) {
    const hits = sources.filter(([, src]) => re.test(src)).map(([f]) => f);
    if (hits.length === 0) continue;
    if (ver <= FLOOR) { console.log(`  ok    ${name} (Chrome ${ver})`); continue; }
    if (effect === 'degrades') {
      console.log(`  note  ${name} (Chrome ${ver}) — ignored by older engines, not a crash`);
      continue;
    }
    const covers = COVERED_BY.find(([label]) => label === name);
    if (covers !== undefined && covers[1].every((k) => SHIMMED.has(k))) {
      console.log(`  shim  ${name} (Chrome ${ver}) — index.html puts it back before any chunk runs`);
      continue;
    }
    /* Every crash-level runtime API is either shimmed above or removed: a new
       one is a failure, not a note to read later. */
    console.log(`  FAIL  ${name} (Chrome ${ver}) CRASHES below that — ${hits.join(', ')}`);
    failed = true;
  }
}

console.log(
  failed
    ? '\nBUNDLE FLOOR FAILED — a chunk needs more than the floor engine has'
    : `\nBUNDLE FLOOR OK — syntax and runtime APIs both stay at or below Chrome ${FLOOR}`,
);
process.exit(failed ? 1 : 0);
