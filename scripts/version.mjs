/**
 * One version, applied everywhere.
 *
 * Asked for as "proper build versions, and make it dynamic so whenever a new APK
 * is built... like Flutter, but we are using Capacitor". Flutter's `1.4.0+8` is
 * two numbers doing two jobs and this keeps both:
 *
 *   version   what a person reads and what the minimum-version gate compares — `1.5.0`
 *   build     what Android compares, and it must only ever go UP — `9`
 *
 * `version.json` is the source. Nothing else in the repo may hold a version by
 * hand: this script writes them, and `--check` fails if any of them has drifted,
 * which is what makes "the APK says 1.4.0 and the website says 1.5.0" impossible
 * rather than merely unlikely.
 *
 * ── where it lands ──
 *
 *   apps/mobile/android/app/build.gradle   versionName + versionCode
 *   the web build                          VITE_APP_VERSION, via vite.config.ts
 *
 * ── usage ──
 *
 *   node scripts/version.mjs                 print the current version
 *   node scripts/version.mjs --check         exit 1 if anything has drifted
 *   node scripts/version.mjs bump build      1.5.0+9  -> 1.5.0+10
 *   node scripts/version.mjs bump patch      1.5.0+9  -> 1.5.1+10
 *   node scripts/version.mjs bump minor      1.5.0+9  -> 1.6.0+10
 *   node scripts/version.mjs bump major      1.5.0+9  -> 2.0.0+10
 *   node scripts/version.mjs set 2.1.3       an explicit version, build +1
 *
 * Every bump raises the build number, including `set`. A release with a new name
 * and the old code is one Android will refuse to install over the old one, and the
 * error it gives says nothing useful.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './brand-kit.mjs';

const FILE = join(ROOT, 'version.json');
const GRADLE = join(ROOT, 'apps/mobile/android/app/build.gradle');

export function readVersion() {
  const raw = JSON.parse(readFileSync(FILE, 'utf8'));
  const version = String(raw.version ?? '');
  const build = Number(raw.build ?? 0);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version.json: "version" must be MAJOR.MINOR.PATCH, got ${JSON.stringify(version)}`);
  }
  if (!Number.isInteger(build) || build < 1) {
    throw new Error(`version.json: "build" must be a positive integer, got ${JSON.stringify(raw.build)}`);
  }
  return { version, build };
}

function writeVersion(v) {
  writeFileSync(FILE, `${JSON.stringify(v, null, 2)}\n`);
}

/**
 * What the SERVED web bundle claims.
 *
 * The version is stamped into the bundle at build time, so bumping `version.json`
 * and rebuilding only the APK leaves the website carrying the old number — which
 * is exactly what happened: the site compared itself against the freshly
 * published release and told every visitor they were out of date. A version that
 * exists in three places has to be checkable in three places.
 *
 * Reads `build.json`, which `scripts/stamp-build.mjs` writes beside the bundle —
 * the version is substituted into the JavaScript at build time and is
 * indistinguishable from any other string afterwards (the first attempt at this
 * found React's version). Returns null when there is no build to check.
 */
function webVersion() {
  try {
    const raw = readFileSync(join(ROOT, 'apps/web/dist/build.json'), 'utf8');
    const v = JSON.parse(raw).version;
    return typeof v === 'string' ? v : null;
  } catch {
    /* Never built, or built before `scripts/stamp-build.mjs` existed. Not drift:
       a checkout with no build is not claiming anything. */
    return null;
  }
}

/** What the Android project currently claims. */
function gradleVersion() {
  const g = readFileSync(GRADLE, 'utf8');
  return {
    version: /versionName\s+"([^"]+)"/.exec(g)?.[1] ?? null,
    build: Number(/versionCode\s+(\d+)/.exec(g)?.[1] ?? 0),
  };
}

function applyGradle({ version, build }) {
  const before = readFileSync(GRADLE, 'utf8');
  const after = before
    .replace(/versionCode\s+\d+/, `versionCode ${build}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
  if (after !== before) writeFileSync(GRADLE, after);
  return after !== before;
}

function bump(kind, cur) {
  const [maj, min, pat] = cur.version.split('.').map(Number);
  const next =
    kind === 'major' ? `${maj + 1}.0.0`
      : kind === 'minor' ? `${maj}.${min + 1}.0`
        : kind === 'patch' ? `${maj}.${min}.${pat + 1}`
          : cur.version;
  return { version: next, build: cur.build + 1 };
}

/* Importable AND runnable: other scripts read `readVersion()` from here, and
   a module that runs its CLI on import would print a version report in the middle
   of somebody else's output. */
const isCli = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

const [cmd, arg] = process.argv.slice(2);
const current = isCli ? readVersion() : { version: '', build: 0 };

if (!isCli) {
  /* imported — nothing to do */
} else if (cmd === undefined) {
  const g = gradleVersion();
  const w = webVersion();
  console.log(`${current.version}+${current.build}`);
  console.log(`android: ${g.version}+${g.build}${
    g.version === current.version && g.build === current.build ? '' : '   (DRIFTED — run: pnpm version:apply)'}`);
  console.log(`web:     ${w ?? 'not built'}${
    w === null || w === current.version ? '' : '        (DRIFTED — run: pnpm build)'}`);
} else if (cmd === '--check') {
  const g = gradleVersion();
  const w = webVersion();
  const androidOk = g.version === current.version && g.build === current.build;
  /* No build is not drift — a checkout that has never been built is not lying
     about anything. A build that carries a different version is. */
  const webOk = w === null || w === current.version;
  if (!androidOk) {
    console.log(`VERSION DRIFT: version.json says ${current.version}+${current.build}, `
      + `android says ${g.version}+${g.build} — run: pnpm version:apply`);
  }
  if (!webOk) {
    console.log(`VERSION DRIFT: version.json says ${current.version}, `
      + `the served web bundle says ${w} — run: pnpm build`);
  }
  if (androidOk && webOk) {
    console.log(`version ok: ${current.version}+${current.build}`
      + `${w === null ? ' (no web build)' : ` · web ${w}`}`);
  }
  process.exit(androidOk && webOk ? 0 : 1);
} else if (cmd === 'apply') {
  const changed = applyGradle(current);
  console.log(`${changed ? 'applied' : 'already current'}: ${current.version}+${current.build}`);
} else if (cmd === 'bump') {
  const kind = ['major', 'minor', 'patch', 'build'].includes(arg) ? arg : 'build';
  const next = bump(kind, current);
  writeVersion(next);
  applyGradle(next);
  console.log(`${current.version}+${current.build} -> ${next.version}+${next.build}`);
} else if (cmd === 'set') {
  if (!/^\d+\.\d+\.\d+$/.test(arg ?? '')) {
    console.error('usage: version.mjs set MAJOR.MINOR.PATCH');
    process.exit(2);
  }
  const next = { version: arg, build: current.build + 1 };
  writeVersion(next);
  applyGradle(next);
  console.log(`${current.version}+${current.build} -> ${next.version}+${next.build}`);
} else {
  console.error('usage: version.mjs [--check|apply|bump major|minor|patch|build|set X.Y.Z]');
  process.exit(2);
}
