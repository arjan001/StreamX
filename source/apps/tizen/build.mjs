#!/usr/bin/env node
/**
 * Build the staging directory that goes INTO a Samsung TV `.wgt` — the web
 * bundle plus `config.xml` and the icon, nothing else.
 *
 * This is deliberately a separate script from `apps/mobile`'s `build:web`, not
 * a copy of it with a flag. The two builds share most of their shape (both are
 * a packaged, file-local Vite build of the same `@iptv/web` app) but differ in
 * one load-bearing way: `apps/mobile` sets `VITE_PLATFORM=capacitor`, which
 * gates the Android native bridge, the libVLC player and the Capacitor
 * storage layer — none of which exist on a Tizen TV. Every read site checks
 * `=== 'capacitor'` (confirmed with `grep -rn VITE_PLATFORM apps/web/src`
 * before writing this), so leaving the variable UNSET is what makes those
 * code paths fall through to their plain-web behavior — fetch instead of the
 * native bridge, `<video>` instead of libVLC, `localStorage`/IndexedDB instead
 * of `@capacitor/preferences`. Introducing a `VITE_PLATFORM=tizen` value was
 * considered and rejected: every one of those call sites would need a second
 * branch to also treat `tizen` as "not capacitor", and every one of those
 * files lives in `apps/web/src/lib/`, outside what this directory owns (and
 * one of them, `remoteKeys.ts`, is mid-edit in a concurrent session right
 * now). Leaving it unset gets the correct behavior today with zero edits
 * outside `apps/tizen/`; introducing a Tizen-specific flag is future work for
 * whoever adds Tizen-specific behavior (AVPlay is the known candidate — see
 * README.md) and can edit `apps/web/src/lib/` at that point.
 *
 * Everything else mirrors `apps/mobile/package.json`'s `build:web`
 * (`VITE_BASE=./`, `VITE_ROUTER=hash`, `VITE_DATA=local`, an absolute API
 * origin — see the comment at `apiOrigin` in `apps/web/vite.config.ts`
 * for why a packaged shell cannot use a relative origin) for the same reasons
 * that script has them: this bundle is loaded from a local package root, not
 * a server path, so it needs its own router, its own base, its own catalogue,
 * and it needs absolute origins because there is no meaningful "relative" one.
 *
 * What is skipped from that script, and why:
 *   - `apps/mobile/scripts/harden.mjs` (the string-obfuscation pass over the
 *     Capacitor bundle) is NOT run here. The package ships no built-in provider
 *     addresses or sources — the viewer adds their own — so there is nothing for
 *     it to hide, and it would roughly double the bundle on a television's slow
 *     JavaScript engine.
 *
 * Usage: node apps/tizen/build.mjs
 * Env:   STREAMIX_API_ORIGIN   (same as apps/mobile)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tizenIds, widgetVersion } from './manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WEB = join(ROOT, 'apps/web');

/**
 * Where a television talks to.
 *
 * Preference order: an explicit `STREAMIX_API_ORIGIN`, then the public site
 * origin from `.env`. With neither set the build has no API origin, and
 * `config.xml` falls back to a wildcard `<access>`.
 *
 * Samsung reviews what a package is allowed to reach, so a store build should
 * name an https origin. The origin never enters the repository — it is read
 * from `.env` at build time and appears only inside the built package, which is
 * not checked in.
 */
function siteOrigin() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^PUBLIC_SITE_ORIGIN=(.*)$/.exec(line.trim());
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, '').trim().replace(/\/+$/, '');
        if (v !== '') return v;
      }
    }
  } catch { /* no .env on this machine */ }
  return '';
}

const DEFAULT_ORIGIN = siteOrigin();
const apiOrigin = (process.env.STREAMIX_API_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, '');

