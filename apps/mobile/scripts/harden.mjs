/**
 * Make the APK's own JavaScript expensive to read.
 *
 * The honest framing first, because the alternative is a false sense of safety:
 * a WebView executes JavaScript, so the JavaScript must be present in a form it
 * can run, so it can always be recovered. There is no "compile to a binary nobody
 * can reverse" for a web app — WebAssembly is decompilable too, and a React app
 * does not compile to it in any case. What this does is raise the cost from
 * "unzip the APK and read the source" to "spend days against control-flow
 * flattening and encoded strings for logic a subscriber's own M3U already
 * reveals." A deterrent, not a wall. It is deliberately the LAST build step and
 * it runs for the Capacitor bundle ONLY — the website stays readable so it can be
 * debugged, and crash maps keep working there.
 *
 * ── what is hardened, and what is skipped ──
 *
 * Only this app's own chunks. The three vendor chunks — `vendor` (React, the
 * router, react-query), `hls`, `mpegts` — are public open-source: obfuscating
 * them protects nothing, and it is exactly where control-flow flattening costs
 * the most build time and the most startup latency. Skipping them is why this
 * adds well under a second to a cold start rather than several.
 *
 * ── two passes, because one of them is expensive ──
 *
 * The transform that makes code hardest to read — control-flow flattening — is
 * also the one that makes it slowest to run, and the cost is not small. Measured
 * on this bundle at 6x CPU throttle, which is roughly what a cheap Android TV box
 * is next to a laptop:
 *
 *     variant                     cold boot   boot script
 *     no hardening                  1288ms         683ms
 *     encoded strings only          1643ms         994ms
 *     + control flow + defending    2681ms        1921ms
 *
 * A full second of every launch, plus everything running about twice as slow
 * afterwards, spent flattening the router and the poster grid — where there is
 * nothing to hide. So the pass is aimed instead of sprayed. The `providers`
 * chunk holds the source clients — how the app talks to a viewer's own Xtream,
 * Stalker or M3U source — and it gets the expensive treatment; it is ~20KB and
 * runs once at startup, so flattening it costs milliseconds. Every other app
 * chunk gets the encoded string table, which is what actually defeats `grep`,
 * and none of the per-frame cost.
 *
 * ── the settings, and why not the maximal ones ──
 *
 * The app must keep working — this is the same build that carries the playback
 * fixes — so the transforms that routinely BREAK a library-heavy bundle are off:
 * `renameGlobals` (chunks share names across files) and `renameProperties` (turns
 * `hls.loadSource` into a property that no longer exists). What is on is the set
 * that resists reading without changing behaviour: every string literal (URLs,
 * messages, keys) goes into an encoded, shuffled table; identifiers are mangled;
 * control flow is flattened enough to defeat a skim; and the result defends
 * itself against being pretty-printed. Tuned, not maxed: `deadCodeInjection`
 * tripled the bundle for little extra cost to a reader, and the debugger-trap
 * loop burned battery, so both are off.
 *
 * Run by `apps/mobile` `build:web`, after Vite and the build stamp. If it is ever
 * skipped, the APK still works — it is a hardening pass over working code, not a
 * step the code needs to run.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

const dir = process.argv[2] ?? join(process.cwd(), '../../apps/web/dist-app');
const assets = join(dir, 'assets');

/* The public chunks, by the names `vite.config.ts` gives them in `manualChunks`.
   A content hash follows the name, so match the prefix. */
const SKIP = ['vendor-', 'hls-', 'mpegts-'];

/**
 * Strong on reading-resistance, conservative on breakage.
 *
 * The two dangerous transforms (`renameGlobals`, `renameProperties`) stay off on
 * purpose; see the header. Everything here is behaviour-preserving for a bundle
 * that has already been minified and tree-shaken.
 */
const OPTIONS = {
  compact: true,
  // Off: it multiplies bundle size for a reader-facing gain that string
  // encoding already delivers.
  deadCodeInjection: false,
  debugProtection: false,
  // Every literal — URLs, hostnames, error text — leaves the source and enters
  // an encoded, shuffled, rotated table. This is what stops a `grep` cold.
  stringArray: true,
  stringArrayEncoding: ['base64'],
  // 1.0, not 0.9: at 0.9 roughly one string in ten stays inline, chosen at
  // random. Every string through the array.
  stringArrayThreshold: 1,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  // Splitting keeps literals out of a `grep`; the string array already does
  // that. Off, because chunked concatenation is one more thing to break for a
  // gain the encoded table already delivers.
  splitStrings: false,
  // Small, non-reversible identifiers. `renameGlobals` off, so this only touches
  // locals — safe across the chunk boundaries Vite created.
  identifierNamesGenerator: 'mangled-shuffled',
  renameGlobals: false,
  renameProperties: false,
  // `transformObjectKeys` and `numbersToExpressions` are OFF after they broke
  // the boot: the first rewrote an object the app probes with `'key' in obj`
  // into something the operator rejects. `simplify` stays; it is behaviour-safe.
  numbersToExpressions: false,
  simplify: true,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  // The bundle targets old WebViews (chrome87); do not let the obfuscator emit
  // syntax newer than the code it is given.
  target: 'browser',
};

/**
 * The chunk that holds the source clients, and the only one worth flattening.
 *
 * Named by `vite.config.ts` `manualChunks`, with a content hash after it.
 */
const DEEP_CHUNK = 'providers-';

/**
 * Everything above, plus the two transforms that cost frames.
 *
 * `controlFlowFlattening` rewrites straight-line code into a dispatch loop, which
 * is what stops a reader following it — and what makes it run several times
 * slower. `selfDefending` breaks a pretty-printed copy. Both are worth it on
 * 20KB read once at startup; neither is worth it on the app shell.
 */
const DEEP = {
  ...OPTIONS,
  controlFlowFlattening: true,
  // Not 1.0: flattening everything in a chunk this small still measures, and the
  // reader is stopped by 0.6 just as thoroughly.
  controlFlowFlatteningThreshold: 0.6,
  selfDefending: true,
};

if (!safeDir(assets)) {
  console.error(`harden: no assets directory at ${assets}`);
  process.exit(1);
}

let done = 0;
let deepDone = 0;
let skipped = 0;
let before = 0;
let after = 0;

for (const name of readdirSync(assets)) {
  if (!name.endsWith('.js')) continue;
  const file = join(assets, name);
  if (SKIP.some((p) => basename(name).startsWith(p))) {
    skipped += 1;
    continue;
  }
  const src = readFileSync(file, 'utf8');
  before += src.length;
  const deep = basename(name).startsWith(DEEP_CHUNK);
  const out = JavaScriptObfuscator.obfuscate(src, deep ? DEEP : OPTIONS).getObfuscatedCode();
  writeFileSync(file, out);
  after += out.length;
  done += 1;
  if (deep) deepDone += 1;
}

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
console.log(
  `harden: obfuscated ${done} app chunk(s) (${kb(before)} → ${kb(after)}), `
  + `${deepDone} with control-flow flattening, skipped ${skipped} vendor chunk(s)`,
);
if (deepDone === 0) {
  /* The aimed pass hit nothing — `manualChunks` was renamed or dropped, and the
     one chunk that was supposed to be hard to read is now merely encoded. That
     is a silent downgrade of the thing this script exists for, so it fails. */
  console.error(`harden: FAIL — no ${DEEP_CHUNK}* chunk to flatten. Has vite.config.ts`
    + ' stopped splitting src/lib/providers into its own chunk?');
  process.exit(1);
}
if (done === 0) {
  console.error('harden: obfuscated nothing — is this the Capacitor build?');
  process.exit(1);
}

function safeDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