const OUT_NAME = 'dist-tizen';
const webOut = join(WEB, OUT_NAME);
const staging = join(HERE, 'staging');

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function main() {
  console.log(`tizen build: API origin = ${apiOrigin}`);

  /* 1. Vite build of the shared web app, in the combination a packaged local
     widget needs — same reasoning as apps/mobile's build:web, VITE_PLATFORM
     just not set to 'capacitor'; see the file header. */
  /* VITE_PLATFORM is deliberately absent from this env, not set to '' — see
     the file header. `delete` guards against it leaking in from the calling
     shell (e.g. a stray export left over from an apps/mobile build in the
     same terminal), since an inherited 'capacitor' here would silently gate
     the wrong code paths back on. */
  const buildEnv = {
    ...process.env,
    VITE_BASE: './',
    VITE_ROUTER: 'hash',
    VITE_DATA: 'local',
    /* "This page is loaded from a package root, and its API is elsewhere" — the
       one thing `VITE_PLATFORM=capacitor` would also have said, without the
       Android machinery it drags in. Without it the presence socket points at
       the package origin and every handshake fails. See `lib/api.ts`. */
    VITE_PACKAGED: '1',
    VITE_OUT: OUT_NAME,
    VITE_API_ORIGIN: apiOrigin,
  };
  delete buildEnv.VITE_PLATFORM;
  run('pnpm', ['--filter', '@iptv/web', 'build'], { env: buildEnv });

  if (!existsSync(join(webOut, 'index.html'))) {
    console.error(`tizen build: FAIL — ${webOut}/index.html missing after vite build`);
    process.exit(1);
  }

  /* 2. The two post-build passes that matter on a widget the same way they
     matter on the APK: the version stamp (so "which build is this" is
     answerable from the shipped files, not just from whoever remembers
     building it), and the @layer-flattening CSS pass — without it this is
     the SAME unstyled-buttons failure `scripts/css-compat.mjs`'s own header
     describes for old Android WebViews, and a 2020 Tizen TV's Chromium 69 is
     in exactly the same pre-@layer position (Chrome added @layer in M99). */
  run('node', [join(ROOT, 'scripts/stamp-build.mjs'), webOut]);
  run('node', [join(ROOT, 'scripts/css-compat.mjs'), webOut]);
  /* The compatibility gate: syntax above the Chromium 68 floor fails the build; a
     runtime API above it is reported. See scripts/bundle-floor.mjs. */
  run('node', [join(ROOT, 'scripts/bundle-floor.mjs'), join(webOut, 'assets')]);

  /* 3. Assemble the staging directory: the built bundle, plus config.xml with
     its access-origin placeholder resolved, plus the icon. This directory's
     contents are exactly what `tizen build-web` / `tizen package -t wgt`
     zips into the .wgt — nothing more, nothing less, which is why it is
     rebuilt from scratch on every run rather than merged into. */
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  /* Source maps never go into a store package. */
  cpSync(webOut, staging, { recursive: true, filter: (src) => !src.endsWith('.map') });

  const configTemplate = readFileSync(join(HERE, 'config.xml'), 'utf8');
  const accessOrigin = apiOrigin || '*';
  const ids = tizenIds(JSON.parse(readFileSync(join(ROOT, 'brand.config.json'), 'utf8')).name);
  const ver = JSON.parse(readFileSync(join(ROOT, 'version.json'), 'utf8'));
  const config = configTemplate
    .replaceAll('__STREAMIX_API_ORIGIN__', accessOrigin)
    .replaceAll('__STREAMIX_VERSION__', widgetVersion(ver.version))
    .replaceAll('__TIZEN_APP_ID__', ids.appId)
    .replaceAll('__TIZEN_PACKAGE__', ids.pkg);
  if (/__[A-Z_]+__/.test(config)) {
    console.error('tizen build: FAIL — placeholder substitution left a token behind');
    process.exit(1);
  }
  writeFileSync(join(staging, 'config.xml'), config);
  cpSync(join(HERE, 'icon.png'), join(staging, 'icon.png'));

  const size = dirSize(staging);
  console.log(`tizen build: staged ${staging.replace(ROOT, '.')} — ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log('tizen build: next step is apps/tizen/package.mjs to produce the .wgt');
}

function dirSize(dir) {
  let total = 0;
  for (const name of readDirRecursive(dir)) total += statSync(name).size;
  return total;
}

function readDirRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readDirRecursive(full));
    else out.push(full);
  }
  return out;
}

main();
